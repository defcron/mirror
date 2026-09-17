//! JSON-patch application against the in-flight assistant message — port of
//! the `/message/...` patch arm of `ConversationStreamReducer` in
//! `packages/protocol/src/sse.ts`.
//!
//! ChatGPT's stream describes the growing message as a sequence of
//! compressed JSON-patch operations against a mutable message object. This
//! is the single most intricate piece of the protocol: it is reverse
//! engineered, undocumented, and a subtle divergence surfaces as garbled or
//! missing assistant output rather than a clean failure. Every branch below
//! mirrors a specific line of the original.

use serde_json::{Map, Value};

/// Keys refused outright, mirroring the TS prototype-pollution guard. In
/// Rust a `serde_json::Map` key cannot corrupt a prototype, but the check is
/// kept so a stream that includes these keys is treated identically (the
/// patch is dropped, not applied under a mangled name).
const REFUSED_KEYS: [&str; 3] = ["__proto__", "prototype", "constructor"];

/// Outcome of a patch application, so callers can distinguish "applied" from
/// "deliberately skipped" without inspecting the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchOutcome {
    Applied,
    Skipped,
}

fn is_index_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit())
}

/// Mirrors `key.replaceAll("~1", "/").replaceAll("~0", "~")`. The order
/// matters and is RFC 6901's: `~1` before `~0`, so `~01` decodes to `~1`
/// rather than `/`.
fn unescape_key(key: &str) -> String {
    key.replace("~1", "/").replace("~0", "~")
}

fn get<'a>(target: &'a Value, key: &str) -> Option<&'a Value> {
    match target {
        Value::Object(map) => map.get(key),
        // JS coerces a numeric string index on an array.
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    }
}

fn get_mut<'a>(target: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    match target {
        Value::Object(map) => map.get_mut(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get_mut(i)),
        _ => None,
    }
}

fn set(target: &mut Value, key: &str, value: Value) {
    match target {
        Value::Object(map) => {
            map.insert(key.to_string(), value);
        }
        Value::Array(items) => {
            if let Ok(index) = key.parse::<usize>() {
                // Assigning past the end grows the array with nulls, as JS does.
                if index >= items.len() {
                    items.resize(index + 1, Value::Null);
                }
                items[index] = value;
            }
        }
        _ => {}
    }
}

/// Applies one patch operation to `message`.
///
/// `path` is the full patch path (e.g. `/message/content/parts/0`), `op` is
/// `add`/`replace`/`append`/`remove`/`patch`, and `value` is the operand.
/// Returns whether the patch was applied.
///
/// Callers are expected to have already handled the `/message/status` and
/// `/message/id` paths, which the reducer treats specially.
pub fn apply_message_patch(
    message: &mut Value,
    path: &str,
    op: &str,
    value: &Value,
) -> PatchOutcome {
    let Some(rest) = path.strip_prefix("/message/") else {
        return PatchOutcome::Skipped;
    };

    // An append into content.parts before the parts array exists would
    // otherwise fabricate one and desynchronize the message shape, so
    // upstream drops it.
    if op == "append" && path.starts_with("/message/content/parts/") {
        let parts_is_array = message
            .get("content")
            .and_then(|c| c.get("parts"))
            .is_some_and(Value::is_array);
        if !parts_is_array {
            return PatchOutcome::Skipped;
        }
    }

    let keys: Vec<String> = rest.split('/').map(unescape_key).collect();
    if keys.iter().any(|key| REFUSED_KEYS.contains(&key.as_str())) {
        return PatchOutcome::Skipped;
    }
    let Some((last_key, parents)) = keys.split_last() else {
        return PatchOutcome::Skipped;
    };

    // Walk to the parent container, materializing missing intermediates as
    // an array when the next key looks like an index and an object
    // otherwise.
    let mut cursor = message;
    for (i, key) in parents.iter().enumerate() {
        let next_key = keys.get(i + 1).map(String::as_str).unwrap_or("");
        let needs_container = !get(cursor, key).is_some_and(|v| v.is_object() || v.is_array());
        if needs_container {
            let fresh = if is_index_key(next_key) {
                Value::Array(Vec::new())
            } else {
                Value::Object(Map::new())
            };
            set(cursor, key, fresh);
        }
        match get_mut(cursor, key) {
            Some(next) => cursor = next,
            // Only reachable when the parent is a scalar that `set` could
            // not write into; upstream would have thrown, so skip instead.
            None => return PatchOutcome::Skipped,
        }
    }

    match op {
        "remove" => match cursor {
            Value::Array(items) => {
                // JS `splice(Number(key), 1)` coerces a non-numeric key to
                // NaN, which splice treats as 0.
                let index = last_key.parse::<usize>().unwrap_or(0);
                if index < items.len() {
                    items.remove(index);
                }
            }
            Value::Object(map) => {
                map.remove(last_key.as_str());
            }
            _ => {}
        },

        "append" => {
            let existing = get(cursor, last_key);
            match (existing, value) {
                // String += string is the hot path: streamed text deltas.
                (Some(Value::String(current)), Value::String(addition)) => {
                    let combined = format!("{current}{addition}");
                    set(cursor, last_key, Value::String(combined));
                }
                (Some(Value::Array(current)), _) => {
                    let mut items = current.clone();
                    match value {
                        Value::Array(additions) => items.extend(additions.iter().cloned()),
                        single => items.push(single.clone()),
                    }
                    set(cursor, last_key, Value::Array(items));
                }
                // Appending onto anything else overwrites it.
                _ => set(cursor, last_key, value.clone()),
            }
        }

        _ => {
            // JSON Pointer's array-append token.
            if last_key == "-" && cursor.is_array() {
                if let Value::Array(items) = cursor {
                    items.push(value.clone());
                }
            } else {
                set(cursor, last_key, value.clone());
            }
        }
    }

    PatchOutcome::Applied
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message_with_parts(parts: Value) -> Value {
        json!({"content": {"parts": parts}})
    }

    fn apply(message: &mut Value, path: &str, op: &str, value: Value) -> PatchOutcome {
        apply_message_patch(message, path, op, &value)
    }

    #[test]
    fn a_path_outside_message_is_skipped() {
        let mut message = json!({});
        assert_eq!(
            apply(&mut message, "/conversation_id", "replace", json!("x")),
            PatchOutcome::Skipped
        );
        assert_eq!(message, json!({}));
    }

    #[test]
    fn replace_sets_a_nested_value() {
        let mut message = message_with_parts(json!(["hello"]));
        assert_eq!(
            apply(&mut message, "/message/content/parts/0", "replace", json!("goodbye")),
            PatchOutcome::Applied
        );
        assert_eq!(message, message_with_parts(json!(["goodbye"])));
    }

    #[test]
    fn append_concatenates_streamed_text_deltas() {
        // The hot path: each token arrives as an append of a string.
        let mut message = message_with_parts(json!([""]));
        for delta in ["Hel", "lo ", "world"] {
            apply(&mut message, "/message/content/parts/0", "append", json!(delta));
        }
        assert_eq!(message, message_with_parts(json!(["Hello world"])));
    }

    #[test]
    fn append_into_a_missing_parts_array_is_skipped() {
        // Guards the shape check: fabricating parts here would desynchronize
        // the message.
        for mut message in [
            json!({}),
            json!({"content": {}}),
            json!({"content": {"parts": "not-an-array"}}),
        ] {
            let before = message.clone();
            assert_eq!(
                apply(&mut message, "/message/content/parts/0", "append", json!("x")),
                PatchOutcome::Skipped
            );
            assert_eq!(message, before, "the message must be untouched");
        }
    }

    #[test]
    fn append_to_an_array_extends_it_and_spreads_an_array_operand() {
        let mut message = json!({"metadata": {"list": [1]}});
        apply(&mut message, "/message/metadata/list", "append", json!(2));
        assert_eq!(message, json!({"metadata": {"list": [1, 2]}}));
        // An array operand is spread, not nested.
        apply(&mut message, "/message/metadata/list", "append", json!([3, 4]));
        assert_eq!(message, json!({"metadata": {"list": [1, 2, 3, 4]}}));
    }

    #[test]
    fn append_onto_a_non_string_non_array_overwrites() {
        let mut message = json!({"metadata": {"count": 5}});
        apply(&mut message, "/message/metadata/count", "append", json!("text"));
        assert_eq!(message, json!({"metadata": {"count": "text"}}));
    }

    #[test]
    fn append_of_a_non_string_onto_a_string_overwrites_rather_than_coercing() {
        // Upstream requires BOTH sides to be strings to concatenate, so an
        // object operand replaces the text instead of being stringified --
        // "never stringify objects as text", per the original's comment.
        let mut message = message_with_parts(json!(["hello"]));
        apply(
            &mut message,
            "/message/content/parts/0",
            "append",
            json!({"asset_pointer": "sediment://s1"}),
        );
        assert_eq!(
            message,
            message_with_parts(json!([{"asset_pointer": "sediment://s1"}]))
        );
    }

    #[test]
    fn missing_intermediates_are_created_as_objects_or_arrays_by_the_next_key() {
        let mut message = json!({});
        apply(&mut message, "/message/metadata/citations/0/title", "replace", json!("t"));
        // `citations` became an array because the next key is numeric;
        // `metadata` and the array element became objects.
        assert_eq!(
            message,
            json!({"metadata": {"citations": [{"title": "t"}]}})
        );
    }

    #[test]
    fn a_scalar_intermediate_is_replaced_by_a_container() {
        let mut message = json!({"metadata": "was-a-string"});
        apply(&mut message, "/message/metadata/key", "replace", json!(1));
        assert_eq!(message, json!({"metadata": {"key": 1}}));

        // Null counts as needing replacement too.
        let mut message = json!({"metadata": null});
        apply(&mut message, "/message/metadata/key", "replace", json!(1));
        assert_eq!(message, json!({"metadata": {"key": 1}}));
    }

    #[test]
    fn an_existing_container_intermediate_is_preserved() {
        let mut message = json!({"metadata": {"keep": true}});
        apply(&mut message, "/message/metadata/added", "replace", json!(1));
        assert_eq!(message, json!({"metadata": {"keep": true, "added": 1}}));
    }

    #[test]
    fn remove_deletes_an_object_key_and_splices_an_array_element() {
        let mut message = json!({"metadata": {"a": 1, "b": 2}});
        apply(&mut message, "/message/metadata/a", "remove", Value::Null);
        assert_eq!(message, json!({"metadata": {"b": 2}}));

        let mut message = message_with_parts(json!(["a", "b", "c"]));
        apply(&mut message, "/message/content/parts/1", "remove", Value::Null);
        assert_eq!(message, message_with_parts(json!(["a", "c"])));
    }

    #[test]
    fn removing_an_out_of_range_or_non_numeric_array_index_is_survivable() {
        let mut message = message_with_parts(json!(["a"]));
        apply(&mut message, "/message/content/parts/9", "remove", Value::Null);
        assert_eq!(message, message_with_parts(json!(["a"])));

        // A non-numeric key coerces to index 0, matching splice(NaN, 1).
        let mut message = message_with_parts(json!(["a", "b"]));
        apply(&mut message, "/message/content/parts/x", "remove", Value::Null);
        assert_eq!(message, message_with_parts(json!(["b"])));
    }

    #[test]
    fn the_dash_token_appends_to_an_array() {
        let mut message = message_with_parts(json!(["a"]));
        apply(&mut message, "/message/content/parts/-", "add", json!("b"));
        assert_eq!(message, message_with_parts(json!(["a", "b"])));
    }

    #[test]
    fn a_dash_key_on_a_non_array_is_a_plain_assignment() {
        let mut message = json!({"metadata": {}});
        apply(&mut message, "/message/metadata/-", "add", json!(1));
        assert_eq!(message, json!({"metadata": {"-": 1}}));
    }

    #[test]
    fn prototype_polluting_keys_are_refused_anywhere_in_the_path() {
        for path in [
            "/message/__proto__",
            "/message/__proto__/x",
            "/message/metadata/constructor",
            "/message/prototype/y",
            "/message/a/prototype/b",
        ] {
            let mut message = json!({});
            assert_eq!(
                apply(&mut message, path, "replace", json!("bad")),
                PatchOutcome::Skipped,
                "{path} must be refused"
            );
            assert_eq!(message, json!({}), "{path} must not mutate the message");
        }
    }

    #[test]
    fn escaped_pointer_segments_are_decoded_in_rfc6901_order() {
        // ~1 becomes "/" and ~0 becomes "~"; decoding ~1 first means "~01"
        // yields "~1" rather than "/".
        let mut message = json!({});
        apply(&mut message, "/message/a~1b", "replace", json!(1));
        assert_eq!(message, json!({"a/b": 1}));

        let mut message = json!({});
        apply(&mut message, "/message/a~0b", "replace", json!(1));
        assert_eq!(message, json!({"a~b": 1}));

        let mut message = json!({});
        apply(&mut message, "/message/a~01b", "replace", json!(1));
        assert_eq!(message, json!({"a~1b": 1}));
    }

    #[test]
    fn assigning_past_the_end_of_an_array_grows_it_with_nulls() {
        let mut message = message_with_parts(json!(["a"]));
        apply(&mut message, "/message/content/parts/2", "replace", json!("c"));
        assert_eq!(message, message_with_parts(json!(["a", null, "c"])));
    }

    #[test]
    fn a_realistic_streamed_multipart_message_reconstructs_correctly() {
        // Exercises the sequence a real turn produces: the parts array is
        // created, text streams in, then an image part is appended.
        let mut message = json!({});
        apply(&mut message, "/message/content/parts/0", "replace", json!(""));
        for delta in ["Here ", "is ", "a chart:"] {
            apply(&mut message, "/message/content/parts/0", "append", json!(delta));
        }
        apply(
            &mut message,
            "/message/content/parts/-",
            "add",
            json!({"asset_pointer": "sediment://chart", "content_type": "image_asset_pointer"}),
        );
        apply(&mut message, "/message/metadata/finish", "replace", json!("stop"));

        assert_eq!(
            message,
            json!({
                "content": {"parts": [
                    "Here is a chart:",
                    {"asset_pointer": "sediment://chart", "content_type": "image_asset_pointer"}
                ]},
                "metadata": {"finish": "stop"}
            })
        );
    }
}
