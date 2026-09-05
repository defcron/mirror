import { countConversations, getConversationSyncCursor, setConversationSyncCursor, syncRemoteConversations } from "./store.js";
import type { RemoteConversationSummary } from "@mirror/protocol";
type FetchPage = (options: { offset: number; limit: number; archived: boolean }) => Promise<{ items: RemoteConversationSummary[] }>;
const locks = new Map<string, Promise<void>>();
export function hasRemoteHistory(accountId: string): boolean {
  const cursor = getConversationSyncCursor(accountId);
  return !cursor.activeDone || !cursor.archivedDone;
}
export async function syncConversationPage(accountId: string, need: number, refresh: boolean, fetchPage: FetchPage): Promise<void> {
  const prior = locks.get(accountId) ?? Promise.resolve();
  const task = prior.catch(() => undefined).then(async () => {
    const cursor = refresh
      ? { activeOffset: 0, activeDone: false, archivedOffset: 0, archivedDone: false }
      : getConversationSyncCursor(accountId);
    for (let page = 0; page < 40 && (!cursor.activeDone || !cursor.archivedDone); page++) {
      if (!(refresh && page === 0) && countConversations(accountId) >= need) break;
      const archived = cursor.activeDone;
      const result = await fetchPage({ offset: archived ? cursor.archivedOffset : cursor.activeOffset, limit: 100, archived });
      syncRemoteConversations(result.items, accountId);
      if (archived) { cursor.archivedOffset += result.items.length; cursor.archivedDone = result.items.length === 0; }
      else { cursor.activeOffset += result.items.length; cursor.activeDone = result.items.length === 0; }
      setConversationSyncCursor(accountId, cursor);
    }
  });
  locks.set(accountId, task);
  try { await task; } finally { if (locks.get(accountId) === task) locks.delete(accountId); }
}
