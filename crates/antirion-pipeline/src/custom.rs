//! Custom endpoints (`api.custom_endpoints`): a path the operator adds, served like a catalog
//! inference endpoint. The JSON body names its `model`, which resolves and routes as on any other
//! endpoint (access, limits, retries, fallbacks, the record), and the body is forwarded as it is, with
//! the deployment's model id, to the endpoint's operation path below the deployment's base URL.

use http::Method;
use serde_json::Value;

/// A custom endpoint the request path names: its name, its operation path and its methods.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Matched {
    pub(crate) name: String,
    pub(crate) upstream: String,
    pub(crate) methods: Vec<Method>,
}

/// The operation path of a custom endpoint at `path` without an `upstream_path`: the path without
/// its leading `/v1`, since OpenAI-family base URLs end in `/v1`.
#[must_use]
pub(crate) fn default_upstream(path: &str) -> &str {
    match path.strip_prefix("/v1") {
        Some(rest) if rest.starts_with('/') => rest,
        _ => path,
    }
}

/// The enabled custom endpoint whose path is the normalised request path.
pub(crate) fn matched(api: Option<&Value>, path: &str) -> Option<Matched> {
    let endpoints = api?.get("custom_endpoints")?.as_object()?;
    endpoints.iter().find_map(|(name, e)| {
        if e.get("enabled") == Some(&Value::Bool(false)) {
            return None;
        }
        let own = e.get("path").and_then(Value::as_str)?.trim_end_matches('/');
        if own != path {
            return None;
        }
        let upstream = e
            .get("upstream_path")
            .and_then(Value::as_str)
            .unwrap_or_else(|| default_upstream(own))
            .to_owned();
        let methods = match e.get("methods").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|m| Method::from_bytes(m.as_bytes()).ok())
                .collect(),
            None => vec![Method::POST],
        };
        Some(Matched {
            name: name.clone(),
            upstream,
            methods,
        })
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn paths_match_exactly_and_take_their_operation_path() {
        let api = json!({"custom_endpoints": {
            "music": {"path": "/v1/music/generate"},
            "tts": {"path": "/v1/voice", "upstream_path": "/speak", "methods": ["POST", "PUT"]},
            "off": {"path": "/v1/off", "enabled": false},
            "raw": {"path": "/audio/run"}
        }});
        let m = matched(Some(&api), "/v1/music/generate").unwrap();
        assert_eq!(
            (m.name.as_str(), m.upstream.as_str(), m.methods),
            ("music", "/music/generate", vec![Method::POST])
        );
        let t = matched(Some(&api), "/v1/voice").unwrap();
        assert_eq!(
            (t.upstream.as_str(), t.methods),
            ("/speak", vec![Method::POST, Method::PUT])
        );
        assert_eq!(matched(Some(&api), "/v1/off"), None);
        assert_eq!(matched(Some(&api), "/v1/music"), None);
        assert_eq!(matched(Some(&api), "/v1/music/generate/x"), None);
        assert_eq!(matched(Some(&api), "/audio/run").unwrap().upstream, "/audio/run");
        assert_eq!(matched(None, "/v1/voice"), None);
    }

    #[test]
    fn the_default_operation_path_drops_v1() {
        assert_eq!(default_upstream("/v1/tasks/run"), "/tasks/run");
        assert_eq!(default_upstream("/v1beta/x"), "/v1beta/x");
        assert_eq!(default_upstream("/v1"), "/v1");
        assert_eq!(default_upstream("/x/v1/y"), "/x/v1/y");
    }
}
