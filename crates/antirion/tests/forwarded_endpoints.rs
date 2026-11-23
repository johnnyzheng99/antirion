//! The endpoints whose JSON body is forwarded as it is: TypeSafe System One (`/v1/systemone`),
//! OpenAI Decisions (`/v1/decisions`), audio.cpp tasks (`/v1/tasks/*`) and the operator's custom
//! endpoints. Each routes on the body's `model`, reaches the same operation path below the
//! deployment's base URL with the deployment's model id, and answers what the upstream answered. An
//! OpenAI-compatible provider serves them all by default; another type serves them only with
//! `capabilities.unrestricted`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use antirion::startup::{ServeOptions, start};
use antirion_testkit::ScratchDir;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

const TOKEN: &str = "forwarded-endpoints-bootstrap-token-0123456789abcdef";

/// What the upstream saw: method, path and JSON body of each request.
type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;

async fn call(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, Value) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nhost: test\r\nconnection: close\r\ncontent-type: application/json\r\n\
         content-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let body = text.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

/// An upstream that records each request and answers with the model it was sent and a usage.
async fn upstream(listener: TcpListener, seen: Seen) {
    let mut connections = JoinSet::new();
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let seen = seen.clone();
        connections.spawn(async move {
            let mut bytes = Vec::new();
            let mut buf = [0u8; 4096];
            let (head, body) = loop {
                let Ok(n) = stream.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                bytes.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&bytes).into_owned();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let len: usize = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if body.len() >= len {
                        break (head.to_owned(), body.to_owned());
                    }
                }
            };
            let mut line = head.split(' ');
            let method = line.next().unwrap_or_default().to_owned();
            let path = line.next().unwrap_or_default().to_owned();
            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let text = json!({
                "model": body["model"],
                "answers": {"q": {"type": "noul", "noul": 0.5}},
                "usage": {"input_tokens": 7, "output_tokens": 0}
            })
            .to_string();
            seen.lock().unwrap().push((method, path, body));
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                text.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forwarded_endpoints_route_on_the_model_and_keep_the_body() {
    let dir = ScratchDir::new("forwarded-endpoints");
    let mock = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", mock.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let mut mock_task = JoinSet::new();
    mock_task.spawn(upstream(mock, seen.clone()));
    let config = json!({
        "version": 1,
        "server": {"listen": "127.0.0.1:0"},
        "admin": {"listen": "127.0.0.1:0"},
        "store": {"embedded": {"path": dir.path().join("data").to_string_lossy()}},
        "auth": {"admin": {"bootstrap_token": TOKEN}},
        "providers": {
            "local": {"type": "openai_compatible", "base_url": base, "auth": {"api_key": "sk-up"}},
            "mis": {"type": "mistral", "base_url": base, "auth": {"api_key": "sk-up"}},
            "free": {"type": "mistral", "base_url": base, "auth": {"api_key": "sk-up"},
                     "capabilities": {"unrestricted": true}}
        },
        "deployments": {
            "jev": {"provider": "local", "model": "jev-1.14.0"},
            "audio": {"provider": "local", "model": "stable_audio"},
            "narrow": {"provider": "mis", "model": "m-1"},
            "open": {"provider": "free", "model": "m-2"}
        },
        "models": {
            "jev": {"target": {"deployment": "jev"}},
            "stable-audio": {"target": {"deployment": "audio"}},
            "narrow": {"target": {"deployment": "narrow"}},
            "open": {"target": {"deployment": "open"}}
        },
        "api": {"custom_endpoints": {
            "music": {"path": "/v1/music/generate"},
            "voice": {"path": "/voice", "upstream_path": "/speak", "methods": ["PUT"]}
        }}
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
    let shutdown = node.rt.shutdown.clone();
    let mut tasks = JoinSet::new();
    tasks.spawn(node.run());

    let bearer = format!("Bearer {TOKEN}");
    let (status, created) = call(
        admin,
        "POST",
        "/admin/v1/keys",
        &[("authorization", &bearer)],
        r#"{"name":"k","spec":{}}"#,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let key = format!("Bearer {}", created["secret"].as_str().unwrap());
    let auth = [("authorization", key.as_str())];
    let last = || seen.lock().unwrap().last().cloned().unwrap();

    let systemone = json!({"model": "jev", "state": "a refund request",
        "questions": {"q": {"type": "noul", "instructions": "Is it urgent?"}}});
    let (status, answer) = call(data, "POST", "/v1/systemone", &auth, &systemone.to_string()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["answers"]["q"]["noul"], 0.5, "{answer}");
    let (method, path, body) = last();
    assert_eq!((method.as_str(), path.as_str()), ("POST", "/v1/systemone"));
    assert_eq!(body["model"], "jev-1.14.0", "the deployment's model id is sent");
    assert_eq!(
        body["questions"], systemone["questions"],
        "the body is forwarded as it is"
    );

    let decisions =
        json!({"model": "jev", "input": "x", "questions": [{"type": "predicate", "instructions": "?"}]});
    let (status, answer) = call(data, "POST", "/v1/decisions", &auth, &decisions.to_string()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(last().1, "/v1/decisions");

    let task = json!({"model": "stable-audio", "request": {"text": "a tight snare fill",
        "options": {"duration_seconds": 10, "audio_input_kind": "inpaint_audio"}}});
    for op in ["run", "stream", "batch"] {
        let (status, answer) = call(data, "POST", &format!("/v1/tasks/{op}"), &auth, &task.to_string()).await;
        assert_eq!(status, 200, "{op}: {answer}");
        let (_, path, body) = last();
        assert_eq!(path, format!("/v1/tasks/{op}"));
        assert_eq!(body["model"], "stable_audio");
        assert_eq!(body["request"], task["request"]);
    }

    let (status, answer) = call(data, "POST", "/v1/music/generate", &auth, &task.to_string()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(last().1, "/v1/music/generate", "the path below /v1 is kept");
    let (status, answer) = call(data, "PUT", "/voice", &auth, &task.to_string()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(last().1, "/v1/speak", "upstream_path names the operation path");
    let (status, _) = call(data, "POST", "/voice", &auth, &task.to_string()).await;
    assert_eq!(status, 405, "a custom endpoint answers only its methods");

    let form = "--b\r\ncontent-disposition: form-data; name=\"model\"\r\n\r\nstable-audio\r\n\
                --b\r\ncontent-disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n\
                content-type: audio/wav\r\n\r\nRIFF\r\n--b--\r\n";
    let mut stream = TcpStream::connect(data).await.unwrap();
    let request = format!(
        "POST /v1/audio/transcriptions/details HTTP/1.1\r\nhost: test\r\nconnection: close\r\n\
         authorization: {key}\r\ncontent-type: multipart/form-data; boundary=b\r\ncontent-length: {}\r\n\r\n{form}",
        form.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw);
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    assert_eq!(last().1, "/v1/audio/transcriptions/details");

    let narrow = json!({"model": "narrow", "state": "s", "questions": {"q": {"type": "noul"}}});
    let before = seen.lock().unwrap().len();
    let (status, error) = call(data, "POST", "/v1/systemone", &auth, &narrow.to_string()).await;
    assert_eq!(
        status, 400,
        "a Mistral deployment does not declare System One: {error}"
    );
    assert_eq!(seen.lock().unwrap().len(), before, "nothing reached the upstream");

    let open = json!({"model": "open", "state": "s", "questions": {"q": {"type": "noul"}}});
    let (status, answer) = call(data, "POST", "/v1/systemone", &auth, &open.to_string()).await;
    assert_eq!(
        status, 200,
        "an unrestricted provider serves every endpoint: {answer}"
    );
    assert_eq!(last().2["model"], "m-2");

    shutdown.cancel();
    while tasks.join_next().await.is_some() {}
    mock_task.abort_all();
}
