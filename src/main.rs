mod state;
mod audio;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;

use crate::audio::engine::Engine;
use crate::state::SharedState;

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "solarmix=info,tower_http=info".into()))
        .init();

    let crate_root = env!("CARGO_MANIFEST_DIR");
    let static_dir = PathBuf::from(crate_root).join("static");
    let rec_dir = PathBuf::from(crate_root).join("recordings");
    std::fs::create_dir_all(&rec_dir)?;

    let state = SharedState::new();
    state.apply_preset(state.drum_preset.load(std::sync::atomic::Ordering::Relaxed));
    // streams are !Send — keep them on the main thread for their entire lifetime.
    let (_streams, handle) = Engine::start(state, rec_dir)?;

    let port: u16 = std::env::var("SOLARMIX_PORT")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(8844);
    let addr: SocketAddr = ([0, 0, 0, 0], port).into();

    // Run a current-thread runtime so we don't try to move !Send things across threads.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(web::run(handle, static_dir, addr))
}
