//! `params` blocks: JSON Pointer removals, defaults and overrides applied to the upstream body.

use antirion_config::{ConfigError, DetailCode, DocPath};
use serde_json::{Map, Value};

/// One validated pointer: its source text and its unescaped reference tokens.
#[derive(Clone, Debug, PartialEq)]
pub struct Pointer {
    pub text: String,
    tokens: Vec<String>,
}

/// A compiled `params` block. Entries of each list are in ascending byte order of the pointer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Params {
    pub remove: Vec<Pointer>,
    pub defaults: Vec<(Pointer, Value)>,
    pub overrides: Vec<(Pointer, Value)>,
}

/// The level whose `params` block made a change.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Provider,
    Deployment,
}

impl Source {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Provider => "provider",
            Source::Deployment => "deployment",
        }
    }
}

/// What an entry did to the body.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// A `remove` entry took a member out.
    Removed,
    /// A `defaults` entry set a member the body did not have.
    Default,
    /// An `overrides` entry set a member, replacing what the body had, if anything.
    Override,
}

impl Action {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Removed => "removed",
            Action::Default => "default",
            Action::Override => "override",
        }
    }
}

/// One change a `params` entry made to a body: where it came from, what it did at which pointer,
/// the value it set (none for a removal) and the value the body had there before (none when the
/// member was absent).
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub source: Source,
    pub action: Action,
    pub pointer: String,
    pub value: Option<Value>,
    pub previous: Option<Value>,
}

/// What changed a body, for the request log: the pointers by kind, and each change in application
/// order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Applied {
    pub overrides: Vec<String>,
    pub removed: Vec<String>,
    pub defaults: Vec<String>,
    pub changes: Vec<Change>,
}

impl Applied {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

fn parse_pointer(text: &str) -> Result<Pointer, &'static str> {
    let Some(rest) = text.strip_prefix('/') else {
        return Err("a JSON Pointer starts with \"/\"");
    };
    let tokens: Vec<String> = rest
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    if tokens.iter().any(|t| t == "-") {
        return Err("the \"-\" array token is not allowed");
    }
    if matches!(tokens.as_slice(), [one] if one == "model" || one == "stream") {
        return Err("the upstream model and streaming are not parameters");
    }
    Ok(Pointer {
        text: text.to_owned(),
        tokens,
    })
}

impl Params {
    /// Compiles a `params` block at `at`, collecting every invalid entry.
    pub fn compile(block: Option<&Value>, at: &DocPath, errors: &mut Vec<ConfigError>) -> Params {
        let mut out = Params::default();
        let Some(block) = block else { return out };
        let mut pointer = |text: &str, list: &str| match parse_pointer(text) {
            Ok(p) => Some(p),
            Err(why) => {
                errors.push(ConfigError::new(
                    &at.key(list).key(text),
                    DetailCode::InvalidFormat,
                    why,
                ));
                None
            }
        };
        for v in block
            .get("remove")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(p) = v.as_str().and_then(|t| pointer(t, "remove")) {
                out.remove.push(p);
            }
        }
        for (list, slot) in [("defaults", &mut out.defaults), ("overrides", &mut out.overrides)] {
            for (k, v) in block.get(list).and_then(Value::as_object).into_iter().flatten() {
                if let Some(p) = pointer(k, list) {
                    slot.push((p, v.clone()));
                }
            }
        }
        out.remove.sort_by(|a, b| a.text.cmp(&b.text));
        out.defaults.sort_by(|a, b| a.0.text.cmp(&b.0.text));
        out.overrides.sort_by(|a, b| a.0.text.cmp(&b.0.text));
        out
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.remove.is_empty() && self.defaults.is_empty() && self.overrides.is_empty()
    }

    /// Applies the block of `source`: removals, then defaults, then overrides, recording each
    /// change. An entry whose parent is not a container is skipped, and so is an override that sets
    /// the value the body already had.
    pub fn apply(&self, body: &mut Value, applied: &mut Applied, source: Source) {
        let change = |action, pointer: &Pointer, value: Option<&Value>, previous| Change {
            source,
            action,
            pointer: pointer.text.clone(),
            value: value.cloned(),
            previous,
        };
        for p in &self.remove {
            if let Some(previous) = remove(body, &p.tokens) {
                applied.removed.push(p.text.clone());
                applied
                    .changes
                    .push(change(Action::Removed, p, None, Some(previous)));
            }
        }
        for (p, v) in &self.defaults {
            if set(body, &p.tokens, v, false).is_some() {
                applied.defaults.push(p.text.clone());
                applied.changes.push(change(Action::Default, p, Some(v), None));
            }
        }
        for (p, v) in &self.overrides {
            if let Some(previous) = set(body, &p.tokens, v, true)
                && previous.as_ref() != Some(v)
            {
                applied.overrides.push(p.text.clone());
                applied
                    .changes
                    .push(change(Action::Override, p, Some(v), previous));
            }
        }
    }
}

fn parent_mut<'a>(body: &'a mut Value, tokens: &[String], create: bool) -> Option<&'a mut Value> {
    let (_, parents) = tokens.split_last()?;
    let mut cur = body;
    for t in parents {
        cur = match cur {
            Value::Object(m) => {
                if create && !m.contains_key(t) {
                    m.insert(t.clone(), Value::Object(Map::new()));
                }
                m.get_mut(t)?
            }
            Value::Array(a) => a.get_mut(t.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// Removes the member at `tokens`, returning the value it had.
fn remove(body: &mut Value, tokens: &[String]) -> Option<Value> {
    let last = tokens.last()?;
    match parent_mut(body, tokens, false)? {
        Value::Object(m) => m.remove(last),
        Value::Array(a) => match last.parse::<usize>() {
            Ok(i) if i < a.len() => Some(a.remove(i)),
            _ => None,
        },
        _ => None,
    }
}

/// Sets the member at `tokens` (only when absent unless `replace`). `None` when nothing was set,
/// else the value the member had before (`Some(None)` when it was absent).
fn set(body: &mut Value, tokens: &[String], v: &Value, replace: bool) -> Option<Option<Value>> {
    let last = tokens.last()?;
    match parent_mut(body, tokens, true) {
        Some(Value::Object(m)) => {
            if !replace && m.contains_key(last) {
                return None;
            }
            Some(m.insert(last.clone(), v.clone()))
        }
        Some(Value::Array(a)) => match last.parse::<usize>().ok().and_then(|i| a.get_mut(i)) {
            Some(slot) if replace => Some(Some(std::mem::replace(slot, v.clone()))),
            _ => None,
        },
        _ => {
            tracing::debug!(
                pointer = tokens.join("/"),
                "params entry skipped: parent is not a container"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn params(v: Value) -> (Params, Vec<ConfigError>) {
        let mut errors = Vec::new();
        let p = Params::compile(Some(&v), &DocPath::root().key("params"), &mut errors);
        (p, errors)
    }

    #[test]
    fn order_and_semantics() {
        let (p, errors) = params(json!({
            "remove": ["/temperature", "/missing"],
            "defaults": {"/temperature": 0.2, "/top_p": 0.5, "/metadata/team": "s"},
            "overrides": {"/top_p": 0.7, "/messages/role": "x", "/n": null},
        }));
        assert!(errors.is_empty());
        let mut body = json!({"temperature": 0.9, "messages": [{"role": "user"}]});
        let mut applied = Applied::default();
        p.apply(&mut body, &mut applied, Source::Deployment);
        assert_eq!(
            body,
            json!({"temperature": 0.2, "top_p": 0.7, "metadata": {"team": "s"}, "n": null,
                   "messages": [{"role": "user"}]})
        );
        assert_eq!(applied.removed, ["/temperature"]);
        assert_eq!(applied.defaults, ["/metadata/team", "/temperature", "/top_p"]);
        assert_eq!(applied.overrides, ["/n", "/top_p"]);
        let seen: Vec<_> = applied
            .changes
            .iter()
            .map(|c| {
                (
                    c.action.as_str(),
                    c.pointer.as_str(),
                    c.value.clone(),
                    c.previous.clone(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                ("removed", "/temperature", None, Some(json!(0.9))),
                ("default", "/metadata/team", Some(json!("s")), None),
                ("default", "/temperature", Some(json!(0.2)), None),
                ("default", "/top_p", Some(json!(0.5)), None),
                ("override", "/n", Some(Value::Null), None),
                ("override", "/top_p", Some(json!(0.7)), Some(json!(0.5))),
            ]
        );
        assert!(applied.changes.iter().all(|c| c.source == Source::Deployment));
    }

    #[test]
    fn an_override_to_the_same_value_is_no_change() {
        let (p, _) = params(json!({"overrides": {"/temperature": 0.2, "/messages/0/role": "user"}}));
        let mut body = json!({"temperature": 0.2, "messages": [{"role": "user"}]});
        let mut applied = Applied::default();
        p.apply(&mut body, &mut applied, Source::Provider);
        assert!(applied.is_empty(), "{applied:?}");
    }

    #[test]
    fn invalid_pointers() {
        for bad in [
            json!({"overrides": {"/stream": true}}),
            json!({"remove": ["/model"]}),
            json!({"overrides": {"/messages/-": 1}}),
            json!({"defaults": {"temperature": 1}}),
        ] {
            assert_eq!(params(bad).1.len(), 1);
        }
        let mut body = json!({"messages": [{"a": 1}]});
        let (p, _) = params(json!({"overrides": {"/messages/0/a": 2}}));
        p.apply(&mut body, &mut Applied::default(), Source::Provider);
        assert_eq!(body, json!({"messages": [{"a": 2}]}));
    }
}
