//! Proxies the browser's realtime WebSocket connection to chatgpt.com.
//! Port of `proxyWebSocketUpgrade` in `apps/server/src/proxy.ts`.
//!
//! The TS version hooked this into the raw Node HTTP server's `upgrade`
//! event, bypassing Fastify's routing entirely, because Fastify has no
//! built-in WebSocket support. Axum's equivalent is `WebSocketUpgrade`, which
//! can be extracted from request parts on demand rather than needing its own
//! route - so this is wired into the same catch-all fallback that proxies
//! every other unmatched path, branching here only when the request is
//! actually an Upgrade request.
//!
//! Host/Origin/auth are already enforced once for every request by
//! `router::security_middleware` before this ever runs (see the note in
//! `proxy.rs`), so this does not repeat those checks.

use crate::auth::get_valid_credentials;
use crate::proxy::{UPSTREAM, USER_AGENT, resolve_account_id};
use crate::router::AppState;
use axum::body::{Body, Bytes};
use axum::extract::FromRequestParts;
use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::http::{Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// Whether this request is asking to be upgraded to a WebSocket connection.
pub fn is_websocket_upgrade_request(req: &Request<Body>) -> bool {
    let headers = req.headers();
    let has_upgrade_connection = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().split(',').any(|p| p.trim() == "upgrade"));
    let is_websocket = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    has_upgrade_connection && is_websocket
}

/// Accepts the client's WebSocket upgrade, dials the equivalent `wss://`
/// endpoint on chatgpt.com with the same credentials the HTTP proxy path
/// uses, and pumps frames between the two connections until either side
/// closes.
pub async fn proxy_websocket_upgrade(state: Arc<AppState>, req: Request<Body>) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();

    let (mut parts, _body) = req.into_parts();
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };

    let session_token = state
        .store
        .session()
        .ok()
        .flatten()
        .map(|s| s.session_token);

    let creds = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(error) => {
            return (StatusCode::BAD_GATEWAY, error.to_string()).into_response();
        }
    };
    let account_id = resolve_account_id(&state, &creds.access_token, &creds.device_id).await;

    let upstream_url = format!("{}{path_and_query}", UPSTREAM.replacen("https:", "wss:", 1));
    let mut upstream_request = match upstream_url.into_client_request() {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_GATEWAY, "Invalid upstream URL").into_response(),
    };
    {
        let headers = upstream_request.headers_mut();
        headers.insert(header::USER_AGENT, USER_AGENT.parse().unwrap());
        headers.insert(header::ORIGIN, UPSTREAM.parse().unwrap());
        if let Some(token) = &session_token
            && let Ok(v) = format!("__Secure-next-auth.session-token={token}").parse()
        {
            headers.insert(header::COOKIE, v);
        }
        if let Ok(v) = format!("Bearer {}", creds.access_token).parse() {
            headers.insert(header::AUTHORIZATION, v);
        }
        if let Ok(v) = creds.device_id.parse() {
            headers.insert("oai-device-id", v);
        }
        if let Some(acct) = account_id
            && let Ok(v) = acct.parse()
        {
            headers.insert("chatgpt-account-id", v);
        }
    }

    let upstream = match tokio_tungstenite::connect_async(upstream_request).await {
        Ok((socket, _response)) => socket,
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, "Failed to reach upstream WebSocket")
                .into_response();
        }
    };

    ws.on_upgrade(move |client| pump(client, upstream))
}

type UpstreamSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Forwards frames in both directions until either side closes or errors.
async fn pump(client: WebSocket, upstream: UpstreamSocket) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let client_to_upstream = async {
        while let Some(Ok(msg)) = client_rx.next().await {
            let forwarded = match msg {
                AxumMessage::Text(text) => UpstreamMessage::Text(text.to_string().into()),
                AxumMessage::Binary(data) => UpstreamMessage::Binary(data.to_vec().into()),
                AxumMessage::Ping(data) => UpstreamMessage::Ping(data.to_vec().into()),
                AxumMessage::Pong(data) => UpstreamMessage::Pong(data.to_vec().into()),
                AxumMessage::Close(_) => break,
            };
            if upstream_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };

    let upstream_to_client = async {
        while let Some(Ok(msg)) = upstream_rx.next().await {
            let forwarded = match msg {
                UpstreamMessage::Text(text) => AxumMessage::Text(text.as_str().into()),
                UpstreamMessage::Binary(data) => AxumMessage::Binary(Bytes::from(data.to_vec())),
                UpstreamMessage::Ping(data) => AxumMessage::Ping(Bytes::from(data.to_vec())),
                UpstreamMessage::Pong(data) => AxumMessage::Pong(Bytes::from(data.to_vec())),
                UpstreamMessage::Close(_) | UpstreamMessage::Frame(_) => break,
            };
            if client_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };

    tokio::join!(client_to_upstream, upstream_to_client);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(connection: Option<&str>, upgrade: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().uri("/p1/ws/user/123");
        if let Some(c) = connection {
            builder = builder.header(header::CONNECTION, c);
        }
        if let Some(u) = upgrade {
            builder = builder.header(header::UPGRADE, u);
        }
        builder.body(Body::empty()).unwrap()
    }

    #[test]
    fn recognizes_a_real_upgrade_request() {
        assert!(is_websocket_upgrade_request(&req(
            Some("Upgrade"),
            Some("websocket")
        )));
        assert!(is_websocket_upgrade_request(&req(
            Some("keep-alive, Upgrade"),
            Some("WebSocket")
        )));
    }

    #[test]
    fn rejects_a_plain_request() {
        assert!(!is_websocket_upgrade_request(&req(None, None)));
        assert!(!is_websocket_upgrade_request(&req(Some("keep-alive"), None)));
        assert!(!is_websocket_upgrade_request(&req(
            Some("Upgrade"),
            Some("h2c")
        )));
    }
}
