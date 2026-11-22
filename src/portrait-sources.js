// Image bytes are shared by base avatars, mood variants and uploaded pool entries.
export const SOURCE_STORE = 'portrait_sources';
export const PORTRAIT_STORES = ['avatars', 'mood_avatars'];

export function sourceIdFromUrl(url) {
  return /^\/user\/files\/bdv8_([a-f0-9]{8,64})\.(?:jpg|png|gif|webp|avif|bmp)$/i.exec(url || '')?.[1].toLowerCase() || null;
}

export function syncedImagePath(id, mimeType) {
  const extension = {'image/jpeg':'jpg', 'image/jpg':'jpg', 'image/png':'png', 'image/gif':'gif',
    'image/webp':'webp', 'image/avif':'avif', 'image/bmp':'bmp'}[mimeType] || 'webp';
  return '/user/files/bdv8_' + id + '.' + extension;
}

export async function contentId(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  // Local HTTP installations do not expose WebCrypto.
  const { sha256 } = await import("./sha256.js?v=2.5.0");
  return sha256(bytes);
}

export function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('头像存储事务已中止'));
  });
}

export function bindingTombstone(record, updatedAt) {
  const { alias, id, charId, moodId, syncScope } = record;
  return { alias, ...(id ? { id, charId, moodId } : {}), syncScope, deleted:true, updatedAt };
}

// All reads and writes here share the caller's transaction.
export async function dropPortraitSource(tx, sourceId, updatedAt, purgeUrl = null) {
  const sources = tx.objectStore(SOURCE_STORE);
  const previous = await requestResult(sources.get(sourceId));
  if ((previous?.deletedAt || 0) >= updatedAt) return [];
  const changes = [];
  await Promise.all(PORTRAIT_STORES.map(async storeName => {
    const store = tx.objectStore(storeName);
    const records = await requestResult(store.index('sourceId').getAll(sourceId));
    for (const record of records) {
      if (record.updatedAt > updatedAt) continue;
      const marker = bindingTombstone(record, updatedAt);
      if (record.syncScope === 'avatar-pool') marker.removedSourceId = sourceId;
      store.put(marker);
      changes.push({storeName, record:marker});
    }
  }));
  // A deliberate later upload can reuse the same content while old bindings stay revoked.
  const source = previous?.updatedAt > updatedAt ? previous : { id:sourceId };
  sources.put({ ...source, deletedAt:updatedAt, pendingPurge:purgeUrl || previous?.pendingPurge || null });
  return changes;
}

export async function pruneUnusedSource(tx, id) {
  if (!id || id.startsWith('builtin:')) return false;
  const counts = await Promise.all(PORTRAIT_STORES.map(name => requestResult(tx.objectStore(name).index('sourceId').count(id))));
  if (counts.some(Boolean)) return false;
  const sources = tx.objectStore(SOURCE_STORE);
  const source = await requestResult(sources.get(id));
  if (source?.deletedAt) sources.put({id, deletedAt:source.deletedAt, pendingPurge:source.pendingPurge || null});
  else sources.delete(id);
  return true;
}

export async function writeTransaction(db, stores, operation) {
  const tx = db.transaction(stores, 'readwrite');
  const done = committed(tx);
  try {
    const result = await operation(tx);
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction may already be complete. */ }
    await done.catch(() => {});
    throw error;
  }
}
