//! Orchestration service for conversation turns, streaming, active-turn tracking, and persistence.
//! Port of `apps/server/src/chat-service.ts`.

use crate::auth::{AuthError, get_valid_credentials};
use crate::deadlines::TurnDeadline;
use mirror_protocol::http::build_client;
use mirror_protocol::types::{SendMessageResult, UploadedFile};
use mirror_protocol::{ChatGptBackendClient, NormalizedConversationEvent, SendMessageOptions};
use mirror_store::conversations::NewConversation;
use mirror_store::{Store, StoreError, StoredConversation};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

static ACTIVE_TURNS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Derives a clean conversation title from the first prompt turn.
pub fn title_from_prompt(prompt: &str) -> String {
    let one_line: String = prompt.split_whitespace().collect::<Vec<&str>>().join(" ");
    let trimmed = one_line.trim();
    if trimmed.chars().count() > 54 {
        let truncated: String = trimmed.chars().take(53).collect();
        format!("{truncated}…")
    } else if trimmed.is_empty() {
        "New chat".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Request cancellation for a running conversation turn. Returns true if an active turn was found and cancelled.
pub fn stop_conversation(id: &str) -> bool {
    let mut turns = ACTIVE_TURNS.lock().expect("active turns mutex");
    if let Some(token) = turns.remove(id) {
        token.cancel();
        true
    } else {
        false
    }
}

pub type DeltaCallback = Box<dyn Fn(&str, &str) + Send + Sync>;
pub type EventCallback = Box<dyn Fn(&NormalizedConversationEvent) + Send + Sync>;

pub struct RunChatOptions {
    pub conversation_id: Option<String>,
    pub new_conversation_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub gizmo_id: Option<String>,
    pub timezone: Option<String>,
    pub timezone_offset_min: Option<i32>,
    pub attachments: Vec<UploadedFile>,
    pub private: bool,
    pub ephemeral: bool,
    pub turnstile_token: Option<String>,
    pub on_delta: Option<DeltaCallback>,
    pub on_event: Option<EventCallback>,
    pub cancel_token: Option<CancellationToken>,
}

#[derive(Debug, Clone)]
pub struct RunChatOutcome {
    pub conversation: StoredConversation,
    pub result: SendMessageResult,
    pub stored_assistant_message_id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ChatServiceError {
    #[error("Conversation not found")]
    NotFound,
    #[error("A response is already running for this conversation")]
    Conflict,
    #[error("Generation stopped")]
    Stopped,
    #[error("Storage error: {0}")]
    Store(#[from] StoreError),
    #[error("Authentication error: {0}")]
    Auth(#[from] AuthError),
    #[error("Backend API error: {0}")]
    Backend(String),
}

/// Runs a conversational chat turn end-to-end: manages conversation state,
/// tracks active-turn cancellation, records messages, streams responses from
/// ChatGPT, and updates local message history upon completion.
pub async fn run_chat(
    store: &Store,
    opts: RunChatOptions,
) -> Result<RunChatOutcome, ChatServiceError> {
    let revision = store.session_revision();
    let transient = opts.ephemeral;

    let session = store.session()?;
    let account_id = session
        .as_ref()
        .and_then(|s| s.account_id.clone())
        .unwrap_or_else(|| "default".to_string());

    let mut conversation = if transient {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        StoredConversation {
            id: Uuid::new_v4().to_string(),
            account_id: account_id.clone(),
            model: opts.model.clone().unwrap_or_else(|| "auto".to_string()),
            conversation_id: None,
            current_node_id: "client-created-root".to_string(),
            gizmo_id: opts.gizmo_id.clone(),
            initialized: false,
            private: true,
            is_branch: false,
            title: "One-shot".to_string(),
            created_at: now.clone(),
            updated_at: now,
            init: None,
        }
    } else if let Some(cid) = &opts.conversation_id {
        let conv = store.conversation(cid)?.ok_or(ChatServiceError::NotFound)?;
        if conv.account_id != account_id {
            return Err(ChatServiceError::NotFound);
        }
        conv
    } else {
        let title = title_from_prompt(&opts.prompt);
        store.create_conversation(NewConversation {
            id: opts.new_conversation_id.clone(),
            model: opts.model.clone().unwrap_or_else(|| "auto".to_string()),
            gizmo_id: opts.gizmo_id.clone(),
            private: opts.private || opts.ephemeral,
            title: Some(title),
            account_id: Some(account_id.clone()),
        })?
    };

    let conv_id = conversation.id.clone();

    // Check if another turn is already running for this conversation.
    {
        let mut turns = ACTIVE_TURNS.lock().expect("active turns mutex");
        if turns.contains_key(&conv_id) {
            return Err(ChatServiceError::Conflict);
        }
        let cancel_token = opts.cancel_token.clone().unwrap_or_default();
        turns.insert(conv_id.clone(), cancel_token);
    }

    let deadline = TurnDeadline::new({
        let conv_id = conv_id.clone();
        move || {
            stop_conversation(&conv_id);
        }
    });

    let empty_events = serde_json::json!([]);

    let user_msg_id = if transient {
        Uuid::new_v4().to_string()
    } else {
        let attachments_val = serde_json::to_value(&opts.attachments).unwrap_or_default();
        let user_msg = store.add_message(
            &conv_id,
            None,
            "user",
            &opts.prompt,
            "done",
            &empty_events,
            Some(&attachments_val),
            None,
        )?;
        user_msg.id
    };

    let assistant_msg_id = if transient {
        Uuid::new_v4().to_string()
    } else {
        let assistant_msg = store.add_message(
            &conv_id,
            None,
            "assistant",
            "",
            "streaming",
            &empty_events,
            None,
            None,
        )?;
        assistant_msg.id
    };

    let full_text = String::new();
    let _events: Arc<Mutex<Vec<NormalizedConversationEvent>>> = Arc::new(Mutex::new(Vec::new()));

    let creds = match get_valid_credentials(store).await {
        Ok(c) => c,
        Err(e) => {
            if !transient {
                let _ = store.update_message(&assistant_msg_id, "", "error", None, &empty_events);
            }
            deadline.close();
            ACTIVE_TURNS
                .lock()
                .expect("active turns mutex")
                .remove(&conv_id);
            return Err(e.into());
        }
    };

    store.assert_session_revision(revision)?;

    let http_client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            deadline.close();
            ACTIVE_TURNS
                .lock()
                .expect("active turns mutex")
                .remove(&conv_id);
            return Err(ChatServiceError::Backend(e.to_string()));
        }
    };

    let client = ChatGptBackendClient::new(http_client, creds);

    // If conversation is not initialized, run initialization.
    if !conversation.initialized {
        let init_model = if conversation.model == "auto" {
            None
        } else {
            Some(conversation.model.as_str())
        };

        if let Ok(init_res) = client
            .init_conversation(
                opts.timezone.as_deref().unwrap_or("UTC"),
                opts.timezone_offset_min.unwrap_or(0),
                conversation.gizmo_id.as_deref(),
                init_model,
                conversation.conversation_id.as_deref(),
                conversation.private,
            )
            .await
        {
            if conversation.model == "auto"
                && let Some(slug) = init_res
                    .default_model_slug
                    .or(init_res.intended_default_model_slug)
            {
                conversation.model = slug;
            }
            conversation.initialized = true;
            if !transient {
                let _ = store.update_conversation(&conversation);
            }
        }
    }

    let on_delta_binding = opts
        .on_delta
        .as_deref()
        .map(|f| f as &(dyn Fn(&str, &str) + Send + Sync));
    let on_event_binding = opts
        .on_event
        .as_deref()
        .map(|f| f as &(dyn Fn(&NormalizedConversationEvent) + Send + Sync));

    let send_opts = SendMessageOptions {
        prompt: &opts.prompt,
        model: &conversation.model,
        conversation_id: conversation.conversation_id.as_deref(),
        parent_message_id: Some(&conversation.current_node_id),
        timezone: opts.timezone.as_deref(),
        timezone_offset_min: opts.timezone_offset_min,
        gizmo_id: conversation.gizmo_id.as_deref(),
        gizmo_payload: None,
        attachments: &opts.attachments,
        history_and_training_disabled: conversation.private,
        turnstile_token: opts.turnstile_token.as_deref(),
        on_delta: on_delta_binding,
        on_event: on_event_binding,
    };

    let send_res = client.send_message(send_opts).await;

    deadline.close();
    ACTIVE_TURNS
        .lock()
        .expect("active turns mutex")
        .remove(&conv_id);

    match send_res {
        Ok(result) => {
            store.assert_session_revision(revision)?;
            conversation.conversation_id = result.conversation_id.clone();
            if let Some(msg_id) = &result.message_id {
                conversation.current_node_id = msg_id.clone();
            }
            if !transient {
                let _ = store.update_conversation(&conversation);
                let _ = store.update_message(
                    &user_msg_id,
                    &opts.prompt,
                    "done",
                    Some(&result.user_message_id),
                    &empty_events,
                );
                let final_events = serde_json::to_value(&result.events).unwrap_or_default();
                let _ = store.update_message(
                    &assistant_msg_id,
                    &result.text,
                    result.status.as_deref().unwrap_or("done"),
                    result.message_id.as_deref(),
                    &final_events,
                );
            }

            Ok(RunChatOutcome {
                conversation,
                result,
                stored_assistant_message_id: assistant_msg_id,
            })
        }
        Err(e) => {
            if !transient {
                let _ = store.update_message(
                    &assistant_msg_id,
                    &full_text,
                    "error",
                    None,
                    &empty_events,
                );
            }
            Err(ChatServiceError::Backend(e.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirror_store::crypto::EncryptionKey;

    fn test_store() -> Store {
        Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap()).unwrap()
    }

    #[test]
    fn title_from_prompt_truncates_cleanly() {
        assert_eq!(title_from_prompt(""), "New chat");
        assert_eq!(title_from_prompt("   "), "New chat");
        assert_eq!(title_from_prompt("Hello   World"), "Hello World");

        let long_prompt = "A".repeat(100);
        let title = title_from_prompt(&long_prompt);
        assert_eq!(title.chars().count(), 54);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn stop_conversation_returns_false_for_idle_conversation() {
        assert!(!stop_conversation("idle-conversation-id"));
    }

    #[tokio::test]
    async fn run_chat_rejects_missing_conversation_id() {
        let store = test_store();
        let opts = RunChatOptions {
            conversation_id: Some("missing-id".into()),
            new_conversation_id: None,
            prompt: "hello".into(),
            model: None,
            gizmo_id: None,
            timezone: None,
            timezone_offset_min: None,
            attachments: Vec::new(),
            private: false,
            ephemeral: false,
            turnstile_token: None,
            on_delta: None,
            on_event: None,
            cancel_token: None,
        };

        assert!(matches!(
            run_chat(&store, opts).await,
            Err(ChatServiceError::NotFound)
        ));
    }
}
