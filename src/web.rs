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
use std::time::Duration;
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
    preset: u8,
    bpm: f32,
    // four quantum signals so the UI can deform the water surface
    q0: f32, q1: f32, q2: f32, q3: f32,
    chaos: f32,
}

async fn socket_loop(socket: WebSocket, app: AppState) {
    let (mut tx, mut rx) = socket.split();
    let s = app.shared.clone();
    let eng = app.engine.clone();

    // simple side-channel: store the latest 4 quantum signals in a small atomic-y way.
    // We don't expose qmod directly here, so we re-derive from a phase that follows
    // input/output levels (cheap & expressive enough for water deformation).
    let s_meter = s.clone();
    let meter_task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        let mut phase: f32 = 0.0;
        loop {
            ticker.tick().await;
            phase = (phase + 0.07).rem_euclid(std::f32::consts::TAU);
            let chaos = s_meter.quantum_amount.get();
            // four pseudo-quantum control signals — cheap sin/cos network.
            // The audio thread has its own QuantumMod; this is just for visuals.
            let q0 = (phase * 0.7).sin();
            let q1 = (phase * 1.3 + 1.2).sin();
            let q2 = (phase * 0.9 + 2.4).sin();
            let q3 = (phase * 1.7 + 3.1).sin();
            let msg = OutMsg {
                kind: "tick",
                in_level: s_meter.input_level.get(),
                out_level: s_meter.output_level.get(),
                drum_step: s_meter.current_step.load(Ordering::Relaxed),
                recording: s_meter.recording.load(Ordering::Relaxed),
                drum_on: s_meter.drum_enabled.load(Ordering::Relaxed),
                preset: s_meter.drum_preset.load(Ordering::Relaxed),
                bpm: s_meter.drum_bpm.get(),
                q0, q1, q2, q3, chaos,
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
            // map x,y,z (~[-1,1]) to musically useful ranges.
            // x: pan-ish but here drives experiment frequency along a log scale (40..2000 Hz)
            // y: drives experiment amplitude (0..0.5)
            // z: drives quantum chaos (0..1)
            let nx = (x.clamp(-1.0, 1.0) + 1.0) * 0.5;            // 0..1
            let ny = (y.clamp(-1.0, 1.0) + 1.0) * 0.5;            // 0..1
            let nz = (z.clamp(-1.0, 1.0) + 1.0) * 0.5;            // 0..1
            let lmin = 40.0_f32.ln();
            let lmax = 2000.0_f32.ln();
            let freq = (lmin + nx * (lmax - lmin)).exp();
            s.exp_freq.set(freq);
            s.exp_amp.set(ny * 0.5);
            s.quantum_amount.set(nz.clamp(0.0, 1.0));
        }
    }
}
