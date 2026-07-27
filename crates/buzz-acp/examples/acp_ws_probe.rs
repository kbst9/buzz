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

    // session/new is where buzz-acp reads model options from
    // (`extract_model_config_options`), so its result answers whether one
    // server can switch provider/model per session.
    // session/new is where buzz-acp reads model options from
    // (`extract_model_config_options`), so its result answers whether one
    // server can switch provider/model per session.
    let sn = serde_json::json!({
        "jsonrpc":"2.0","id":2,"method":"session/new",
        "params":{"cwd":"/tmp","mcpServers":[]}
    });
    ws.send(Message::Text(sn.to_string().into())).await?;
    println!("--> session/new");

    for _ in 0..30 {
        match tokio::time::timeout(std::time::Duration::from_secs(25), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                if t.contains("\"id\":2") {
                    println!("<== session/new result: {}", t);
                    return Ok(());
                }
                println!("    (notification: {})", &t[..t.len().min(160)]);
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => return Err("closed".into()),
            Err(_) => return Err("timeout waiting for session/new".into()),
        }
    }
    Ok(())
}
