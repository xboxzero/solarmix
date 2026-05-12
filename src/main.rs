mod solarmix;

use clap::Parser;

#[derive(Parser)]
#[command(name = "solarmix", about = "Leap-driven feedback rhythm machine", version)]
struct Cli {
    /// Listen port
    #[arg(long, default_value_t = 8855)]
    port: u16,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "solarmix=info".into()),
        )
        .init();

    let cli = Cli::parse();
    let addr: std::net::SocketAddr = ([0, 0, 0, 0], cli.port).into();
    let app = solarmix::router();

    tracing::info!("Solarmix on http://0.0.0.0:{}", cli.port);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
