//! Synchronization of remote conversation lists from ChatGPT into local mirror storage.
//! Port of `apps/server/src/conversation-sync.ts`.

use mirror_store::{ConversationSyncCursor, RemoteConversationSummary, Store, StoreError};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::Mutex as TokioMutex;

static LOCKS: LazyLock<Mutex<HashMap<String, Arc<TokioMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn get_account_lock(account_id: &str) -> Arc<TokioMutex<()>> {
    let mut locks = LOCKS.lock().expect("locks mutex");
    locks
        .entry(account_id.to_string())
        .or_insert_with(|| Arc::new(TokioMutex::new(())))
        .clone()
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("Store error: {0}")]
    Store(#[from] StoreError),
    #[error("Fetch error: {0}")]
    Fetch(String),
}

pub fn has_remote_history(store: &Store, account_id: &str) -> Result<bool, StoreError> {
    let cursor = store.conversation_sync_cursor(account_id)?;
    Ok(!cursor.active_done || !cursor.archived_done)
}

pub async fn sync_conversation_page<F, Fut>(
    store: &Store,
    account_id: &str,
    need: i64,
    refresh: bool,
    fetch_page: F,
) -> Result<(), SyncError>
where
    F: Fn(usize, usize, bool) -> Fut,
    Fut: Future<Output = Result<Vec<RemoteConversationSummary>, String>>,
{
    let lock = get_account_lock(account_id);
    let _guard = lock.lock().await;

    let mut cursor = if refresh {
        ConversationSyncCursor {
            active_offset: 0,
            active_done: false,
            archived_offset: 0,
            archived_done: false,
        }
    } else {
        store.conversation_sync_cursor(account_id)?
    };

    for page in 0..40 {
        if cursor.active_done && cursor.archived_done {
            break;
        }
        if !(refresh && page == 0) && store.count_conversations(account_id)? >= need {
            break;
        }

        let archived = cursor.active_done;
        let offset = if archived {
            cursor.archived_offset as usize
        } else {
            cursor.active_offset as usize
        };

        let items = fetch_page(offset, 100, archived)
            .await
            .map_err(SyncError::Fetch)?;

        let items_len = items.len() as i64;
        store.sync_remote_conversations(&items, account_id)?;

        if archived {
            cursor.archived_offset += items_len;
            cursor.archived_done = items_len == 0;
        } else {
            cursor.active_offset += items_len;
            cursor.active_done = items_len == 0;
        }

        store.set_conversation_sync_cursor(account_id, &cursor)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirror_store::crypto::EncryptionKey;

    fn test_store() -> Store {
        Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn sync_conversation_page_updates_store_and_cursor() {
        let store = test_store();
        let account_id = "test-account";

        assert!(has_remote_history(&store, account_id).unwrap());

        sync_conversation_page(&store, account_id, 2, false, |offset, _limit, archived| async move {
            if archived {
                Ok(vec![])
            } else if offset == 0 {
                Ok(vec![RemoteConversationSummary {
                    id: "c-1".into(),
                    title: "Conv 1".into(),
                    create_time: "2026-09-01T00:00:00Z".into(),
                    update_time: "2026-09-01T00:00:00Z".into(),
                    current_node_id: None,
                    gizmo_id: None,
                    is_archived: false,
                }])
            } else {
                Ok(vec![])
            }
        })
        .await
        .unwrap();

        assert_eq!(store.count_conversations(account_id).unwrap(), 1);
    }
}
