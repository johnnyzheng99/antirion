//! The configuration rules of `api.custom_endpoints`: each path is a plain, normalised path that no
//! catalog endpoint, probe, MCP or A2A route, passthrough mount or other custom endpoint serves, and
//! each operation path is a plain path.

use antirion_config::{ConfigError, DetailCode, DocPath};
use antirion_dialects::{Matched, match_endpoint, normalise};
use http::Method;
use serde_json::Value;

/// First path segments the gateway keeps for itself whatever the catalog answers below them.
const RESERVED: &[&str] = &["-", "mcp", "a2a", ".well-known", "model", "antirion", "admin"];

fn dot_segment(path: &str) -> bool {
    path.split('/').any(|s| matches!(s, "." | ".."))
}

/// Whether `path` is a passthrough mount's prefix or a path below it.
fn under_mount(doc: &Value, path: &str) -> Option<String> {
    let mounts = doc.pointer("/api/passthrough")?.as_object()?;
    mounts.iter().find_map(|(name, m)| {
        let prefix = m.get("path_prefix")?.as_str()?.trim_end_matches('/');
        let rest = path.strip_prefix(prefix)?;
        (!prefix.is_empty() && (rest.is_empty() || rest.starts_with('/'))).then(|| name.clone())
    })
}

/// Why the catalog keeps `path`, if it does.
fn catalog_conflict(path: &str) -> Option<&'static str> {
    if path
        .split('/')
        .nth(1)
        .is_some_and(|first| RESERVED.contains(&first))
    {
        return Some("the path is reserved for the gateway");
    }
    match match_endpoint(&Method::POST, path) {
        Matched::Found(_) | Matched::MethodNotAllowed(_) => Some("a built-in endpoint serves this path"),
        Matched::InvalidPath => Some("the path is not a plain path"),
        Matched::NotFound | Matched::NotSupported => None,
    }
}

#[must_use]
pub fn check_document(doc: &Value) -> Vec<ConfigError> {
    let mut errors = Vec::new();
    let Some(endpoints) = doc.pointer("/api/custom_endpoints").and_then(Value::as_object) else {
        return errors;
    };
    let base = DocPath::root().key("api").key("custom_endpoints");
    let mut seen: Vec<(&str, &String)> = Vec::new();
    for (name, e) in endpoints {
        let at = base.key(name);
        if let Some(up) = e.get("upstream_path").and_then(Value::as_str)
            && (dot_segment(up) || up.contains("//"))
        {
            errors.push(ConfigError::new(
                &at.key("upstream_path"),
                DetailCode::Conflict,
                "the operation path must not have empty, `.` or `..` segments",
            ));
        }
        let Some(path) = e.get("path").and_then(Value::as_str) else {
            continue;
        };
        let problem = if normalise(path).as_deref() != Some(path) || dot_segment(path) {
            Some(
                "the path is not in its normal form (no provider prefix, `.`, `..` or empty segments)"
                    .to_owned(),
            )
        } else if let Some(why) = catalog_conflict(path) {
            Some(why.to_owned())
        } else if let Some(mount) = under_mount(doc, path) {
            Some(format!("the path falls under passthrough mount {mount:?}"))
        } else {
            seen.iter()
                .find(|(p, _)| *p == path)
                .map(|(_, other)| format!("custom endpoint {other:?} has the same path"))
        };
        match problem {
            Some(why) => errors.push(ConfigError::new(&at.key("path"), DetailCode::Conflict, why)),
            None => seen.push((path, name)),
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn paths(doc: &Value) -> Vec<String> {
        check_document(doc).into_iter().map(|e| e.path).collect()
    }

    #[test]
    fn paths_are_checked() {
        let doc = json!({"api": {
            "passthrough": {"raw": {"path_prefix": "/raw", "provider": "p"}},
            "custom_endpoints": {
                "ok": {"path": "/v1/music/generate"},
                "plain": {"path": "/audio/run", "upstream_path": "/run"},
                "builtin": {"path": "/v1/chat/completions"},
                "decisions": {"path": "/v1/decisions"},
                "files": {"path": "/v1/files/x/y"},
                "dup": {"path": "/v1/music/generate"},
                "mount": {"path": "/raw/x"},
                "probe": {"path": "/-/x"},
                "mcp": {"path": "/mcp/a/b"},
                "dots": {"path": "/v1/../x"},
                "prefix": {"path": "/openai/v1/music"},
                "trailing": {"path": "/v1/music/"},
                "upstream": {"path": "/v1/up", "upstream_path": "/a/../b"}
            }
        }});
        let got = paths(&doc);
        for want in [
            "api.custom_endpoints.builtin.path",
            "api.custom_endpoints.decisions.path",
            "api.custom_endpoints.dup.path",
            "api.custom_endpoints.mount.path",
            "api.custom_endpoints.probe.path",
            "api.custom_endpoints.mcp.path",
            "api.custom_endpoints.dots.path",
            "api.custom_endpoints.prefix.path",
            "api.custom_endpoints.trailing.path",
            "api.custom_endpoints.upstream.upstream_path",
        ] {
            assert!(got.iter().any(|p| p == want), "{want} not in {got:?}");
        }
        for fine in ["ok", "plain", "files"] {
            assert!(
                !got.iter()
                    .any(|p| p.starts_with(&format!("api.custom_endpoints.{fine}."))),
                "{fine}: {got:?}"
            );
        }
    }
}
