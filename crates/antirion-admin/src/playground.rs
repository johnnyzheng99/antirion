//! The playground: `POST /playground:send` sends a request through this node's data plane with a key
//! the gateway minted for the caller in the chosen project (the console never holds a data-plane
//! key), and `POST /logs/{id}:replay` sends a logged request again. Minting and every send are
//! audited with the caller; the request is logged, limited and billed like any other. A streamed
//! send asked for as `text/event-stream` is relayed as it arrives, after one `playground` event
//! that carries what the buffered answer would (status, decision headers, log id, key).

use base64::Engine;
use antirion_core::UtcMicros;
use antirion_core::audit::Outcome;
use antirion_identity::{Credential, Plane};
use antirion_runtime::changes::Target;
use antirion_runtime::playground::{self, CREATOR};
use antirion_runtime::state::KeyCredential;
use antirion_runtime::{CommitError, Mutation};
use axum::body::Body;
use axum::response::Response;
use bytes::Bytes;
use futures_util::StreamExt;
use http::header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE};
use http::{HeaderValue, Method, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Map, Value, json};

use crate::call::Call;
use crate::error::AdminError;
use crate::logs::scope_of;

const PERMISSION: &str = "playground:send";
/// The header the data plane reads, on playground keys only, to mark a replay.
pub(crate) const REPLAY_OF: &str = "x-antirion-replay-of";

/// `auth.admin.playground`, with defaults.
struct Settings {
    enabled: bool,
    key_ttl_us: i64,
    max_sends: u32,
}

fn settings(call: &Call) -> Settings {
    let p = call.snap.config.doc.pointer("/auth/admin/playground");
    let get = |k: &str| p.and_then(|p| p.get(k));
    let ttl = get("key_ttl")
        .and_then(Value::as_str)
        .and_then(antirion_config::scalar::parse_duration)
        .unwrap_or(std::time::Duration::from_secs(900));
    Settings {
        enabled: get("enabled").and_then(Value::as_bool).unwrap_or(true),
        key_ttl_us: i64::try_from(ttl.as_micros()).unwrap_or(i64::MAX),
        max_sends: get("max_requests_per_key")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(100),
    }
}

/// The data-plane path of an endpoint name, and the name of a logged endpoint path.
const ENDPOINTS: &[(&str, &str)] = &[
    ("chat_completions", "/v1/chat/completions"),
    ("responses", "/v1/responses"),
    ("messages", "/v1/messages"),
    ("embeddings", "/v1/embeddings"),
    ("speech", "/v1/audio/speech"),
    ("transcriptions", "/v1/audio/transcriptions"),
    ("rerank", "/v1/rerank"),
    ("decisions", "/v1/decisions"),
];

/// Playground-only: a base64 audio file the admin API encodes as multipart for STT.
const PLAYGROUND_FILE: &str = "_playground_file";

fn path_of(endpoint: &str) -> Option<&'static str> {
    ENDPOINTS.iter().find(|(e, _)| *e == endpoint).map(|(_, p)| *p)
}

fn caller(call: &Call) -> String {
    call.principal
        .user
        .clone()
        .unwrap_or_else(|| call.principal.id.clone())
}

/// A key of the caller's in `project`: the one minted earlier while it serves, else a new one.
async fn key_for(call: &Call, project: &str, s: &Settings) -> Result<(String, String), AdminError> {
    let who = caller(call);
    let now = call.rt.now();
    let exists = |name: &str| {
        call.rt
            .gens
            .load()
            .config
            .doc
            .pointer(&format!("/keys/{name}"))
            .is_some()
    };
    if let Some(k) = call
        .rt
        .state
        .playground
        .take_send(&who, project, now, s.max_sends, exists)
    {
        return Ok(k);
    }
    call.rt.delete_expired_playground_keys().await;
    let cred = Credential::generate(Plane::Data).map_err(|_| AdminError::internal())?;
    let suffix = cred
        .kid()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect::<String>();
    let name = format!("playground-{}", suffix.to_ascii_lowercase());
    let expires_at = UtcMicros(now.0.saturating_add(s.key_ttl_us));
    let mut spec = Map::new();
    spec.insert("project".into(), json!(project));
    spec.insert("expires_at".into(), json!(expires_at.to_rfc3339_seconds()));
    spec.insert("description".into(), json!(format!("Playground key of {who}")));
    if call.principal.user.is_some() {
        spec.insert("owner".into(), json!(who));
    }
    let record = KeyCredential {
        kid: cred.kid().to_owned(),
        verifier: call.rt.pepper.verifier(cred.expose()),
        hint: cred.hint(),
        previous: None,
    };
    let resource = format!("keys/{name}");
    let result = call
        .rt
        .mutate(|state| {
            let mut doc = state.doc.clone();
            let keys = doc
                .as_object_mut()
                .map(|o| o.entry("keys").or_insert_with(|| json!({})))
                .and_then(Value::as_object_mut)
                .ok_or(())?;
            keys.insert(name.clone(), Value::Object(spec.clone()));
            Ok::<_, ()>(Mutation {
                candidate: doc,
                writer: "api".to_owned(),
                written: vec![Target::Resource("keys", name.clone())],
                credentials: vec![(name.clone(), record.clone())],
                meta_edits: Vec::new(),
                dry_run: false,
                source: CREATOR.to_owned(),
                audit: Some(playground::audit_context("keys.create", &resource, 201)),
            })
        })
        .await;
    match result {
        Ok(_) => {}
        Err(CommitError::Invalid(details)) => return Err(AdminError::validation(details)),
        Err(CommitError::Store(_)) => return Err(AdminError::store_unavailable()),
        Err(_) => return Err(AdminError::internal()),
    }
    call.audit_with(
        "playground.mint",
        &resource,
        Outcome::Success,
        StatusCode::CREATED,
        json!({"key": name, "project": project, "expires_at": expires_at.to_rfc3339_seconds()}),
    )
    .await;
    let secret = cred.expose().to_owned();
    call.rt
        .state
        .playground
        .remember(&who, project, name.clone(), secret.clone(), expires_at);
    Ok((name, secret))
}

/// One server-sent event as `{event?, data}`, `data` parsed when it is JSON.
fn events(text: &str) -> Vec<Value> {
    text.split("\n\n")
        .filter_map(|block| {
            let mut event = None;
            let mut data: Vec<&str> = Vec::new();
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = Some(v.trim().to_owned());
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v));
                }
            }
            if data.is_empty() {
                return None;
            }
            let joined = data.join("\n");
            let data = serde_json::from_str(&joined).unwrap_or(Value::String(joined));
            let mut o = Map::new();
            if let Some(e) = event {
                o.insert("event".into(), Value::String(e));
            }
            o.insert("data".into(), data);
            Some(Value::Object(o))
        })
        .collect()
}

/// Whether the caller takes an event stream (`Accept: text/event-stream`).
fn wants_events(call: &Call) -> bool {
    call.headers
        .get_all(ACCEPT)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| v.split(',').any(|t| t.trim().starts_with("text/event-stream")))
}

/// Sends `body` to `path` with the caller's playground key for `project`. With `live`, an event
/// stream from the data plane is relayed as it arrives; otherwise the answer is buffered as JSON.
async fn send(
    call: &Call,
    project: &str,
    path: &str,
    mut body: Value,
    stream: Option<bool>,
    replay_of: Option<&str>,
    live: bool,
) -> Result<Response, AdminError> {
    let s = settings(call);
    let plane = call.rt.state.playground.plane().ok_or_else(|| {
        AdminError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "The data plane is not running.",
        )
    })?;
    let (key, secret) = key_for(call, project, &s).await?;
    if stream == Some(true) && let Some(o) = body.as_object_mut() {
        o.insert("stream".into(), Value::Bool(true));
    }
    let (payload, content_type) = encode_body(path, body)?;
    let mut req = http::Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(http::header::HOST, "localhost")
        .header(http::header::CONTENT_TYPE, content_type)
        .header(http::header::AUTHORIZATION, format!("Bearer {secret}"))
        .header("anthropic-version", "2023-06-01")
        .header("x-request-id", call.request_id.as_str());
    if let Some(id) = replay_of {
        req = req.header(REPLAY_OF, id);
    }
    let req = req.body(payload).map_err(|_| AdminError::internal())?;
    let resp = plane.send(req).await.map_err(|_| {
        AdminError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "The data plane did not answer.",
        )
    })?;
    let (parts, incoming) = resp.into_parts();
    let headers: Map<String, Value> = parts
        .headers
        .iter()
        .filter(|(n, _)| n.as_str().starts_with("x-antirion-") || n.as_str() == "x-request-id")
        .filter_map(|(n, v)| Some((n.as_str().to_owned(), Value::String(v.to_str().ok()?.to_owned()))))
        .collect();
    let log_id = headers.get("x-antirion-log-id").cloned().unwrap_or(Value::Null);
    let sse = parts
        .headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| c.starts_with("text/event-stream"));
    let status = parts.status.as_u16();
    let mut out = json!({
        "status": status,
        "headers": headers,
        "log_id": log_id,
        "key": key,
    });
    let audit =
        json!({"key": key, "path": path, "status": status, "log_id": out["log_id"], "replay_of": replay_of});
    let action = if replay_of.is_some() {
        "logs.replay"
    } else {
        "playground.send"
    };
    if live && sse {
        call.audit_read_with(
            action,
            &format!("projects/{project}"),
            Outcome::Success,
            StatusCode::OK,
            audit,
        )
        .await;
        let head = Bytes::from(format!("event: playground\ndata: {out}\n\n"));
        let relayed =
            futures_util::stream::once(
                async move { Ok::<_, Box<dyn std::error::Error + Send + Sync>>(head) },
            )
            .chain(incoming.into_data_stream());
        let mut resp = Response::new(Body::from_stream(relayed));
        resp.headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
        resp.headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok(resp);
    }
    let bytes = incoming.collect().await.map(|c| c.to_bytes()).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    if sse {
        out["events"] = Value::Array(events(&text));
    } else {
        out["body"] = serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(text.into_owned()));
    }
    call.audit_read_with(
        action,
        &format!("projects/{project}"),
        Outcome::Success,
        StatusCode::OK,
        audit,
    )
    .await;
    Ok(call.json(StatusCode::OK, &out))
}

fn not_enabled() -> AdminError {
    AdminError::not_found()
}

/// `POST /playground:send`.
pub(crate) async fn playground_send(call: &Call) -> Result<Response, AdminError> {
    if call.method != Method::POST {
        return Err(AdminError::method_not_allowed("POST"));
    }
    call.allow_params(&[])?;
    if !settings(call).enabled {
        return Err(not_enabled());
    }
    let m = call.json_body()?;
    let project = m
        .get("project")
        .and_then(Value::as_str)
        .ok_or_else(|| AdminError::invalid_parameter("project is required"))?;
    let endpoint = m
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| AdminError::invalid_parameter("endpoint is required"))?;
    let path = path_of(endpoint).ok_or_else(|| {
        AdminError::invalid_parameter(
            "endpoint must be one of chat_completions, responses, messages, embeddings, speech, \
             transcriptions, rerank, or decisions",
        )
    })?;
    let body = m
        .get("body")
        .filter(|b| b.is_object())
        .cloned()
        .ok_or_else(|| AdminError::invalid_parameter("body must be an object"))?;
    let stream = match m.get("stream") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(AdminError::invalid_parameter("stream must be true or false")),
    };
    if let Some(k) = m
        .keys()
        .find(|k| !["project", "endpoint", "body", "stream"].contains(&k.as_str()))
    {
        return Err(AdminError::invalid_parameter(format!("unknown member {k:?}")));
    }
    let chain = call.snap.identity.project_scopes(project);
    if !call.snap.identity.projects.contains_key(project) || !call.principal.sees(&chain) {
        return Err(AdminError::not_found());
    }
    call.require(PERMISSION, &chain)?;
    let live = stream == Some(true) && wants_events(call);
    send(call, project, path, body, stream, None, live).await
}

/// `POST /logs/{id}:replay`.
pub(crate) async fn replay(call: &Call, id: &str) -> Result<Response, AdminError> {
    if call.method != Method::POST {
        return Err(AdminError::method_not_allowed("POST"));
    }
    call.allow_params(&[])?;
    if !settings(call).enabled {
        return Err(not_enabled());
    }
    let patch = if call.body.is_empty() {
        Vec::new()
    } else {
        match call.json_body()?.get("body_patch") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(ops)) => ops.clone(),
            Some(_) => {
                return Err(AdminError::invalid_parameter(
                    "body_patch must be an RFC 6902 array",
                ));
            }
        }
    };
    let record = call
        .rt
        .stored_log(id)
        .await
        .map_err(|_| AdminError::store_unavailable())?
        .ok_or_else(AdminError::not_found)?;
    let chain = scope_of(&record);
    if !call.principal.sees(&chain) {
        return Err(AdminError::not_found());
    }
    call.require("logs:read_content", &chain)?;
    call.require(PERMISSION, &chain)?;
    let project = record
        .get("project")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let path = record
        .get("endpoint")
        .and_then(Value::as_str)
        .and_then(|e| ENDPOINTS.iter().find(|(_, p)| *p == e).map(|(_, p)| *p));
    let request = record.pointer("/content/request");
    let stored = request
        .filter(|r| r.get("truncated") == Some(&Value::Bool(false)))
        .and_then(|r| r.get("body"))
        .filter(|b| b.is_object());
    let (Some(path), Some(body), false) = (path, stored, project.is_empty()) else {
        return Err(AdminError::conflict(
            "conflict",
            "The record has no stored request body this endpoint can send again.",
            Vec::new(),
        ));
    };
    if !call.snap.identity.projects.contains_key(&project) {
        return Err(AdminError::conflict(
            "conflict",
            "The record's project no longer exists.",
            Vec::new(),
        ));
    }
    let body = antirion_ext::patch::apply(body, &patch)
        .map_err(|e| AdminError::invalid_parameter(format!("body_patch does not apply: {e}")))?;
    send(call, &project, path, body, None, Some(id), false).await
}

fn encode_body(path: &str, body: Value) -> Result<(Bytes, HeaderValue), AdminError> {
    if path == "/v1/audio/transcriptions" {
        return multipart_transcriptions(body);
    }
    Ok((
        Bytes::from(serde_json::to_vec(&body).unwrap_or_default()),
        HeaderValue::from_static("application/json"),
    ))
}

fn multipart_transcriptions(body: Value) -> Result<(Bytes, HeaderValue), AdminError> {
    let Some(obj) = body.as_object() else {
        return Err(AdminError::invalid_parameter("body must be an object"));
    };
    let file = obj.get(PLAYGROUND_FILE).and_then(Value::as_object).ok_or_else(|| {
        AdminError::invalid_parameter(format!("body must include {PLAYGROUND_FILE} for transcriptions"))
    })?;
    let data = file
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| AdminError::invalid_parameter("transcriptions file data must be a base64 string"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| AdminError::invalid_parameter("transcriptions file data is not valid base64"))?;
    let field = file
        .get("field")
        .and_then(Value::as_str)
        .unwrap_or("file");
    let filename = file
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("audio.wav");
    let boundary = format!("----AntirionPlayground{}", call_request_id_fragment());
    let mut out = Vec::new();
    for (key, value) in obj {
        if key == PLAYGROUND_FILE {
            continue;
        }
        let text = value_to_field(value)?;
        push_field(&mut out, &boundary, key, &text, None);
    }
    push_field(&mut out, &boundary, field, "", Some((filename, &bytes)));
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let ct = HeaderValue::from_str(&format!("multipart/form-data; boundary={boundary}"))
        .map_err(|_| AdminError::internal())?;
    Ok((Bytes::from(out), ct))
}

fn call_request_id_fragment() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn value_to_field(v: &Value) -> Result<String, AdminError> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Ok(String::new()),
        _ => serde_json::to_string(v).map_err(|_| AdminError::invalid_parameter("field value is not JSON text")),
    }
}

fn push_field(
    out: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    value: &str,
    file: Option<(&str, &[u8])>,
) {
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    if let Some((filename, data)) = file {
        out.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n")
                .as_bytes(),
        );
        out.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
        out.extend_from_slice(data);
        out.extend_from_slice(b"\r\n");
    } else {
        out.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_split_and_parsed() {
        let text = "event: message_start\ndata: {\"a\":1}\n\ndata: [DONE]\n\n: comment\n\n";
        let e = events(text);
        assert_eq!(
            e,
            vec![
                json!({"event": "message_start", "data": {"a": 1}}),
                json!({"data": "[DONE]"})
            ]
        );
        assert_eq!(path_of("messages"), Some("/v1/messages"));
        assert_eq!(path_of("decisions"), Some("/v1/decisions"));
        assert_eq!(path_of("images"), None);
    }

    #[test]
    fn transcriptions_multipart_omits_the_playground_file_marker() {
        let body = json!({
            "model": "whisper",
            PLAYGROUND_FILE: {"field": "file", "filename": "a.wav", "data": "YQ=="}
        });
        let (bytes, ct) = multipart_transcriptions(body).unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("name=\"model\""));
        assert!(text.contains("name=\"file\""));
        assert!(text.contains("a"));
        assert!(!text.contains(PLAYGROUND_FILE));
        assert!(ct.to_str().unwrap().starts_with("multipart/form-data"));
    }
}
