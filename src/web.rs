//! Axum web server: static UI + WebSocket. The browser sends control messages
//! only — no audio crosses the WS. Meters + qubit-coefficient snapshots go
//! back so the UI can animate.

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

pub async fn run(engine: EngineHandle, static_dir: PathBuf, addr: SocketAddr)
    -> anyhow::Result<()>
{
    let app_state = AppState { shared: engine.state.clone(), engine };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(app_state);
    tracing::info!("tezeta web ui: http://{}/", addr);
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
    /// Set a scalar parameter by id.
    #[serde(rename = "set")]   Set   { id: String, value: f32 },
    /// Toggle a boolean parameter by id.
    #[serde(rename = "toggle")] Toggle { id: String },
    /// Touch on the Lissajous curve. `t` ∈ [0..1] picks the parametric position;
    /// the server projects that to (freq, amp, send-amount) for one voice slot.
    #[serde(rename = "lissajous")] Lissajous {
        voice: u8, t: f32, intensity: f32,
    },
    /// Update one cell of the routing matrix from the patchbay UI.
    #[serde(rename = "route")] Route { voice: u8, bus: u8, value: f32 },
    /// Strike / release a voice.
    #[serde(rename = "voice")] Voice { voice: u8, gate: bool },
    /// Set the qenet mode (1..4).
    #[serde(rename = "mode")]  Mode  { value: u8 },
    /// Begin / end WAV recording on the Pi.
    #[serde(rename = "record")] Record { on: bool },
    /// Microphone enable/disable and gain control.
    #[serde(rename = "mic")] Mic { enabled: bool, gain: f32 },
    /// Microphone modulation target (0=off, 1=chaos, 2=reverb, 3=delay).
    #[serde(rename = "mic_route")] MicRoute { target: u8 },
}

#[derive(Serialize)]
struct OutMsg {
    #[serde(rename = "type")] kind: &'static str,
    in_level: f32,
    out_level: f32,
    recording: bool,
    drum_on: bool,
    mode: u8,
    bpm: f32,
    master: f32,
    chaos: f32,
    // 16 entangled patchbay coefficients (4 voices × 4 buses, row-major).
    qcoef: [f32; 16],
    // Lissajous frequency ratios derived from qubit pairs — UI uses them to
    // deform the visible curve.
    liss_a: f32,
    liss_b: f32,
    liss_c: f32,
}

async fn socket_loop(socket: WebSocket, app: AppState) {
    let (mut tx, mut rx) = socket.split();
    let s = app.shared.clone();
    let eng = app.engine.clone();

    let s_meter = s.clone();
    let meter_task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        loop {
            ticker.tick().await;
            let qcoef = std::array::from_fn(|i| s_meter.qcoef[i].get());
            // Lissajous ratios: derive from grouped sums of qubit coefficients
            // so the on-screen curve breathes with the patchbay state.
            let liss_a = 1.0 + 4.0 * (qcoef[0]  + qcoef[5]  + qcoef[10] + qcoef[15]);
            let liss_b = 1.0 + 4.0 * (qcoef[1]  + qcoef[4]  + qcoef[11] + qcoef[14]);
            let liss_c = 1.0 + 4.0 * (qcoef[2]  + qcoef[7]  + qcoef[8]  + qcoef[13]);
            let msg = OutMsg {
                kind: "tick",
                in_level: s_meter.input_level.get(),
                out_level: s_meter.output_level.get(),
                recording: s_meter.recording.load(Ordering::Relaxed),
                drum_on: s_meter.drum_enabled.load(Ordering::Relaxed),
                mode: s_meter.mode.load(Ordering::Relaxed),
                bpm: s_meter.drum_bpm.get(),
                master: s_meter.master_vol.get(),
                chaos: s_meter.chaos.get(),
                qcoef,
                liss_a, liss_b, liss_c,
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
            "master"      => s.master_vol.set(value.clamp(0.0, 1.0)),
            "chaos"       => s.chaos.set(value.clamp(0.0, 1.0)),
            "q_smooth"    => s.q_smooth.set(value.clamp(0.0, 1.0)),
            "root"        => s.root_hz.set(value.max(20.0)),
            "reverb_mix"  => s.reverb_mix.set(value.clamp(0.0, 1.0)),
            "reverb_size" => s.reverb_size.set(value.clamp(0.05, 0.98)),
            "delay_time"  => s.delay_time_ms.set(value.clamp(20.0, 1500.0)),
            "delay_fb"    => s.delay_fb.set(value.clamp(0.0, 0.92)),
            "bpm"         => s.drum_bpm.set(value.clamp(30.0, 240.0)),
            _ => tracing::warn!("unknown set id: {id}"),
        },
        InMsg::Toggle { id } => match id.as_str() {
            "drum" => { let v = s.drum_enabled.load(Ordering::Relaxed); s.drum_enabled.store(!v, Ordering::Relaxed); }
            _ => {}
        },
        InMsg::Lissajous { voice, t, intensity } => {
            if (voice as usize) >= 4 { return; }
            // Map parametric `t` (0..1) onto a 5-note window of the current
            // mode: pick step = floor(t * 5). Frequency = root * 2^(semis/12).
            let mode = s.mode.load(Ordering::Relaxed);
            let scale: &[i32] = mode_scale(mode);
            let step = (t.clamp(0.0, 0.999) * scale.len() as f32) as usize;
            let semis = scale[step.min(scale.len() - 1)] as f32;
            let octave = (intensity.clamp(0.0, 1.0) * 2.0) as i32 - 1; // -1..+1
            let pitch = s.root_hz.get() * 2f32.powf(semis / 12.0 + octave as f32);
            s.voice_pitch[voice as usize].set(pitch);
            s.voice_gate[voice as usize].set(intensity.clamp(0.0, 1.0));
        }
        InMsg::Route { voice, bus, value } => {
            if (voice as usize) < 4 && (bus as usize) < 4 {
                let idx = (voice as usize) * 4 + (bus as usize);
                s.route[idx].set(value.clamp(0.0, 1.0));
            }
        }
        InMsg::Voice { voice, gate } => {
            if (voice as usize) < 4 {
                s.voice_gate[voice as usize].set(if gate { 1.0 } else { 0.0 });
            }
        }
        InMsg::Mode { value } => {
            s.mode.store(value.clamp(1, 4), Ordering::Relaxed);
        }
        InMsg::Record { on } => {
            if on { eng.start_recording(); } else { eng.stop_recording(); }
        }
        InMsg::Mic { enabled, gain } => {
            s.mic_enabled.store(enabled, Ordering::Relaxed);
            s.mic_gain.set(gain.clamp(0.0, 4.0));
        }
        InMsg::MicRoute { target } => {
            s.mic_mod.set((target.min(3)) as f32);
        }
    }
}

fn mode_scale(mode: u8) -> &'static [i32] {
    // semitone offsets from the root for each qenet mode.
    match mode {
        2 => &[0, 4, 5, 7, 11], // Bati major:    C E F G B
        3 => &[0, 1, 5, 7, 8],  // Ambassel:      C Db F G Ab
        4 => &[0, 1, 5, 6, 9],  // Anchihoye:     C Db F Gb A
        _ => &[0, 2, 4, 7, 9],  // Tezeta major:  C D E G A
    }
}
