//! Probe: can an ACP client reach a networked ACP endpoint over WebSocket?
//!
//! Uses tokio-tungstenite — the same client stack `buzz-acp` already links for
//! its relay connection — so a success here means a `BUZZ_ACP_AGENT_URL`
//! transport is viable with no new dependency.
//!
//!   cargo run -p buzz-acp --example acp_ws_probe -- ws://127.0.0.1:3284/acp <secret>
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::args().nth(1).expect("url");
    let secret = std::env::args().nth(2).unwrap_or_default();

    let mut req = url.as_str().into_client_request()?;
    if !secret.is_empty() {
        req.headers_mut()
            .insert("X-Secret-Key", secret.parse().unwrap());
    }

    let (mut ws, resp) = tokio_tungstenite::connect_async(req).await?;
    println!("handshake: HTTP {}", resp.status());

    let init = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": 1,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } } }
    });
    ws.send(Message::Text(init.to_string().into())).await?;
    println!("--> initialize");

    for _ in 0..5 {
        match tokio::time::timeout(std::time::Duration::from_secs(15), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                println!("<-- {}", &t[..t.len().min(600)]);
                return Ok(());
            }
            Ok(Some(Ok(other))) => println!("<-- (non-text frame: {other:?})"),
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => return Err("socket closed with no reply".into()),
            Err(_) => return Err("timed out waiting for initialize reply".into()),
        }
    }
    Ok(())
}
