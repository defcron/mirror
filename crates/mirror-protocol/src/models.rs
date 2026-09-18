//! Normalization of model and gizmo catalogs from backend-api payloads.
//! Port of `packages/protocol/src/models.ts`.

use crate::types::{GizmoSummary, ModelDescriptor};
use serde_json::Value;
use std::collections::HashSet;

/// Normalizes the evolving gizmo/sidebar payload without depending on one response envelope.
pub fn normalize_gizmos(raw: &Value) -> Vec<GizmoSummary> {
    let mut candidates: Vec<Value> = Vec::new();
    let mut visited_ptrs: HashSet<usize> = HashSet::new();

    fn visit(val: &Value, candidates: &mut Vec<Value>, visited_ptrs: &mut HashSet<usize>) {
        if !val.is_object() && !val.is_array() {
            return;
        }
        let ptr = val as *const Value as usize;
        if visited_ptrs.contains(&ptr) {
            return;
        }
        visited_ptrs.insert(ptr);

        if let Value::Array(arr) = val {
            for item in arr {
                visit(item, candidates, visited_ptrs);
            }
            return;
        }

        if let Value::Object(obj) = val {
            let outer = obj.get("gizmo").and_then(Value::as_object);
            let nested_core = outer
                .and_then(|o| o.get("gizmo"))
                .and_then(Value::as_object);
            let core = nested_core.or_else(|| {
                if obj.get("id").and_then(Value::as_str).is_some() {
                    Some(obj)
                } else {
                    None
                }
            });

            let display = core
                .and_then(|c| c.get("display"))
                .and_then(Value::as_object);

            if let Some(core_map) = core
                && core_map.get("id").and_then(Value::as_str).is_some()
            {
                if let Some(disp_map) = display {
                    if let Some(name) = disp_map.get("name").and_then(Value::as_str) {
                        let mut merged = core_map.clone();
                        merged.insert("display_name".to_string(), Value::String(name.to_string()));
                        if let Some(desc) = disp_map.get("description") {
                            merged.insert("description".to_string(), desc.clone());
                        }
                        if let Some(pic) = disp_map.get("profile_picture_url") {
                            merged.insert("profile_picture_url".to_string(), pic.clone());
                        }
                        if nested_core.is_some()
                            && let Some(files) =
                                outer.and_then(|o| o.get("files")).filter(|f| f.is_array())
                        {
                            merged.insert("files".to_string(), files.clone());
                        }
                        candidates.push(Value::Object(merged));
                    }
                } else if core_map
                    .get("display_name")
                    .and_then(Value::as_str)
                    .is_some()
                {
                    let has_extra = core_map.contains_key("short_url")
                        || core_map.contains_key("instructions")
                        || core_map.contains_key("author")
                        || core_map.contains_key("profile_picture_url")
                        || core_map.contains_key("tools");
                    if has_extra {
                        candidates.push(Value::Object(core_map.clone()));
                    }
                }
            }

            for child in obj.values() {
                visit(child, candidates, visited_ptrs);
            }
        }
    }

    visit(raw, &mut candidates, &mut visited_ptrs);

    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut summaries: Vec<GizmoSummary> = Vec::new();

    for item in candidates {
        let Some(id) = item.get("id").and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }) else {
            continue;
        };

        if seen_ids.contains(&id) {
            continue;
        }
        seen_ids.insert(id.clone());

        let name = item
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        let short_url = item
            .get("short_url")
            .and_then(Value::as_str)
            .map(str::to_string);
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string);
        let icon_url = item
            .get("profile_picture_url")
            .and_then(Value::as_str)
            .map(str::to_string);
        let files_count = item.get("files").and_then(Value::as_array).map(|a| a.len());

        summaries.push(GizmoSummary {
            id,
            short_url,
            name,
            description,
            icon_url,
            files_count,
            raw: item,
        });
    }

    summaries
}

/// Normalizes `/models` into clean ModelDescriptor entries, deduplicating by slug.
pub fn normalize_models(raw: &Value) -> Vec<ModelDescriptor> {
    let Some(models) = raw.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut descriptors: Vec<ModelDescriptor> = Vec::new();

    for value in models {
        let Some(obj) = value.as_object() else {
            continue;
        };
        let Some(slug) = obj.get("slug").and_then(Value::as_str) else {
            continue;
        };

        if seen.contains(slug) {
            continue;
        }
        seen.insert(slug.to_string());

        let title = obj
            .get("title")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .unwrap_or(slug)
            .to_string();

        let description = obj
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string);
        let max_tokens = obj.get("max_tokens").and_then(Value::as_u64);
        let capabilities = obj.get("capabilities").cloned();
        let enabled_tools = obj.get("enabled_tools").cloned();

        descriptors.push(ModelDescriptor {
            id: slug.to_string(),
            title,
            description,
            max_tokens,
            capabilities,
            enabled_tools,
            raw: value.clone(),
        });
    }

    descriptors
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_models_deduplicates_and_maps_fields() {
        let raw = json!({
            "models": [
                {
                    "slug": "gpt-4o",
                    "title": "GPT-4o",
                    "description": "Our high-intelligence flagship model",
                    "max_tokens": 4096
                },
                {
                    "slug": "gpt-4o",
                    "title": "Duplicate"
                },
                {
                    "slug": "o1-preview"
                }
            ]
        });

        let descriptors = normalize_models(&raw);
        assert_eq!(descriptors.len(), 2);
        assert_eq!(descriptors[0].id, "gpt-4o");
        assert_eq!(descriptors[0].title, "GPT-4o");
        assert_eq!(descriptors[0].max_tokens, Some(4096));
        assert_eq!(descriptors[1].id, "o1-preview");
        assert_eq!(descriptors[1].title, "o1-preview");
    }

    #[test]
    fn normalize_gizmos_extracts_nested_and_display_objects() {
        let raw = json!({
            "gizmos": [
                {
                    "gizmo": {
                        "gizmo": {
                            "id": "g-12345",
                            "display": {
                                "name": "Code Reviewer",
                                "description": "Reviews code",
                                "profile_picture_url": "https://example.com/pic.png"
                            }
                        },
                        "files": [{}, {}]
                    }
                }
            ]
        });

        let gizmos = normalize_gizmos(&raw);
        assert_eq!(gizmos.len(), 1);
        assert_eq!(gizmos[0].id, "g-12345");
        assert_eq!(gizmos[0].name, "Code Reviewer");
        assert_eq!(gizmos[0].description.as_deref(), Some("Reviews code"));
        assert_eq!(gizmos[0].files_count, Some(2));
    }
}
