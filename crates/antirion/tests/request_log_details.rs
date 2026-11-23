//! What the request log records of how a request was changed and what it sent: each `params`
//! change of the provider and the deployment, with the value it set and, under content logging, the
//! value the client sent.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use antirion::startup::{ServeOptions, start};
use antirion_testkit::ScratchDir;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

const TOKEN: &str = "request-log-details-bootstrap-token-0123456789abcdef";

/// One HTTP/1.1 exchange: (status, `x-request-id`, body).
async fn exchange(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> (u16, Option<String>, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nhost: test\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    request.push_str("\r\n");
    let mut bytes = request.into_bytes();
    bytes.extend_from_slice(body);
    stream.write_all(&bytes).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let id = head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("x-request-id")
            .then(|| v.trim().to_owned())
    });
    (status, id, rest.to_owned())
}

/// An upstream that records each request body and answers a short chat completion.
async fn upstream(listener: TcpListener, seen: Arc<Mutex<Vec<Value>>>) {
    let mut connections = JoinSet::new();
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let seen = seen.clone();
        connections.spawn(async move {
            let mut bytes = Vec::new();
            let mut buf = [0u8; 4096];
            let body = loop {
                let Ok(n) = stream.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                bytes.extend_from_slice(&buf[..n]);
                let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
                let len: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                    .unwrap_or(0);
                if bytes.len() >= at + 4 + len {
                    break bytes[at + 4..at + 4 + len].to_vec();
                }
            };
            seen.lock()
                .unwrap()
                .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
            let text = json!({"id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": "up",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}})
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                text.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

struct Gateway {
    data: SocketAddr,
    admin: SocketAddr,
    key: String,
}

impl Gateway {
    /// The record of the request with `request_id`, once it is written.
    async fn record(&self, request_id: &str) -> Value {
        let auth = format!("Bearer {TOKEN}");
        for _ in 0..100 {
            let (_, _, list) = exchange(
                self.admin,
                "GET",
                &format!("/admin/v1/logs?request_id={request_id}"),
                &[("authorization", &auth)],
                b"",
            )
            .await;
            let list: Value = serde_json::from_str(&list).unwrap_or(Value::Null);
            if let Some(id) = list["items"][0]["id"].as_str() {
                let (status, _, record) = exchange(
                    self.admin,
                    "GET",
                    &format!("/admin/v1/logs/{id}"),
                    &[("authorization", &auth)],
                    b"",
                )
                .await;
                assert_eq!(status, 200, "{record}");
                return serde_json::from_str(&record).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no record for {request_id}");
    }

    /// Sends `body` with `content_type` to `path` and returns the request's record.
    async fn send(&self, path: &str, content_type: &str, body: &[u8]) -> Value {
        let bearer = format!("Bearer {}", self.key);
        let (status, id, text) = exchange(
            self.data,
            "POST",
            path,
            &[("authorization", &bearer), ("content-type", content_type)],
            body,
        )
        .await;
        assert_eq!(status, 200, "{text}");
        self.record(&id.unwrap()).await
    }
}

/// A gateway on a mock upstream, with `content` logging as given; the closure stops it.
async fn gateway(
    dir: &ScratchDir,
    content: bool,
) -> (Gateway, Arc<Mutex<Vec<Value>>>, impl FnOnce(), JoinSet<()>) {
    let mock = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", mock.local_addr().unwrap());
    let seen = Arc::<Mutex<Vec<Value>>>::default();
    let mut tasks = JoinSet::new();
    tasks.spawn(upstream(mock, seen.clone()));
    let config = json!({
        "version": 1,
        "server": {"listen": "127.0.0.1:0"},
        "admin": {"listen": "127.0.0.1:0"},
        "store": {"embedded": {"path": dir.path().join("data").to_string_lossy()}},
        "auth": {"admin": {"bootstrap_token": TOKEN}},
        "providers": {"p": {"type": "openai_compatible", "base_url": base, "auth": {"api_key": "sk-up"},
            "params": {"remove": ["/user"], "defaults": {"/top_p": 0.9}}}},
        "deployments": {"d": {"provider": "p", "model": "up",
            "params": {"overrides": {"/temperature": 0.2, "/max_tokens": 64}}}},
        "models": {"m": {"target": {"deployment": "d"}}},
        "policies": {"observability": {"content": {"enabled": content}}}
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
    let (data, admin) = (node.data_addr().unwrap(), node.admin_addr().unwrap());
    let token = node.rt.shutdown.clone();
    tasks.spawn(async move {
        let _ = node.run().await;
    });
    let (status, _, created) = exchange(
        admin,
        "POST",
        "/admin/v1/keys",
        &[
            ("authorization", &format!("Bearer {TOKEN}")),
            ("content-type", "application/json"),
        ],
        br#"{"name":"k","spec":{}}"#,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let created: Value = serde_json::from_str(&created).unwrap();
    let gw = Gateway {
        data,
        admin,
        key: created["secret"].as_str().unwrap().to_owned(),
    };
    (gw, seen, move || token.cancel(), tasks)
}

const CHAT: &str = r#"{"model":"m","messages":[{"role":"user","content":"hello"}],"temperature":0.9,"user":"alice@example.com"}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_params_change_is_logged_with_its_value_and_the_value_it_replaced() {
    let dir = ScratchDir::new("log-params-content");
    let (gw, seen, stop, mut tasks) = gateway(&dir, true).await;
    let record = gw
        .send("/v1/chat/completions", "application/json", CHAT.as_bytes())
        .await;
    let sent = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent["temperature"], 0.2);
    assert_eq!(sent.get("user"), None);
    let applied = &record["params_applied"];
    assert_eq!(applied["removed"], json!(["/user"]), "{applied}");
    assert_eq!(applied["defaults"], json!(["/top_p"]), "{applied}");
    assert_eq!(
        applied["overrides"],
        json!(["/max_tokens", "/temperature"]),
        "{applied}"
    );
    assert_eq!(
        applied["changes"],
        json!([
            {"source": "provider", "action": "removed", "pointer": "/user", "previous": "alice@example.com"},
            {"source": "provider", "action": "default", "pointer": "/top_p", "value": 0.9, "previous": null},
            {"source": "deployment", "action": "override", "pointer": "/max_tokens", "value": 64, "previous": null},
            {"source": "deployment", "action": "override", "pointer": "/temperature", "value": 0.2, "previous": 0.9}
        ]),
        "{applied}"
    );
    stop();
    tokio::time::sleep(Duration::from_millis(50)).await;
    tasks.abort_all();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_content_logging_the_client_values_are_left_out() {
    let dir = ScratchDir::new("log-params-plain");
    let (gw, _seen, stop, mut tasks) = gateway(&dir, false).await;
    let record = gw
        .send("/v1/chat/completions", "application/json", CHAT.as_bytes())
        .await;
    let changes = record["params_applied"]["changes"].as_array().unwrap().clone();
    assert_eq!(changes.len(), 4, "{changes:?}");
    assert!(changes.iter().all(|c| c.get("previous").is_none()), "{changes:?}");
    assert_eq!(changes[3]["value"], 0.2, "the configured value is always shown");
    stop();
    tokio::time::sleep(Duration::from_millis(50)).await;
    tasks.abort_all();
}
