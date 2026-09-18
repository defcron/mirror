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

        self.conversation(&id)?.ok_or_else(|| {
            StoreError::MalformedSession("conversation vanished after insert".into())
        })
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
                    .query_map([account_id], map_conversation)?
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
    #[allow(clippy::too_many_arguments)] // matches addMessage's own many-field input shape
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
            id: id
                .map(str::to_string)
                .unwrap_or_else(crate::store::new_uuid),
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
                .query_map([conversation_id], map_message)?
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

/// Mirrors `ConversationSyncCursor` — where an account's incremental
/// remote-sidebar sync last left off. Every field defaults, so a partial or
/// older-shaped stored cursor merges over the defaults exactly as upstream's
/// `{ ...DEFAULT_SYNC_CURSOR, ...JSON.parse(raw) }` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ConversationSyncCursor {
    #[serde(rename = "activeOffset", default)]
    pub active_offset: i64,
    #[serde(rename = "activeDone", default)]
    pub active_done: bool,
    #[serde(rename = "archivedOffset", default)]
    pub archived_offset: i64,
    #[serde(rename = "archivedDone", default)]
    pub archived_done: bool,
}

/// Mirrors `fingerprintValue`: sha256 of the value's compact JSON encoding,
/// hex-encoded. Used to recognize a caller's resent transcript.
pub fn fingerprint_value(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    let digest = Sha256::digest(json.as_bytes());
    digest.iter().fold(String::with_capacity(64), |mut out, b| {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
        out
    })
}

impl Store {
    fn sync_cursor_key(account_id: &str) -> String {
        format!("conversation_sync_cursor:{account_id}")
    }

    /// Mirrors `getConversationSyncCursor`, degrading to defaults on a
    /// malformed payload rather than erroring.
    pub fn conversation_sync_cursor(
        &self,
        account_id: &str,
    ) -> Result<ConversationSyncCursor, StoreError> {
        let Some(raw) = self.read_setting_pub(&Self::sync_cursor_key(account_id))? else {
            return Ok(ConversationSyncCursor::default());
        };
        // Only a JSON *object* may override the defaults. Upstream spreads
        // the parsed value over DEFAULT_SYNC_CURSOR, and spreading an array,
        // string, number or null in JS adds only index/no keys — it never
        // touches the named fields. serde would otherwise happily deserialize
        // this struct positionally from an array, so `[1]` would wrongly set
        // activeOffset.
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(_)) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
            _ => Ok(ConversationSyncCursor::default()),
        }
    }

    pub fn set_conversation_sync_cursor(
        &self,
        account_id: &str,
        cursor: &ConversationSyncCursor,
    ) -> Result<(), StoreError> {
        let json = serde_json::to_string(cursor).unwrap_or_else(|_| "{}".to_string());
        self.write_setting_pub(&Self::sync_cursor_key(account_id), &json)
    }

    /// Mirrors `saveOpenAiContext` / `getOpenAiContext` — the instructions
    /// fingerprint used to notice a caller changed their system prompt.
    pub fn save_openai_context(
        &self,
        conversation_id: &str,
        instructions_hash: &str,
    ) -> Result<(), StoreError> {
        let now = crate::store::now_iso8601();
        self.with_conn(|db| {
            db.execute(
                "INSERT INTO openai_contexts(conversation_id, instructions_hash, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(conversation_id) DO UPDATE SET instructions_hash=excluded.instructions_hash, updated_at=excluded.updated_at",
                params![conversation_id, instructions_hash, now],
            )?;
            Ok(())
        })
    }

    pub fn openai_context(&self, conversation_id: &str) -> Result<Option<String>, StoreError> {
        self.with_conn(|db| {
            Ok(db
                .query_row(
                    "SELECT instructions_hash FROM openai_contexts WHERE conversation_id = ?1",
                    [conversation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })
    }

    /// Mirrors `saveOpenAiTranscript` — the fingerprint of the full transcript
    /// a stateless caller would resend next turn, which is what lets a client
    /// with no conversation id be matched back to its existing thread.
    pub fn save_openai_transcript(
        &self,
        conversation_id: &str,
        account_id: &str,
        transcript_hash: &str,
    ) -> Result<(), StoreError> {
        let now = crate::store::now_iso8601();
        self.with_conn(|db| {
            db.execute(
                "INSERT INTO openai_transcripts(conversation_id, account_id, transcript_hash, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(conversation_id) DO UPDATE SET transcript_hash=excluded.transcript_hash, updated_at=excluded.updated_at",
                params![conversation_id, account_id, transcript_hash, now],
            )?;
            Ok(())
        })
    }

    pub fn openai_transcript(&self, conversation_id: &str) -> Result<Option<String>, StoreError> {
        self.with_conn(|db| {
            Ok(db
                .query_row(
                    "SELECT transcript_hash FROM openai_transcripts WHERE conversation_id = ?1",
                    [conversation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })
    }

    /// Mirrors `findConversationByTranscript`, most-recently-updated first.
    pub fn find_conversation_by_transcript(
        &self,
        account_id: &str,
        transcript_hash: &str,
    ) -> Result<Option<StoredConversation>, StoreError> {
        let found: Option<String> = self.with_conn(|db| {
            Ok(db
                .query_row(
                    "SELECT conversation_id FROM openai_transcripts
                     WHERE account_id = ?1 AND transcript_hash = ?2 ORDER BY updated_at DESC LIMIT 1",
                    params![account_id, transcript_hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })?;
        match found {
            Some(id) => self.conversation(&id),
            None => Ok(None),
        }
    }

    /// Mirrors `saveInstructions`: only system/developer messages are kept,
    /// since those are the instruction slots — the rest of the transcript
    /// lives in `messages`.
    pub fn save_instructions(
        &self,
        conversation_id: &str,
        messages: &[(String, String)],
    ) -> Result<(), StoreError> {
        let filtered: Vec<Value> = messages
            .iter()
            .filter(|(role, _)| role == "system" || role == "developer")
            .map(|(role, content)| serde_json::json!({"role": role, "content": content}))
            .collect();
        let json = serde_json::to_string(&filtered).unwrap_or_else(|_| "[]".to_string());
        self.with_conn(|db| {
            db.execute(
                "INSERT INTO conversation_instructions VALUES (?1, ?2)
                 ON CONFLICT(conversation_id) DO UPDATE SET messages_json=excluded.messages_json",
                params![conversation_id, json],
            )?;
            Ok(())
        })
    }

    /// Mirrors `getInstructions`, returning an empty list when unset.
    pub fn instructions(&self, conversation_id: &str) -> Result<Vec<(String, String)>, StoreError> {
        let raw: Option<String> = self.with_conn(|db| {
            Ok(db
                .query_row(
                    "SELECT messages_json FROM conversation_instructions WHERE conversation_id=?1",
                    [conversation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })?;
        let Some(raw) = raw else {
            return Ok(Vec::new());
        };
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) else {
            return Ok(Vec::new());
        };
        Ok(items
            .into_iter()
            .filter_map(|item| {
                let role = item.get("role")?.as_str()?.to_string();
                let content = item.get("content")?.as_str()?.to_string();
                Some((role, content))
            })
            .collect())
    }

    /// Mirrors `searchConversations`: local history only, never initiating an
    /// upstream sync. Matches a case-insensitive substring in the title or in
    /// any message body.
    pub fn search_conversations(
        &self,
        account_id: &str,
        query: &str,
    ) -> Result<Vec<StoredConversation>, StoreError> {
        self.with_conn(|db| {
            let mut stmt = db.prepare(
                "SELECT c.* FROM conversations c WHERE account_id = ?1 AND
                 (instr(lower(title), lower(?2)) > 0 OR EXISTS
                   (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND instr(lower(m.content), lower(?2)) > 0))
                 ORDER BY updated_at DESC LIMIT 100",
            )?;
            let rows = stmt
                .query_map(params![account_id, query], map_conversation)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Mirrors `relatedConversations` — every local conversation sharing an
    /// upstream thread, which is how branches are surfaced together.
    pub fn related_conversations(
        &self,
        account_id: &str,
        upstream_id: &str,
    ) -> Result<Vec<StoredConversation>, StoreError> {
        self.with_conn(|db| {
            let mut stmt = db.prepare(
                "SELECT * FROM conversations WHERE account_id = ?1 AND upstream_id = ?2 ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map(params![account_id, upstream_id], map_conversation)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Syncs remote conversation summaries from the upstream sidebar into local storage.
    pub fn sync_remote_conversations(
        &self,
        items: &[RemoteConversationSummary],
        account_id: &str,
    ) -> Result<(), StoreError> {
        self.with_conn(|db| {
            db.execute("BEGIN", [])?;
            let res = (|| -> Result<(), StoreError> {
                let mut find = db.prepare_cached(
                    "SELECT id FROM conversations WHERE account_id=?1 AND upstream_id=?2 AND is_branch=0 ORDER BY created_at LIMIT 1",
                )?;
                let mut update = db.prepare_cached(
                    "UPDATE conversations SET title=?1, gizmo_id=COALESCE(?2, gizmo_id), \
                     current_node_id=CASE WHEN NOT EXISTS \
                       (SELECT 1 FROM messages WHERE conversation_id=conversations.id) \
                       THEN COALESCE(?3, current_node_id) ELSE current_node_id END, \
                     updated_at=?4 WHERE id=?5",
                )?;
                let mut insert = db.prepare_cached(
                    "INSERT INTO conversations \
                     (id, account_id, upstream_id, current_node_id, model, gizmo_id, title, initialized, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, 'auto', ?5, ?6, 1, ?7, ?8)",
                )?;

                for item in items {
                    let existing: Option<String> = find
                        .query_row(params![account_id, item.id], |row| row.get(0))
                        .optional()?;

                    if let Some(row_id) = existing {
                        update.execute(params![
                            item.title,
                            item.gizmo_id,
                            item.current_node_id,
                            item.update_time,
                            row_id,
                        ])?;
                    } else {
                        let new_id = crate::store::new_uuid();
                        let current_node = item
                            .current_node_id
                            .as_deref()
                            .unwrap_or(CLIENT_CREATED_ROOT);
                        insert.execute(params![
                            new_id,
                            account_id,
                            item.id,
                            current_node,
                            item.gizmo_id,
                            item.title,
                            item.create_time,
                            item.update_time,
                        ])?;
                    }
                }
                Ok(())
            })();
            if res.is_ok() {
                db.execute("COMMIT", [])?;
            } else {
                let _ = db.execute("ROLLBACK", []);
            }
            res
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RemoteConversationSummary {
    pub id: String,
    pub title: String,
    pub create_time: String,
    pub update_time: String,
    pub current_node_id: Option<String>,
    pub gizmo_id: Option<String>,
    pub is_archived: bool,
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
            .list_conversations(
                "default",
                Some(Page {
                    limit: 2,
                    offset: 1,
                }),
            )
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
    fn sync_cursors_default_and_round_trip_per_account() {
        let s = store();
        assert_eq!(
            s.conversation_sync_cursor("acct-1").unwrap(),
            ConversationSyncCursor::default()
        );

        let cursor = ConversationSyncCursor {
            active_offset: 56,
            active_done: true,
            archived_offset: 28,
            archived_done: false,
        };
        s.set_conversation_sync_cursor("acct-1", &cursor).unwrap();
        assert_eq!(s.conversation_sync_cursor("acct-1").unwrap(), cursor);
        // Another account keeps its own cursor.
        assert_eq!(
            s.conversation_sync_cursor("acct-2").unwrap(),
            ConversationSyncCursor::default()
        );
    }

    #[test]
    fn a_partial_or_malformed_sync_cursor_merges_over_the_defaults() {
        // Matches upstream's { ...DEFAULT, ...JSON.parse(raw) } so a cursor
        // written by an older build still loads.
        let s = store();
        s.write_setting_pub("conversation_sync_cursor:acct-1", r#"{"activeOffset":7}"#)
            .unwrap();
        let cursor = s.conversation_sync_cursor("acct-1").unwrap();
        assert_eq!(cursor.active_offset, 7);
        assert!(!cursor.active_done);
        assert_eq!(cursor.archived_offset, 0);

        // Verified against Node: spreading a non-object over the defaults
        // leaves every named field untouched, so each of these yields
        // defaults rather than a positionally-deserialized cursor.
        for raw in ["not json", "[1]", "null", "\"str\"", "5"] {
            s.write_setting_pub("conversation_sync_cursor:acct-2", raw)
                .unwrap();
            assert_eq!(
                s.conversation_sync_cursor("acct-2").unwrap(),
                ConversationSyncCursor::default(),
                "{raw} should degrade to defaults"
            );
        }
    }

    #[test]
    fn fingerprints_are_stable_sha256_hex_of_the_compact_json() {
        // Cross-checked against Node:
        // createHash("sha256").update(JSON.stringify([{role:"user",content:"hi"}])).digest("hex")
        let value = json!([{"role": "user", "content": "hi"}]);
        let fingerprint = fingerprint_value(&value);
        assert_eq!(fingerprint.len(), 64);
        assert!(fingerprint.bytes().all(|b| b.is_ascii_hexdigit()));
        // Stable across calls, and sensitive to content.
        assert_eq!(fingerprint, fingerprint_value(&value));
        assert_ne!(
            fingerprint,
            fingerprint_value(&json!([{"role": "user", "content": "hi!"}]))
        );
    }

    #[test]
    fn openai_context_and_transcript_hashes_upsert_and_read_back() {
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();

        assert_eq!(s.openai_context(&c.id).unwrap(), None);
        s.save_openai_context(&c.id, "hash-1").unwrap();
        assert_eq!(s.openai_context(&c.id).unwrap().as_deref(), Some("hash-1"));
        // Upsert rather than insert-conflict.
        s.save_openai_context(&c.id, "hash-2").unwrap();
        assert_eq!(s.openai_context(&c.id).unwrap().as_deref(), Some("hash-2"));

        assert_eq!(s.openai_transcript(&c.id).unwrap(), None);
        s.save_openai_transcript(&c.id, "acct-1", "t-1").unwrap();
        assert_eq!(s.openai_transcript(&c.id).unwrap().as_deref(), Some("t-1"));
        s.save_openai_transcript(&c.id, "acct-1", "t-2").unwrap();
        assert_eq!(s.openai_transcript(&c.id).unwrap().as_deref(), Some("t-2"));
    }

    #[test]
    fn a_stateless_caller_is_matched_back_by_its_resent_transcript() {
        // This is what stops a plain OpenAI client that manages its own
        // history from spawning a fresh upstream thread on every message.
        let s = store();
        let c = s
            .create_conversation(NewConversation {
                model: "gpt-5".to_string(),
                account_id: Some("acct-1".to_string()),
                ..Default::default()
            })
            .unwrap();
        s.save_openai_transcript(&c.id, "acct-1", "transcript-hash")
            .unwrap();

        let found = s
            .find_conversation_by_transcript("acct-1", "transcript-hash")
            .unwrap()
            .expect("should match");
        assert_eq!(found.id, c.id);

        // Scoped by account, and unknown hashes do not match.
        assert_eq!(
            s.find_conversation_by_transcript("acct-2", "transcript-hash")
                .unwrap(),
            None
        );
        assert_eq!(
            s.find_conversation_by_transcript("acct-1", "other")
                .unwrap(),
            None
        );
    }

    #[test]
    fn instructions_keep_only_system_and_developer_roles() {
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();
        assert!(s.instructions(&c.id).unwrap().is_empty());

        s.save_instructions(
            &c.id,
            &[
                ("system".to_string(), "be terse".to_string()),
                ("user".to_string(), "hello".to_string()),
                ("developer".to_string(), "use rust".to_string()),
                ("assistant".to_string(), "hi".to_string()),
            ],
        )
        .unwrap();

        assert_eq!(
            s.instructions(&c.id).unwrap(),
            vec![
                ("system".to_string(), "be terse".to_string()),
                ("developer".to_string(), "use rust".to_string()),
            ]
        );
    }

    #[test]
    fn saving_instructions_replaces_rather_than_appends() {
        let s = store();
        let c = s.create_conversation(new_conversation("gpt-5")).unwrap();
        s.save_instructions(&c.id, &[("system".to_string(), "first".to_string())])
            .unwrap();
        s.save_instructions(&c.id, &[("system".to_string(), "second".to_string())])
            .unwrap();
        assert_eq!(
            s.instructions(&c.id).unwrap(),
            vec![("system".to_string(), "second".to_string())]
        );
    }

    #[test]
    fn search_matches_titles_and_message_bodies_case_insensitively() {
        let s = store();
        let titled = s
            .create_conversation(NewConversation {
                id: Some("titled".to_string()),
                model: "gpt-5".to_string(),
                title: Some("Rust Rewrite Plan".to_string()),
                account_id: Some("acct-1".to_string()),
                ..Default::default()
            })
            .unwrap();
        let bodied = s
            .create_conversation(NewConversation {
                id: Some("bodied".to_string()),
                model: "gpt-5".to_string(),
                title: Some("Unrelated".to_string()),
                account_id: Some("acct-1".to_string()),
                ..Default::default()
            })
            .unwrap();
        s.add_message(
            &bodied.id,
            None,
            "user",
            "tell me about BORINGSSL",
            "done",
            &json!([]),
            None,
            None,
        )
        .unwrap();

        let by_title: Vec<String> = s
            .search_conversations("acct-1", "rust")
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(by_title, vec![titled.id.clone()]);

        let by_body: Vec<String> = s
            .search_conversations("acct-1", "boringssl")
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(by_body, vec![bodied.id]);

        assert!(
            s.search_conversations("acct-1", "nothing here")
                .unwrap()
                .is_empty()
        );
        // Never crosses account boundaries.
        assert!(s.search_conversations("acct-2", "rust").unwrap().is_empty());
    }

    #[test]
    fn related_conversations_group_branches_sharing_one_upstream_thread() {
        let s = store();
        let mut ids = Vec::new();
        for id in ["a", "b"] {
            let c = s
                .create_conversation(NewConversation {
                    id: Some(id.to_string()),
                    model: "gpt-5".to_string(),
                    account_id: Some("acct-1".to_string()),
                    ..Default::default()
                })
                .unwrap();
            s.update_conversation(&StoredConversation {
                conversation_id: Some("upstream-1".to_string()),
                ..c
            })
            .unwrap();
            ids.push(id.to_string());
        }
        // An unrelated conversation on another upstream thread.
        let other = s
            .create_conversation(NewConversation {
                id: Some("c".to_string()),
                model: "gpt-5".to_string(),
                account_id: Some("acct-1".to_string()),
                ..Default::default()
            })
            .unwrap();
        s.update_conversation(&StoredConversation {
            conversation_id: Some("upstream-2".to_string()),
            ..other
        })
        .unwrap();

        let related = s.related_conversations("acct-1", "upstream-1").unwrap();
        assert_eq!(related.len(), 2);
        let mut related_ids: Vec<String> = related.into_iter().map(|c| c.id).collect();
        related_ids.sort();
        assert_eq!(related_ids, ids);

        assert!(
            s.related_conversations("acct-2", "upstream-1")
                .unwrap()
                .is_empty()
        );
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

        assert!(
            s.owns_upstream_conversation("upstream-1", "acct-1")
                .unwrap()
        );
        assert!(
            !s.owns_upstream_conversation("upstream-1", "acct-2")
                .unwrap()
        );
        assert!(!s.owns_upstream_conversation("absent", "acct-1").unwrap());
    }
}
