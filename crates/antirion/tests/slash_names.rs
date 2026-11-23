//! A resource whose name has `/` in it, such as a Model named `openai/gpt-x`, is served by the Admin
//! API by its encoded name (`openai%2Fgpt-x`): read, changed and deleted like any other. An encoded
//! slash stays refused where it could reach a file path, and as part of a dot segment.

use std::net::SocketAddr;

use antirion::startup::{ServeOptions, start};
use antirion_testkit::ScratchDir;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinSet;

const TOKEN: &str = "slash-names-bootstrap-token-0123456789abcdef0123";

async fn call(addr: SocketAddr, method: &str, path: &str, content_type: &str, body: &str) -> (u16, Value) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nhost: test\r\nconnection: close\r\nauthorization: Bearer {TOKEN}\r\n\
         content-type: {content_type}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let body = text.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_named_with_a_slash_is_read_changed_and_deleted() {
    let dir = ScratchDir::new("slash-names");
    let config = json!({
        "version": 1,
        "server": {"listen": "127.0.0.1:0"},
        "admin": {"listen": "127.0.0.1:0"},
        "store": {"embedded": {"path": dir.path().join("data").to_string_lossy()}},
        "auth": {"admin": {"bootstrap_token": TOKEN}},
        "providers": {"openai": {"type": "openai", "base_url": "http://127.0.0.1:9/v1", "auth": {"api_key": "sk-up"}}},
        "deployments": {"d": {"provider": "openai", "model": "gpt-x"}}
    });
    let file = dir.path().join("gw.json");
    std::fs::write(&file, config.to_string()).unwrap();
    let node = start(ServeOptions {
        config: Some(file),
        test_mode: true,
        no_config: None,
    })
    .await
    .unwrap();
    let admin = node.admin_addr().unwrap();
    let shutdown = node.rt.shutdown.clone();
    let mut tasks = JoinSet::new();
    tasks.spawn(node.run());
    const JSON: &str = "application/json";

    let (status, created) = call(
        admin,
        "POST",
        "/admin/v1/models",
        JSON,
        &json!({"name": "openai/gpt-x", "spec": {"target": "d"}}).to_string(),
    )
    .await;
    assert_eq!(status, 201, "{created}");

    let (status, read) = call(admin, "GET", "/admin/v1/models/openai%2Fgpt-x", JSON, "").await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["name"], "openai/gpt-x");

    let (status, patched) = call(
        admin,
        "PATCH",
        "/admin/v1/models/openai%2fgpt-x",
        "application/merge-patch+json",
        r#"{"spec":{"display_name":"GPT X"}}"#,
    )
    .await;
    assert_eq!(status, 200, "{patched}");
    assert_eq!(patched["spec"]["display_name"], "GPT X");

    let (status, gone) = call(admin, "DELETE", "/admin/v1/models/openai%2Fgpt-x", JSON, "").await;
    assert!(status == 200 || status == 204, "{status}: {gone}");
    let (status, _) = call(admin, "GET", "/admin/v1/models/openai%2Fgpt-x", JSON, "").await;
    assert_eq!(status, 404);

    for refused in [
        "/admin/v1/models/..%2Fsettings",
        "/ui/..%2Fadmin%2Fv1",
        "/ui/a%2Fb",
    ] {
        let (status, _) = call(admin, "GET", refused, JSON, "").await;
        assert_eq!(status, 400, "{refused}");
    }

    shutdown.cancel();
    while tasks.join_next().await.is_some() {}
}
