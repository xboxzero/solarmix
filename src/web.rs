//! Axum web server: serves static UI and a WebSocket for control + level meters.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower_http::services::ServeDir;

use crate::audio::engine::EngineHandle;
use crate::state::SharedState;

#[derive(Clone)]
pub struct AppState {
    pub shared: Arc<SharedState>,
    pub engine: EngineHandle,
}

pub async fn run(engine: EngineHandle, static_dir: PathBuf, addr: SocketAddr) -> anyhow::Result<()> {
    let app_state = AppState { shared: engine.state.clone(), engine };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(app_state);

    tracing::info!("web ui: http://{}/", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(s): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| socket_loop(socket, s))
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
enum InMsg {
    #[serde(rename = "set")] Set { id: String, value: f32 },
    #[serde(rename = "toggle")] Toggle { id: String },
    #[serde(rename = "drum")] Drum { voice: u8, step: u8 },
    #[serde(rename = "preset")] Preset { value: u8 },
    #[serde(rename = "record")] Record { on: bool },
    #[serde(rename = "wave")] Wave { value: u8 },
    /// Touch on the 3D orb. x,y,z are roughly in [-1,1].
    #[serde(rename = "orb")] Orb { x: f32, y: f32, z: f32 },
}

#[derive(Serialize)]
struct OutMsg {
    #[serde(rename = "type")] kind: &'static str,
    in_level: f32,
    out_level: f32,
    drum_step: u8,
    recording: bool,
    drum_on: bool,
    mic_on: bool,
    preset: u8,
    bpm: f32,
    // four quantum signals so the UI can deform the water surface
    q0: f32, q1: f32, q2: f32, q3: f32,
    chaos: f32,
    reverb: f32,
    delay_fb: f32,
}

async fn socket_loop(socket: WebSocket, app: AppState) {
    let (mut tx, mut rx) = socket.split();
    let s = app.shared.clone();
    let eng = app.engine.clone();

    // simple side-channel: store the latest 4 quantum signals in a small atomic-y way.
    // We don't expose qmod directly here, so we re-derive from a phase that follows
    // input/output levels (cheap & expressive enough for water deformation).
    let s_meter = s.clone();
    let eng_vox = eng.clone();
    let meter_task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        let mut phase: f32 = 0.0;
        // VOX state
        let mut vox_above_since: Option<Instant> = None;
        let mut vox_last_active: Option<Instant> = None;
        let mut vox_recording = false;
        // user can also start recording manually via the REC button; only the VOX
        // path uses this flag to know it should auto-stop on silence.
        loop {
            ticker.tick().await;
            phase = (phase + 0.07).rem_euclid(std::f32::consts::TAU);
            let chaos = s_meter.quantum_amount.get();
            let q0 = (phase * 0.7).sin();
            let q1 = (phase * 1.3 + 1.2).sin();
            let q2 = (phase * 0.9 + 2.4).sin();
            let q3 = (phase * 1.7 + 3.1).sin();

            // -------- VOX auto-record state machine --------
            let mic_on = s_meter.mic_enabled.load(Ordering::Relaxed);
            let lvl = s_meter.input_level.get();
            let now = Instant::now();
            const VOX_THRESHOLD: f32 = 0.012; // RMS
            const VOX_START_AFTER: Duration = Duration::from_millis(250);
            const VOX_STOP_AFTER:  Duration = Duration::from_millis(2200);
            if mic_on {
                if lvl > VOX_THRESHOLD {
                    vox_last_active = Some(now);
                    vox_above_since.get_or_insert(now);
                    if !vox_recording {
                        if let Some(t0) = vox_above_since {
                            if now.duration_since(t0) >= VOX_START_AFTER {
                                eng_vox.start_recording();
                                vox_recording = true;
                            }
                        }
                    }
                } else {
                    vox_above_since = None;
                    if vox_recording {
                        let silent_for = vox_last_active
                            .map(|t| now.duration_since(t))
                            .unwrap_or(Duration::ZERO);
                        if silent_for >= VOX_STOP_AFTER {
                            eng_vox.stop_recording();
                            vox_recording = false;
                        }
                    }
                }
            } else {
                // mic closed — abandon VOX, stop only if we started it
                vox_above_since = None;
                vox_last_active = None;
                if vox_recording {
                    eng_vox.stop_recording();
                    vox_recording = false;
                }
            }

            let msg = OutMsg {
                kind: "tick",
                in_level: s_meter.input_level.get(),
                out_level: s_meter.output_level.get(),
                drum_step: s_meter.current_step.load(Ordering::Relaxed),
                recording: s_meter.recording.load(Ordering::Relaxed),
                drum_on: s_meter.drum_enabled.load(Ordering::Relaxed),
                mic_on,
                preset: s_meter.drum_preset.load(Ordering::Relaxed),
                bpm: s_meter.drum_bpm.get(),
                q0, q1, q2, q3, chaos,
                reverb: s_meter.reverb_mix.get(),
                delay_fb: s_meter.delay_feedback.get(),
            };
            let txt = serde_json::to_string(&msg).unwrap_or_default();
            if tx.send(Message::Text(txt)).await.is_err() { break; }
        }
    });

    while let Some(Ok(msg)) = rx.next().await {
        if let Message::Text(t) = msg {
            if let Ok(parsed) = serde_json::from_str::<InMsg>(&t) {
                handle_msg(&s, &eng, parsed);
            }
        }
    }
    meter_task.abort();
}

fn handle_msg(s: &Arc<SharedState>, eng: &EngineHandle, msg: InMsg) {
    match msg {
        InMsg::Set { id, value } => match id.as_str() {
            "master" => s.master_gain.set(value),
            "input"  => s.input_gain.set(value),
            "auto_target" => s.auto_mix_target.set(value),
            "reverb_mix"  => s.reverb_mix.set(value),
            "reverb_size" => s.reverb_size.set(value),
            "reverb_damp" => s.reverb_damp.set(value),
            "delay_time" => s.delay_time_ms.set(value),
            "delay_fb"   => s.delay_feedback.set(value),
            "delay_mix"  => s.delay_mix.set(value),
            "eq_low"  => s.eq_low_db.set(value),
            "eq_mid"  => s.eq_mid_db.set(value),
            "eq_high" => s.eq_high_db.set(value),
            "exp_freq" => s.exp_freq.set(value),
            "exp_amp"  => s.exp_amp.set(value),
            "q_amount" => s.quantum_amount.set(value),
            "q_smooth" => s.quantum_smooth.set(value),
            "bpm" => s.drum_bpm.set(value),
            "drum_gain" => s.drum_gain.set(value),
            "bass_gain" => s.bass_gain.set(value),
            "swing" => s.drum_swing.set(value),
            "auto_rate" => s.automation_rate.set(value),
            _ => tracing::warn!("unknown set id: {id}"),
        },
        InMsg::Toggle { id } => match id.as_str() {
            "auto_mix"   => { let v = s.auto_mix.load(Ordering::Relaxed); s.auto_mix.store(!v, Ordering::Relaxed); }
            "drum"       => { let v = s.drum_enabled.load(Ordering::Relaxed); s.drum_enabled.store(!v, Ordering::Relaxed); }
            "automation" => { let v = s.automation_enabled.load(Ordering::Relaxed); s.automation_enabled.store(!v, Ordering::Relaxed); }
            "mic"        => { let v = s.mic_enabled.load(Ordering::Relaxed); s.mic_enabled.store(!v, Ordering::Relaxed); }
            _ => {}
        },
        InMsg::Drum { voice, step } => {
            if (voice as usize) < 5 && step < 16 {
                s.toggle_drum_step(voice as usize, step as usize);
            }
        }
        InMsg::Preset { value } => {
            s.apply_preset(value.min(5));
        }
        InMsg::Record { on } => {
            if on { eng.start_recording(); } else { eng.stop_recording(); }
        }
        InMsg::Wave { value } => {
            s.exp_waveform.store(value.min(4), Ordering::Relaxed);
        }
        InMsg::Orb { x, y, z } => {
            // The orb is the "frequencies + chaos mixer". Each axis links to one
            // of the wet effects so you sculpt reverb + tape echo with your hand:
            //   X -> reverb wet/dry      (left = dry, right = wet)
            //   Y -> tape echo feedback  (down = clean, up = smeared)
            //   Z -> quantum chaos       (near = smooth, far = entangled)
            // Plus the orb's radial distance from origin drives the exp tone
            // frequency so you hear an audible frequency sweep as you move it.
            let nx = (x.clamp(-1.0, 1.0) + 1.0) * 0.5;
            let ny = (y.clamp(-1.0, 1.0) + 1.0) * 0.5;
            let nz = (z.clamp(-1.0, 1.0) + 1.0) * 0.5;
            let r = (x * x + y * y).sqrt().min(1.0);

            // reverb
            s.reverb_mix.set((nx * 0.85).clamp(0.0, 0.95));
            s.reverb_size.set((0.35 + ny * 0.55).clamp(0.0, 0.95));

            // tape echo (delay)
            s.delay_feedback.set((ny * 0.85).clamp(0.0, 0.88));
            s.delay_mix.set((0.15 + nx * 0.55).clamp(0.0, 0.8));
            // delay time follows radial distance: tight slap-back at center,
            // long tape-warble at the edges (80..900ms)
            s.delay_time_ms.set(80.0 + r * 820.0);

            // quantum chaos
            s.quantum_amount.set(nz.clamp(0.0, 1.0));

            // audible frequency sweep (log scale, 60..1500 Hz)
            let lmin = 60.0_f32.ln();
            let lmax = 1500.0_f32.ln();
            let freq = (lmin + r * (lmax - lmin)).exp();
            s.exp_freq.set(freq);
            // small constant amp so it's audible but never overpowers a vocal mic
            s.exp_amp.set(0.06);
        }
    }
}
