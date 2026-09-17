//! Mirror server entrypoint.

use mirror_server::egress::EgressMonitor;
use mirror_server::preflight::format_startup_failure;
use mirror_server::router::{AppState, create_router};
use mirror_store::Store;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3000);
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());

    let db_path_str = std::env::var("MIRROR_STORE_PATH")
        .unwrap_or_else(|_| ".data/mirror.db".to_string());
    let db_path = Path::new(&db_path_str);
    let data_dir = db_path.parent().unwrap_or(Path::new("."));

    let configured_key = std::env::var("MIRROR_STORE_KEY").ok();

    let encryption_key = match mirror_store::crypto::EncryptionKey::load_with(
        data_dir,
        configured_key.as_deref(),
    ) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("{}", format_startup_failure(&e.to_string(), None));
            std::process::exit(1);
        }
    };

    let store = match Store::open(db_path, encryption_key) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("{}", format_startup_failure(&e.to_string(), None));
            std::process::exit(1);
        }
    };

    let egress = Arc::new(EgressMonitor::new());

    let app_state = Arc::new(AppState {
        store,
        egress,
    });

    let router = create_router(app_state);

    let addr: SocketAddr = format!("{host}:{port}").parse().unwrap_or_else(|_| {
        SocketAddr::from(([127, 0, 0, 1], port))
    });

    println!("Mirror server listening on http://{addr}");
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            let code = if e.kind() == std::io::ErrorKind::AddrInUse {
                Some("EADDRINUSE")
            } else {
                None
            };
            eprintln!("{}", format_startup_failure(&e.to_string(), code));
            std::process::exit(1);
        }
    };

    if let Err(e) = axum::serve(listener, router).await {
        eprintln!("Server error: {e}");
    }
}
