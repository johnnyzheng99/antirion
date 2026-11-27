//! Cloudflare Workers AI: which operations use native `POST .../ai/run/{model}` vs OpenAI `/ai/v1/...`.

use serde_json::Value;
use std::borrow::Cow;

/// Operation classes routed to `/run/{model}` on the account AI base (not `/v1/...`).
#[must_use]
pub fn workers_ai_run_class(class: &str) -> bool {
    matches!(
        class,
        "decide" | "systemone" | "rerank" | "speech" | "transcribe"
    )
}

/// The inner payload of a Workers AI REST response (`{ success, result }`), when present.
#[must_use]
pub fn peel_envelope<'a>(v: &'a Value) -> Cow<'a, Value> {
    let Some(result) = v.get("result") else {
        return Cow::Borrowed(v);
    };
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return Cow::Borrowed(v);
    }
    Cow::Borrowed(result)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn run_classes() {
        assert!(workers_ai_run_class("rerank"));
        assert!(workers_ai_run_class("speech"));
        assert!(!workers_ai_run_class("generate"));
        assert!(!workers_ai_run_class("embed"));
    }

    #[test]
    fn peel() {
        let wrapped = json!({"success": true, "result": {"text": "hi"}});
        assert_eq!(peel_envelope(&wrapped)["text"], "hi");
        let bare = json!({"text": "hi"});
        assert_eq!(peel_envelope(&bare)["text"], "hi");
        let err = json!({"success": false, "result": {"text": "hi"}});
        assert_eq!(&*peel_envelope(&err), &err);
    }
}