//! Conversation, message and file persistence — port of the corresponding
//! half of `apps/server/src/store.ts`.
//!
//! Message `events` and `attachments` are held as opaque JSON, matching how
//! the TS version simply `JSON.stringify`s the protocol types on the way in
//! and `JSON.parse`s them on the way out. That keeps this crate free of a
//! dependency on the protocol crate for types it never inspects.

use crate::store::{Store, StoreError};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const CLIENT_CREATED_ROOT: &str = "client-created-root";
const DEFAULT_ACCOUNT_ID: &str = "default";
const DEFAULT_TITLE: &str = "New chat";

/// Mirrors `StoredConversation` (which extends `ConversationSessionState`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredConversation {
    pub id: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    /// `upstream_id` — the ChatGPT-side conversation id, absent until the
    /// first turn initializes it.
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
    #[serde(rename = "currentNodeId")]
    pub current_node_id: String,
    pub model: String,
    #[serde(rename = "gizmoId")]
    pub gizmo_id: Option<String>,
    pub initialized: bool,
    pub private: bool,
    #[serde(rename = "isBranch")]
    pub is_branch: bool,
    pub title: String,
    pub init: Option<Value>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// Mirrors `StoredMessage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "upstreamNodeId")]
    pub upstream_node_id: Option<String>,
    pub role: String,
    pub content: String,
    pub status: String,
    pub events: Value,
    pub attachments: Value,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Input for [`Store::create_conversation`], mirroring the TS input object's
/// optional fields and their defaults.
#[derive(Debug, Clone, Default)]
pub struct NewConversation {
    pub id: Option<String>,
    pub model: String,
    pub gizmo_id: Option<String>,
    pub private: bool,
    pub title: Option<String>,
    pub account_id: Option<String>,
}

/// Pagination for [`Store::list_conversations`].
#[derive(Debug, Clone, Copy)]
pub struct Page {
    pub limit: i64,
    pub offset: i64,
}

/// Mirrors `mapConversation`. Note that upstream uses truthiness for the
/// nullable text columns, so an empty string becomes `null` — replicated
/// here with a non-empty filter rather than a plain `Option`.
fn map_conversation(row: &Row<'_>) -> rusqlite::Result<StoredConversation> {
    let init_json: Option<String> = row.get("init_json")?;
    Ok(StoredConversation {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        conversation_id: row
            .get::<_, Option<String>>("upstream_id")?
            .filter(|v| !v.is_empty()),
        current_node_id: row.get("current_node_id")?,
        model: row.get("model")?,
        gizmo_id: row
            .get::<_, Option<String>>("gizmo_id")?
            .filter(|v| !v.is_empty()),
        initialized: row.get::<_, i64>("initialized")? != 0,
        private: row.get::<_, i64>("is_private")? != 0,
        is_branch: row.get::<_, i64>("is_branch")? != 0,
        title: row.get("title")?,
        init: init_json
            .filter(|v| !v.is_empty())
            .and_then(|v| serde_json::from_str(&v).ok()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_message(row: &Row<'_>) -> rusqlite::Result<StoredMessage> {
    let events: String = row.get("events_json")?;
    let attachments: String = row.get("attachments_json")?;
    Ok(StoredMessage {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        upstream_node_id: row
            .get::<_, Option<String>>("upstream_node_id")?
            .filter(|v| !v.is_empty()),
        role: row.get("role")?,
        content: row.get("content")?,
        status: row.get("status")?,
        events: serde_json::from_str(&events).unwrap_or(Value::Array(Vec::new())),
        attachments: serde_json::from_str(&attachments).unwrap_or(Value::Array(Vec::new())),
        created_at: row.get("created_at")?,
    })
}

impl Store {
    /// Mirrors `createConversation`. A new conversation starts un-initialized
    /// with a placeholder root node; the real upstream ids arrive on the
    /// first turn.
    pub fn create_conversation(
        &self,
        input: NewConversation,
    ) -> Result<StoredConversation, StoreError> {
        let now = crate::store::now_iso8601();
        let id = input.id.unwrap_or_else(crate::store::new_uuid);
        let account_id = input
            .account_id
            .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string());
        let title = input.title.unwrap_or_else(|| DEFAULT_TITLE.to_string());

        self.with_conn(|db| {
            db.execute(
                "INSERT INTO conversations
                 (id, account_id, upstream_id, current_node_id, model, gizmo_id, title, initialized, is_private, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
                params![
                    id,
                    account_id,
                    CLIENT_CREATED_ROOT,
                    input.model,
                    input.gizmo_id,
                    title,
                    i64::from(input.private),
                    now,
                    now,
                ],
            )?;
            Ok(())
        })?;

        self.conversation(&id)?
            .ok_or_else(|| StoreError::MalformedSession("conversation vanished after insert".into()))
    }

    /// Mirrors `getConversation`.
    pub fn conversation(&self, id: &str) -> Result<Option<StoredConversation>, StoreError> {
        self.with_conn(|db| {
            Ok(db
                .query_row("SELECT * FROM conversations WHERE id = ?1", [id], |row| {
                    map_conversation(row)
                })
                .optional()?)
        })
    }

    /// Mirrors `listConversations`, newest-updated first.
    pub fn list_conversations(
        &self,
        account_id: &str,
        page: Option<Page>,
    ) -> Result<Vec<StoredConversation>, StoreError> {
        self.with_conn(|db| match page {
            Some(page) => {
                let mut stmt = db.prepare(
                    "SELECT * FROM conversations WHERE account_id = ?1 ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3",
                )?;
                let rows = stmt
                    .query_map(params![account_id, page.limit, page.offset], |row| {
                        map_conversation(row)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            }
            None => {
                let mut stmt = db.prepare(
                    "SELECT * FROM conversations WHERE account_id = ?1 ORDER BY updated_at DESC",
                )?;
                let rows = stmt
                    .query_map([account_id], |row| map_conversation(row))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            }
        })
    }

    /// Mirrors `countConversations`.
    pub fn count_conversations(&self, account_id: &str) -> Result<i64, StoreError> {
        self.with_conn(|db| {
            Ok(db.query_row(
                "SELECT COUNT(*) AS count FROM conversations WHERE account_id = ?1",
                [account_id],
                |row| row.get(0),
            )?)
        })
    }

    /// Mirrors `updateConversation` — a full row update that also refreshes
    /// `updated_at`, which is what drives sidebar ordering.
    pub fn update_conversation(&self, conversation: &StoredConversation) -> Result<(), StoreError> {
        let now = crate::store::now_iso8601();
        let init_json = conversation
            .init
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()));
        self.with_conn(|db| {
            db.execute(
                "UPDATE conversations SET upstream_id=?1, current_node_id=?2, model=?3, gizmo_id=?4,
                 title=?5, initialized=?6, init_json=?7, is_private=?8, is_branch=?9, updated_at=?10
                 WHERE id=?11",
                params![
                    conversation.conversation_id,
                    conversation.current_node_id,
                    conversation.model,
                    conversation.gizmo_id,
                    conversation.title,
                    i64::from(conversation.initialized),
                    init_json,
                    i64::from(conversation.private),
                    i64::from(conversation.is_branch),
                    now,
                    conversation.id,
                ],
            )?;
            Ok(())
        })
    }

    /// Mirrors `setConversationModel`, returning the updated row (or `None`
    /// when the id does not exist).
    pub fn set_conversation_model(
        &self,
        id: &str,
        model: &str,
    ) -> Result<Option<StoredConversation>, StoreError> {
        let now = crate::store::now_iso8601();
        self.with_conn(|db| {
            db.execute(
                "UPDATE conversations SET model=?1, updated_at=?2 WHERE id=?3",
                params![model, now, id],
            )?;
            Ok(())
        })?;
        self.conversation(id)
    }

    /// Mirrors `deleteConversation`. Messages cascade via the schema's
    /// foreign key.
    pub fn delete_conversation(&self, id: &str) -> Result<(), StoreError> {
        self.with_conn(|db| {
            db.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /// Mirrors `addMessage`.
    pub fn add_message(
        &self,
        conversation_id: &str,
        upstream_node_id: Option<&str>,
        role: &str,
        content: &str,
        status: &str,
        events: &Value,
        attachments: Option<&Value>,
        id: Option<&str>,
    ) -> Result<StoredMessage, StoreError> {
        let message = StoredMessage {
            id: id.map(str::to_string).unwrap_or_else(crate::store::new_uuid),
            conversation_id: conversation_id.to_string(),
            upstream_node_id: upstream_node_id.map(str::to_string),
            role: role.to_string(),
            content: content.to_string(),
            status: status.to_string(),
            events: events.clone(),
            attachments: attachments.cloned().unwrap_or(Value::Array(Vec::new())),
            created_at: crate::store::now_iso8601(),
        };

        let events_json = serde_json::to_string(&message.events).unwrap_or_else(|_| "[]".into());
        let attachments_json =
            serde_json::to_string(&message.attachments).unwrap_or_else(|_| "[]".into());

        self.with_conn(|db| {
            db.execute(
                "INSERT INTO messages(id, conversation_id, upstream_node_id, role, content, status, events_json, attachments_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    message.id,
                    message.conversation_id,
                    message.upstream_node_id,
                    message.role,
                    message.content,
                    message.status,
                    events_json,
                    attachments_json,
                    message.created_at,
                ],
            )?;
            Ok(())
        })?;
        Ok(message)
    }

    /// Mirrors `updateMessage`. Deliberately does not touch `attachments_json`
    /// or `created_at`.
    pub fn update_message(
        &self,
        id: &str,
        content: &str,
        status: &str,
        upstream_node_id: Option<&str>,
        events: &Value,
    ) -> Result<(), StoreError> {
        let events_json = serde_json::to_string(events).unwrap_or_else(|_| "[]".into());
        self.with_conn(|db| {
            db.execute(
                "UPDATE messages SET content=?1, status=?2, upstream_node_id=?3, events_json=?4 WHERE id=?5",
                params![content, status, upstream_node_id, events_json, id],
            )?;
            Ok(())
        })
    }

    /// Mirrors `listMessages`. Ordered by `created_at, rowid` so messages
    /// written within the same millisecond keep insertion order.
    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>, StoreError> {
        self.with_conn(|db| {
            let mut stmt = db.prepare(
                "SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY created_at, rowid",
            )?;
            let rows = stmt
                .query_map([conversation_id], |row| map_message(row))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Mirrors `saveFile`, keyed on the upstream file id and upserting the
    /// metadata blob.
    pub fn save_file(
        &self,
        file_id: &str,
        metadata: &Value,
        account_id: &str,
    ) -> Result<(), StoreError> {
        let metadata_json = serde_json::to_string(metadata).unwrap_or_else(|_| "{}".into());
        let now = crate::store::now_iso8601();
        self.with_conn(|db| {
            db.execute(
                "INSERT INTO files(id, account_id, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json",
                params![file_id, account_id, metadata_json, now],
            )?;
            Ok(())
        })
    }

    /// Mirrors `ownsFile` — the ownership check that gates attachment reuse.
    pub fn owns_file(&self, file_id: &str, account_id: &str) -> Result<bool, StoreError> {
        self.with_conn(|db| {
            Ok(db
                .query_row(
                    "SELECT 1 FROM files WHERE id=?1 AND account_id=?2",
                    params![file_id, account_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some())
        })
    }

    /// Mirrors `ownsUpstreamConversation` — gates access to an upstream
    /// conversation id supplied by a caller.
    pub fn owns_upstream_conversation(
        &self,
        upstream_id: &str,
        account_id: &str,
    ) -> Result<bool, StoreError> {
        self.with_conn(|db| {
            Ok(db
                .query_row(
                    "SELECT 1 FROM conversations WHERE upstream_id=?1 AND account_id=?2",
                    params![upstream_id, account_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EncryptionKey;
    use serde_json::json;

    fn store() -> Store {
        Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap()).unwrap()
    }

    fn new_conversation(model: &str) -> NewConversation {
        NewConversation {
            model: model.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn a_created_conversation_starts_uninitialized_with_a_placeholder_root() {
        let s = store();
        let created = s.create_conversation(new_conversation("gpt-5")).unwrap();

        assert_eq!(created.model, "gpt-5");
        assert_eq!(created.account_id, "default");
        assert_eq!(created.title, "New chat");
        assert_eq!(created.current_node_id, "client-created-root");
        assert_eq!(created.conversation_id, None);
        assert!(!created.initialized);
        assert!(!created.private);
        assert!(!created.is_branch);
        assert_eq!(created.init, None);
        assert!(!created.id.is_empty());
        assert_eq!(created.created_at, created.updated_at);
    }

    #[test]
    fn created_conversations_honor_supplied_optional_fields() {
        let s = store();
        let created = s
            .create_conversation(NewConversation {
                id: Some("fixed-id".to_string()),
                model: "gpt-5".to_string(),
                gizmo_id: Some("g-abc".to_string()),
                private: true,
                title: Some("Custom".to_string()),
                account_id: Some("acct-1".to_string()),
            })
            .unwrap();

        assert_eq!(created.id, "fixed-id");
        assert_eq!(created.gizmo_id.as_deref(), Some("g-abc"));
        assert!(created.private);
        assert_eq!(created.title, "Custom");
        assert_eq!(created.account_id, "acct-1");
    }

    #[test]
    fn a_missing_conversation_reads_back_as_none() {
        let s = store();
        assert_eq!(s.conversation("nope").unwrap(), None);
    }

    #[test]
    fn conversations_are_listed_newest_updated_first_and_scoped_by_account() {
        let s = store();
        for (id, account) in [("a", "acct-1"), ("b", "acct-1"), ("c", "acct-2")] {
            s.create_conversation(NewConversation {
                id: Some(id.to_string()),
                model: "gpt-5".to_string(),
                account_id: Some(account.to_string()),
                ..Default::default()
            })
            .unwrap();
        }

        // Touching "a" moves it to the front of its account's list.
        let mut a = s.conversation("a").unwrap().unwrap();
        a.title = "touched".to_string();
        s.update_conversation(&a).unwrap();

        let ids: Vec<String> = s
            .list_conversations("acct-1", None)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);

        // The other account is isolated.
        assert_eq!(s.list_conversations("acct-2", None).unwrap().len(), 1);
        assert_eq!(s.count_conversations("acct-1").unwrap(), 2);
        assert_eq!(s.count_conversations("acct-2").unwrap(), 1);
        assert_eq!(s.count_conversations("absent").unwrap(), 0);
    }

    #[test]
    fn conversation_listing_paginates() {
        let s = store();
        for id in ["a", "b", "c"] {
            s.create_conversation(NewConversation {
                id: Some(id.to_string()),
                model: "gpt-5".to_string(),
                ..Default::default()
            })
            .unwrap();
        }
        let page = s
            .list_conversations("default", Some(Page { limit: 2, offset: 1 }))
            .unwrap();
        assert_eq!(page.len(), 2);
    }

    #[test]
    fn updating_a_conversation_persists_every_field() {
        let s = store();
        let created = s.create_conversation(new_conversation("gpt-5")).unwrap();

        let updated = StoredConversation {
            conversation_id: Some("upstream-1".to_string()),
            current_node_id: "node-9".to_string(),
            model: "gpt-5-thinking".to_string(),
            gizmo_id: Some("g-1".to_string()),
            initialized: true,
            private: true,
            is_branch: true,
            title: "Renamed".to_string(),
            init: Some(json!({"a": 1})),
            ..created.clone()
        };
        s.update_conversation(&updated).unwrap();

        let read = s.conversation(&created.id).unwrap().unwrap();
        assert_eq!(read.conversation_id.as_deref(), Some("upstream-1"));
        assert_eq!(read.current_node_id, "node-9");
        assert_eq!(read.model, "gpt-5-thinking");
        assert_eq!(read.gizmo_id.as_deref(), Some("g-1"));
        assert!(read.initialized);
        assert!(read.private);
        assert!(read.is_branch);
        assert_eq!(read.title, "Renamed");
        assert_eq!(read.init, Some(json!({"a": 1})));
    }

    #[test]
    fn setting_the_model_returns_the_updated_row_or_none() {
        let s = store();
        let created = s.create_conversation(new_conversation("gpt-5")).unwrap();
        let updated = s
            .set_conversation_model(&created.id, "gpt-5-thinking")
            .unwrap()
            .unwrap();
        assert_eq!(updated.model, "gpt-5-thinking");
        assert_eq!(s.set_conversation_model("absent", "x").unwrap(), None);
    }

    #[test]
    fn deleting_a_conversation_cascades_to_its_messages() {
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();
        s.add_message(&c.id, None, "user", "hi", "done", &json!([]), None, None)
            .unwrap();
        assert_eq!(s.list_messages(&c.id).unwrap().len(), 1);

        s.delete_conversation(&c.id).unwrap();
        assert_eq!(s.conversation(&c.id).unwrap(), None);
        assert_eq!(s.list_messages(&c.id).unwrap().len(), 0);
    }

    #[test]
    fn messages_round_trip_including_events_and_attachments() {
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();
        let events = json!([{"kind": "assistant_text", "text": "hello"}]);
        let attachments = json!([{"fileId": "f1"}]);

        let added = s
            .add_message(
                &c.id,
                Some("node-1"),
                "assistant",
                "hello",
                "done",
                &events,
                Some(&attachments),
                None,
            )
            .unwrap();

        let listed = s.list_messages(&c.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], added);
        assert_eq!(listed[0].events, events);
        assert_eq!(listed[0].attachments, attachments);
        assert_eq!(listed[0].upstream_node_id.as_deref(), Some("node-1"));
    }

    #[test]
    fn a_message_without_attachments_defaults_to_an_empty_array() {
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();
        let added = s
            .add_message(&c.id, None, "user", "hi", "done", &json!([]), None, None)
            .unwrap();
        assert_eq!(added.attachments, json!([]));
        assert_eq!(s.list_messages(&c.id).unwrap()[0].attachments, json!([]));
    }

    #[test]
    fn updating_a_message_leaves_attachments_and_created_at_untouched() {
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();
        let attachments = json!([{"fileId": "f1"}]);
        let added = s
            .add_message(
                &c.id,
                None,
                "assistant",
                "partial",
                "streaming",
                &json!([]),
                Some(&attachments),
                None,
            )
            .unwrap();

        s.update_message(
            &added.id,
            "complete",
            "done",
            Some("node-7"),
            &json!([{"kind": "marker"}]),
        )
        .unwrap();

        let read = &s.list_messages(&c.id).unwrap()[0];
        assert_eq!(read.content, "complete");
        assert_eq!(read.status, "done");
        assert_eq!(read.upstream_node_id.as_deref(), Some("node-7"));
        assert_eq!(read.events, json!([{"kind": "marker"}]));
        // Deliberately preserved by the narrower UPDATE statement.
        assert_eq!(read.attachments, attachments);
        assert_eq!(read.created_at, added.created_at);
    }

    #[test]
    fn messages_written_in_the_same_millisecond_keep_insertion_order() {
        // The ORDER BY includes rowid precisely because created_at has only
        // millisecond resolution and a fast turn can write several messages
        // within one tick.
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();
        let mut ids = Vec::new();
        for i in 0..5 {
            ids.push(
                s.add_message(
                    &c.id,
                    None,
                    "user",
                    &format!("m{i}"),
                    "done",
                    &json!([]),
                    None,
                    None,
                )
                .unwrap()
                .id,
            );
        }
        let listed: Vec<String> = s
            .list_messages(&c.id)
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(listed, ids);
    }

    #[test]
    fn messages_are_scoped_to_their_conversation() {
        let s = store();
        let a = s.create_conversation(new_conversation("gpt-5")).unwrap();
        let b = s.create_conversation(new_conversation("gpt-5")).unwrap();
        s.add_message(&a.id, None, "user", "in a", "done", &json!([]), None, None)
            .unwrap();
        assert_eq!(s.list_messages(&a.id).unwrap().len(), 1);
        assert_eq!(s.list_messages(&b.id).unwrap().len(), 0);
    }

    #[test]
    fn files_upsert_metadata_and_are_ownership_checked() {
        let s = store();
        s.save_file("f1", &json!({"fileId": "f1", "name": "a.png"}), "acct-1")
            .unwrap();
        assert!(s.owns_file("f1", "acct-1").unwrap());
        // Ownership is per account -- this is what gates attachment reuse.
        assert!(!s.owns_file("f1", "acct-2").unwrap());
        assert!(!s.owns_file("absent", "acct-1").unwrap());

        // A second save updates metadata rather than failing or duplicating.
        s.save_file("f1", &json!({"fileId": "f1", "name": "b.png"}), "acct-1")
            .unwrap();
        let count: i64 = s
            .with_conn(|db| Ok(db.query_row("SELECT count(*) FROM files", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn upstream_conversation_ownership_is_account_scoped() {
        let s = store();
        let c = s
            .create_conversation(NewConversation {
                model: "gpt-5".to_string(),
                account_id: Some("acct-1".to_string()),
                ..Default::default()
            })
            .unwrap();
        let linked = StoredConversation {
            conversation_id: Some("upstream-1".to_string()),
            ..c
        };
        s.update_conversation(&linked).unwrap();

        assert!(s.owns_upstream_conversation("upstream-1", "acct-1").unwrap());
        assert!(!s.owns_upstream_conversation("upstream-1", "acct-2").unwrap());
        assert!(!s.owns_upstream_conversation("absent", "acct-1").unwrap());
    }
}
