//! Mirror server entrypoint.

use mirror_server::egress::{EgressMonitor, TraceFetcher};
use mirror_server::preflight::format_startup_failure;
use mirror_server::router::{AppState, create_router};
use mirror_store::Store;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

struct CloudflareTrace(wreq::Client);

impl TraceFetcher for CloudflareTrace {
    fn fetch(&self, url: &str) -> impl std::future::Future<Output = Result<String, String>> + Send {
        let client = self.0.clone();
        let url = url.to_string();
        async move {
            let response = client
                .get(url)
                .header("accept", "text/plain")
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("Cloudflare trace returned HTTP {status}"));
            }
            response.text().await.map_err(|error| error.to_string())
        }
    }
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8787);
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());

    let db_path_str = std::env::var("MIRROR_STORE_PATH").unwrap_or_else(|_| {
        let data_dir = std::env::var("MIRROR_DATA_DIR").unwrap_or_else(|_| ".data".to_string());
        Path::new(&data_dir)
            .join("mirror.db")
            .to_string_lossy()
            .into_owned()
    });
    let db_path = Path::new(&db_path_str);
    let data_dir = db_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));

    let data_dir_existed = data_dir.exists();
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        eprintln!("{}", format_startup_failure(&e.to_string(), None));
        std::process::exit(1);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !data_dir_existed
            && let Err(e) =
                std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700))
        {
            eprintln!("{}", format_startup_failure(&e.to_string(), None));
            std::process::exit(1);
        }
    }

    let configured_key = std::env::var("MIRROR_STORE_KEY").ok();

    let encryption_key =
        match mirror_store::crypto::EncryptionKey::load_with(data_dir, configured_key.as_deref()) {
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

    let http = match mirror_protocol::http::build_client() {
        Ok(client) => client,
        Err(e) => {
            eprintln!("{}", format_startup_failure(&e.to_string(), None));
            std::process::exit(1);
        }
    };
    if let Err(e) = egress.verify(&CloudflareTrace(http.clone())).await {
        eprintln!("{}", format_startup_failure(&e.to_string(), None));
        std::process::exit(1);
    }

    let monitor = egress.clone();
    let monitor_http = http.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(error) = monitor.verify(&CloudflareTrace(monitor_http.clone())).await {
                eprintln!("{}", format_startup_failure(&error.to_string(), None));
                std::process::exit(1);
            }
        }
    });

    let app_state = Arc::new(AppState {
        store,
        egress,
        http,
        challenges: mirror_server::decoder_challenges::ChallengeShelf::default(),
    });

    let router = create_router(app_state);

    let addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!(
                "{}",
                format_startup_failure(&format!("invalid HOST/PORT: {e}"), None)
            );
            std::process::exit(1);
        }
    };

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
