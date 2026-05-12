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
use crate::state::{LooperState, SharedState};

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
    #[serde(rename = "looper")] Looper { action: String },
    #[serde(rename = "record")] Record { on: bool },
    #[serde(rename = "wave")] Wave { value: u8 },
}

#[derive(Serialize)]
struct OutMsg<'a> {
    #[serde(rename = "type")] kind: &'a str,
    in_level: f32,
    out_level: f32,
    loop_pos: f32,
    drum_step: u8,
    recording: bool,
    looper: u8,
    auto_mix: bool,
    drum_on: bool,
    automation: bool,
}

async fn socket_loop(socket: WebSocket, app: AppState) {
    let (mut tx, mut rx) = socket.split();
    let s = app.shared.clone();
    let eng = app.engine.clone();

    let s_meter = s.clone();
    let meter_task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        let start = std::time::Instant::now();
        loop {
            ticker.tick().await;
            let bpm = s_meter.drum_bpm.get();
            let elapsed = start.elapsed().as_secs_f32();
            let step = (elapsed * bpm * 4.0 / 60.0) as u32 & 15;
            let msg = OutMsg {
                kind: "tick",
                in_level: s_meter.input_level.get(),
                out_level: s_meter.output_level.get(),
                loop_pos: s_meter.loop_position.get(),
                drum_step: step as u8,
                recording: s_meter.recording.load(Ordering::Relaxed),
                looper: s_meter.looper_state.load(Ordering::Relaxed),
                auto_mix: s_meter.auto_mix.load(Ordering::Relaxed),
                drum_on: s_meter.drum_enabled.load(Ordering::Relaxed),
                automation: s_meter.automation_enabled.load(Ordering::Relaxed),
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
            "loop_gain" => s.looper_gain.set(value),
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
            if (voice as usize) < 4 && step < 16 {
                s.toggle_drum_step(voice as usize, step as usize);
            }
        }
        InMsg::Looper { action } => {
            let cur = s.looper_state();
            let next = match (action.as_str(), cur) {
                ("rec", LooperState::Idle) => LooperState::Recording,
                ("rec", LooperState::Recording) => LooperState::Playing,
                ("rec", LooperState::Playing) => LooperState::Overdub,
                ("rec", LooperState::Overdub) => LooperState::Playing,
                ("play", _) => LooperState::Playing,
                ("stop", _) => LooperState::Idle,
                ("clear", _) => LooperState::Idle,
                _ => cur,
            };
            s.set_looper_state(next);
        }
        InMsg::Record { on } => {
            if on { eng.start_recording(); } else { eng.stop_recording(); }
        }
        InMsg::Wave { value } => {
            s.exp_waveform.store(value.min(4), Ordering::Relaxed);
        }
    }
}
