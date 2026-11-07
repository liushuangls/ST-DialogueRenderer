import { STYLE_DEFAULTS, STYLE_CONFIG_KEYS, writeStyleSnapshot } from './config.js?v=2.0.0';
import { GLOBAL_CHAR_ID, CHAR_ID_SEPARATOR, buildAvatarKey, buildMoodAvatarKey, getCurrentCharacterSyncScope, getAvatarSyncScopeForCharId, getCurrentContext, getCurrentCharId } from './context.js?v=2.0.0';
import { STORE_AVATARS, STORE_CONFIG, STORE_MOOD_AVATARS, STORE_LOCAL_FONTS } from './storage.js?v=2.0.0';
import { LOCAL_FONT_MAX_SIZE } from './fonts.js?v=2.0.0';

const AVATAR_SYNC_SCHEMA = 'bubble-dialogue-avatar-v8';
const AVATAR_SYNC_PREFIX = 'bdv8';
const AVATAR_SYNC_DEBOUNCE_MS = 900;
const AVATAR_SYNC_FETCH_TIMEOUT_MS = 8000;
const AVATAR_SYNC_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const AVATAR_SYNC_MAX_ENTRIES = 5000;

class AvatarSync {
  constructor(db) {
    this.db = db;
    this.writerId = this._loadWriterId();
    this.status = { state: 'idle', text: '等待同步初始化', updatedAt: Date.now() };
    this.listeners = new Set();
    this.pendingByScope = new Map();
    this.manifestCache = new Map();
    this.uploadedAssets = new Set();
    this.flushTimer = null;
    this.flushChain = Promise.resolve();
    this.refreshPromise = null;
    this.retryCount = 0;
    this.destroyed = false;
    this._installMutationHooks();
  }

  _loadWriterId() {
    const key = 'bubbleDialogueAvatarSyncWriterV8';
    try {
      let value = localStorage.getItem(key);
      if (!value) {
        value = (globalThis.crypto?.randomUUID?.() || ('writer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)));
        localStorage.setItem(key, value);
      }
      return value;
    } catch (_) {
      return 'ephemeral-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    try { listener({ ...this.status }); } catch (_) {}
    return () => this.listeners.delete(listener);
  }

  getStatus() {
    return { ...this.status };
  }

  _setStatus(state, text, error = null) {
    this.status = { state, text, error: error ? String(error.message || error) : null, updatedAt: Date.now() };
    for (const listener of this.listeners) {
      try { listener({ ...this.status }); } catch (_) {}
    }
  }

  _installMutationHooks() {
    const db = this.db;
    this._rawPut = db._put.bind(db);
    const originalPut = this._rawPut;
    db._put = async (storeName, inputRecord) => {
      let record = inputRecord;
      const syncable = storeName === STORE_AVATARS || storeName === STORE_MOOD_AVATARS;
      if (syncable && record) {
        const scope = record.syncScope || this._scopeFromRecord(storeName, record);
        if (scope && record.syncScope !== scope) record = { ...record, syncScope: scope };
      }
      const result = await originalPut(storeName, record);
      if (syncable && record) this._queueUpsert(storeName, record);
      return result;
    };

    const originalDelete = db.delete.bind(db);
    db.delete = async (charId, name) => {
      const existing = await db.get(charId, name);
      const result = await originalDelete(charId, name);
      this._queueDelete(STORE_AVATARS, {
        charId: String(charId || GLOBAL_CHAR_ID),
        name: String(name || '').trim().toLowerCase(),
        syncScope: existing?.syncScope || getAvatarSyncScopeForCharId(charId),
      });
      return result;
    };

    const originalRename = db.rename.bind(db);
    db.rename = async (charId, oldName, newName) => {
      const result = await originalRename(charId, oldName, newName);
      if (!result) return result;
      this._queueDelete(STORE_AVATARS, this._recordIdentity(STORE_AVATARS, result.previous.avatar));
      this._queueUpsert(STORE_AVATARS, result.current.avatar);
      for (let i = 0; i < result.previous.moods.length; i++) {
        this._queueDelete(STORE_MOOD_AVATARS, this._recordIdentity(STORE_MOOD_AVATARS, result.previous.moods[i]));
        this._queueUpsert(STORE_MOOD_AVATARS, result.current.moods[i]);
      }
      return result;
    };

    const originalDeleteMood = db.deleteMoodAvatar.bind(db);
    db.deleteMoodAvatar = async (charId, name, moodId) => {
      const existing = await db.getMoodAvatar(charId, name, moodId);
      const result = await originalDeleteMood(charId, name, moodId);
      this._queueDelete(STORE_MOOD_AVATARS, {
        charId: String(charId || GLOBAL_CHAR_ID),
        name: String(name || '').trim().toLowerCase(),
        moodId: String(moodId || ''),
        syncScope: existing?.syncScope || getAvatarSyncScopeForCharId(charId),
      });
      return result;
    };

    const originalDeleteAllMood = db.deleteAllMoodAvatars.bind(db);
    db.deleteAllMoodAvatars = async (charId, name) => {
      const records = await db.listMoodAvatars(charId, name);
      const result = await originalDeleteAllMood(charId, name);
      for (const record of records) {
        this._queueDelete(STORE_MOOD_AVATARS, {
          charId: record.charId,
          name: record.alias,
          moodId: record.moodId,
          syncScope: record.syncScope || getAvatarSyncScopeForCharId(charId),
        });
      }
      return result;
    };

    const originalClearAll = db.clearAll.bind(db);
    db.clearAll = async () => {
      const records = [
        ...(await this._listAll(STORE_AVATARS)),
        ...(await this._listAll(STORE_MOOD_AVATARS)),
      ];
      const result = await originalClearAll();
      for (const record of records) {
        const storeName = record.id ? STORE_MOOD_AVATARS : STORE_AVATARS;
        this._queueDelete(storeName, this._recordIdentity(storeName, record));
      }
      return result;
    };
  }

  _scopeFromRecord(storeName, record) {
    if (record?.syncScope) return record.syncScope;
    let charId = record?.charId;
    if (storeName === STORE_AVATARS) {
      charId = this._parseAvatarAlias(record?.alias).charId;
    }
    return getAvatarSyncScopeForCharId(charId);
  }

  _parseAvatarAlias(value) {
    const alias = String(value || '');
    const globalPrefix = GLOBAL_CHAR_ID + CHAR_ID_SEPARATOR;
    if (alias.startsWith(globalPrefix)) {
      return { charId: GLOBAL_CHAR_ID, name: alias.slice(globalPrefix.length) };
    }
    const splitAt = alias.indexOf(CHAR_ID_SEPARATOR);
    return splitAt >= 0
      ? { charId: alias.slice(0, splitAt), name: alias.slice(splitAt + CHAR_ID_SEPARATOR.length) }
      : { charId: GLOBAL_CHAR_ID, name: alias };
  }

  _recordIdentity(storeName, record) {
    if (storeName === STORE_MOOD_AVATARS) {
      return {
        charId: String(record?.charId || GLOBAL_CHAR_ID),
        name: String(record?.alias || '').trim().toLowerCase(),
        moodId: String(record?.moodId || ''),
        syncScope: record?.syncScope || this._scopeFromRecord(storeName, record),
      };
    }
    const parsed = this._parseAvatarAlias(record?.alias);
    return {
      charId: parsed.charId,
      name: parsed.name,
      syncScope: record?.syncScope || this._scopeFromRecord(storeName, record),
    };
  }

  _logicalId(kind, name, moodId = '') {
    const safeName = String(name || '').normalize('NFKC').trim().toLowerCase();
    return kind === 'mood' ? 'm:' + safeName + ':' + String(moodId || '') : 'a:' + safeName;
  }

  _queueUpsert(storeName, record) {
    if (this.destroyed) return;
    const identity = this._recordIdentity(storeName, record);
    if (!identity.syncScope || !identity.name) {
      this._setStatus('local', '本地已保存；当前角色缺少稳定同步身份');
      return;
    }
    const kind = storeName === STORE_MOOD_AVATARS ? 'mood' : 'avatar';
    this._queue(identity.syncScope, {
      id: this._logicalId(kind, identity.name, identity.moodId),
      kind,
      name: identity.name,
      moodId: identity.moodId || '',
      deleted: false,
      record: { ...record, syncScope: identity.syncScope },
      updatedAt: Number(record.updatedAt) || Date.now(),
    });
  }

  _queueDelete(storeName, identity) {
    if (this.destroyed || !identity?.syncScope || !identity?.name) return;
    const kind = storeName === STORE_MOOD_AVATARS ? 'mood' : 'avatar';
    this._queue(identity.syncScope, {
      id: this._logicalId(kind, identity.name, identity.moodId),
      kind,
      name: identity.name,
      moodId: identity.moodId || '',
      deleted: true,
      updatedAt: Date.now(),
    });
  }

  _queue(scope, change) {
    let changes = this.pendingByScope.get(scope);
    if (!changes) {
      changes = new Map();
      this.pendingByScope.set(scope, changes);
    }
    const previous = changes.get(change.id);
    if (!previous || this._isNewer(change, previous)) changes.set(change.id, change);
    this._setStatus('pending', '头像更改已排队，准备写入同步目录');
    this._scheduleFlush(AVATAR_SYNC_DEBOUNCE_MS);
  }

  _scheduleFlush(delay) {
    if (this.destroyed || this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow().catch((error) => {
        console.warn('[DialogueRenderer] 头像自动同步失败:', error);
      });
    }, delay);
  }

  _isNewer(candidate, current) {
    const candidateTime = Number(candidate?.updatedAt) || 0;
    const currentTime = Number(current?.updatedAt) || 0;
    if (candidateTime !== currentTime) return candidateTime > currentTime;
    return String(candidate?.writer || this.writerId) >= String(current?.writer || '');
  }

  async _digest(value) {
    const bytes = value instanceof Blob
      ? new Uint8Array(await value.arrayBuffer())
      : new TextEncoder().encode(String(value));
    if (globalThis.crypto?.subtle) {
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  async _manifestLocation(scope) {
    const hash = (await this._digest(scope)).slice(0, 32);
    const name = AVATAR_SYNC_PREFIX + '_manifest_' + hash + '.json';
    return { name, url: '/user/files/' + name };
  }

  _apiHeaders() {
    try {
      const context = getCurrentContext();
      if (typeof context?.getRequestHeaders === 'function') return context.getRequestHeaders();
    } catch (_) {}
    return { 'Content-Type': 'application/json' };
  }

  async _fetchWithTimeout(url, options = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), AVATAR_SYNC_FETCH_TIMEOUT_MS) : null;
    try {
      return await fetch(url, { credentials: 'same-origin', ...options, signal: controller?.signal });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('同步文件 Base64 编码失败'));
      reader.readAsDataURL(blob);
    });
  }

  async _uploadBlob(name, blob) {
    const data = await this._blobToBase64(blob);
    const response = await this._fetchWithTimeout('/api/files/upload', {
      method: 'POST',
      headers: this._apiHeaders(),
      body: JSON.stringify({ name, data }),
    });
    if (!response.ok) throw new Error('同步文件写入失败（HTTP ' + response.status + '）');
    const payload = await response.json();
    const path = String(payload?.path || '');
    if (!path.startsWith('/user/files/')) throw new Error('宿主返回了无效的同步文件路径');
    return path;
  }

  async _fetchManifest(scope, force = false) {
    const cached = this.manifestCache.get(scope);
    if (!force && cached && Date.now() - cached.fetchedAt < 1500) return cached.value;
    const location = await this._manifestLocation(scope);
    const response = await this._fetchWithTimeout(location.url + '?bdv8=' + Date.now(), { cache: 'no-store' });
    if (response.status === 404) {
      const empty = { schema: AVATAR_SYNC_SCHEMA, version: 1, scope, updatedAt: 0, entries: {} };
      this.manifestCache.set(scope, { value: empty, fetchedAt: Date.now(), location });
      return empty;
    }
    if (!response.ok) throw new Error('读取头像同步清单失败（HTTP ' + response.status + '）');
    const text = await response.text();
    if (text.length > AVATAR_SYNC_MAX_MANIFEST_BYTES) throw new Error('头像同步清单过大，已拒绝读取');
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { throw new Error('头像同步清单不是有效 JSON'); }
    if (parsed?.schema !== AVATAR_SYNC_SCHEMA || parsed?.version !== 1 || parsed?.scope !== scope || typeof parsed?.entries !== 'object' || !parsed.entries) {
      throw new Error('头像同步清单格式或角色分区不匹配');
    }
    if (Object.keys(parsed.entries).length > AVATAR_SYNC_MAX_ENTRIES) throw new Error('头像同步清单条目过多，已拒绝读取');
    this.manifestCache.set(scope, { value: parsed, fetchedAt: Date.now(), location });
    return parsed;
  }

  _extensionForMime(mimeType) {
    const map = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
      'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
    };
    return map[String(mimeType || '').toLowerCase()] || 'webp';
  }

  _safeAssetUrl(value) {
    const url = String(value || '').trim();
    return /^\/user\/files\/bdv8_[a-f0-9]{8,64}\.(?:jpg|png|gif|webp|avif|bmp)$/i.test(url) ? url : null;
  }

  _safeSourceUrl(value) {
    const url = String(value || '').trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(url)) return url;
    if (/^\/user\/files\/[A-Za-z0-9._~%+-]+$/i.test(url)) return url;
    return null;
  }

  async _prepareEntry(scope, change) {
    const base = {
      id: change.id,
      kind: change.kind,
      name: String(change.name || '').trim().toLowerCase(),
      moodId: change.kind === 'mood' ? String(change.moodId || '') : '',
      scope,
      updatedAt: Number(change.updatedAt) || Date.now(),
      writer: this.writerId,
    };
    if (change.deleted) return { ...base, deleted: true };

    const record = change.record || {};
    let assetUrl = this._safeAssetUrl(record.syncedUrl);
    let sourceUrl = this._safeSourceUrl(record.sourceUrl);
    if (!assetUrl && sourceUrl?.startsWith('/user/files/')) {
      const ownedAssetUrl = this._safeAssetUrl(sourceUrl);
      if (ownedAssetUrl) {
        assetUrl = ownedAssetUrl;
        sourceUrl = null;
      }
    }
    if (record.imageBlob instanceof Blob) {
      const hash = await this._digest(record.imageBlob);
      const assetName = AVATAR_SYNC_PREFIX + '_' + hash + '.' + this._extensionForMime(record.imageBlob.type || record.mimeType);
      assetUrl = '/user/files/' + assetName;
      if (!this.uploadedAssets.has(assetName)) {
        await this._uploadBlob(assetName, record.imageBlob);
        this.uploadedAssets.add(assetName);
      }
    }
    if (!assetUrl && !sourceUrl) throw new Error('头像“' + base.name + '”没有可同步的图片数据');
    return {
      ...base,
      deleted: false,
      assetUrl,
      sourceUrl,
      mimeType: /^image\//i.test(String(record.mimeType || '')) ? record.mimeType : 'image/webp',
      fileName: String(record.fileName || ''),
      fileSize: Number(record.fileSize) || (record.imageBlob?.size || 0),
      width: Number(record.width) || 0,
      height: Number(record.height) || 0,
    };
  }

  async _mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async _flushScope(scope, changes) {
    const current = await this._fetchManifest(scope, true);
    const prepared = await this._mapLimit(Array.from(changes.values()), 3, (change) => this._prepareEntry(scope, change));
    const entries = { ...current.entries };
    let changed = false;
    for (const entry of prepared) {
      const existing = entries[entry.id];
      if (!existing || this._isNewer(entry, existing)) {
        entries[entry.id] = entry;
        changed = true;
      }
    }
    if (!changed) return current;
    const next = {
      schema: AVATAR_SYNC_SCHEMA,
      version: 1,
      scope,
      updatedAt: Date.now(),
      writer: this.writerId,
      entries,
    };
    const location = await this._manifestLocation(scope);
    const blob = new Blob([JSON.stringify(next)], { type: 'application/json' });
    await this._uploadBlob(location.name, blob);
    this.manifestCache.set(scope, { value: next, fetchedAt: Date.now(), location });
    return next;
  }

  _restoreBatch(scope, changes) {
    let target = this.pendingByScope.get(scope);
    if (!target) {
      target = new Map();
      this.pendingByScope.set(scope, target);
    }
    for (const [id, change] of changes) {
      const existing = target.get(id);
      if (!existing || this._isNewer(change, existing)) target.set(id, change);
    }
  }

  async flushNow() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingByScope.size) return this.flushChain;
    const batches = this.pendingByScope;
    this.pendingByScope = new Map();
    const run = async () => {
      this._setStatus('syncing', '正在写入头像同步目录…');
      try {
        for (const [scope, changes] of batches) await this._flushScope(scope, changes);
        this.retryCount = 0;
        this._setStatus('synced', '已写入同步目录；等待宿主同步到其他设备');
      } catch (error) {
        for (const [scope, changes] of batches) this._restoreBatch(scope, changes);
        this.retryCount += 1;
        this._setStatus('error', '头像同步暂不可用：' + String(error.message || error), error);
        if (this.retryCount <= 3) this._scheduleFlush([5000, 20000, 60000][this.retryCount - 1]);
        throw error;
      }
    };
    this.flushChain = this.flushChain.then(run, run);
    return this.flushChain;
  }

  async _listAll(storeName) {
    await this.db._ensureDB();
    if (!this.db.db.objectStoreNames.contains(storeName)) return [];
    return new Promise((resolve, reject) => {
      const request = this.db.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(new Error('读取本地头像列表失败'));
    });
  }

  _entryToRecord(entry, localCharId) {
    const syncedUrl = this._safeAssetUrl(entry.assetUrl);
    const sourceUrl = this._safeSourceUrl(entry.sourceUrl);
    if (!syncedUrl && !sourceUrl) return null;
    const common = {
      imageBlob: null,
      syncedUrl,
      sourceUrl,
      syncScope: entry.scope,
      mimeType: /^image\//i.test(String(entry.mimeType || '')) ? entry.mimeType : 'image/webp',
      fileName: String(entry.fileName || ''),
      fileSize: Number(entry.fileSize) || 0,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      createdAt: Number(entry.updatedAt) || Date.now(),
      updatedAt: Number(entry.updatedAt) || Date.now(),
    };
    if (entry.kind === 'mood') {
      return {
        ...common,
        id: buildMoodAvatarKey(localCharId, entry.name, entry.moodId),
        charId: String(localCharId),
        alias: entry.name,
        moodId: entry.moodId,
      };
    }
    return { ...common, alias: buildAvatarKey(localCharId, entry.name) };
  }

  _validateEntry(scope, id, entry) {
    if (!entry || entry.scope !== scope || entry.id !== id) return false;
    if (entry.kind !== 'avatar' && entry.kind !== 'mood') return false;
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200) return false;
    if (entry.kind === 'mood' && (typeof entry.moodId !== 'string' || !entry.moodId || entry.moodId.length > 100)) return false;
    return id === this._logicalId(entry.kind, entry.name, entry.moodId);
  }

  async _applyManifest(scope, manifest) {
    const currentScope = getCurrentCharacterSyncScope();
    const localCharId = scope === 'global'
      ? GLOBAL_CHAR_ID
      : (scope === currentScope ? String(getCurrentCharId() || '') : '');
    if (!localCharId) return;

    const avatarRecords = await this._listAll(STORE_AVATARS);
    const moodRecords = await this._listAll(STORE_MOOD_AVATARS);
    const localById = new Map();
    for (const record of avatarRecords) {
      const identity = this._recordIdentity(STORE_AVATARS, record);
      if ((record.syncScope || getAvatarSyncScopeForCharId(identity.charId)) === scope) {
        localById.set(this._logicalId('avatar', identity.name), { storeName: STORE_AVATARS, record });
      }
    }
    for (const record of moodRecords) {
      const identity = this._recordIdentity(STORE_MOOD_AVATARS, record);
      if ((record.syncScope || getAvatarSyncScopeForCharId(identity.charId)) === scope) {
        localById.set(this._logicalId('mood', identity.name, identity.moodId), { storeName: STORE_MOOD_AVATARS, record });
      }
    }

    const operations = [];
    for (const [id, entry] of Object.entries(manifest.entries)) {
      if (!this._validateEntry(scope, id, entry)) continue;
      const local = localById.get(id);
      const localTime = Number(local?.record?.updatedAt) || 0;
      const remoteTime = Number(entry.updatedAt) || 0;
      if (local && remoteTime < localTime) continue;
      if (entry.deleted) {
        if (local) operations.push({ type: 'delete', storeName: local.storeName, key: local.record.id || local.record.alias });
        continue;
      }
      const record = this._entryToRecord(entry, localCharId);
      if (record) operations.push({ type: 'put', storeName: entry.kind === 'mood' ? STORE_MOOD_AVATARS : STORE_AVATARS, record });
    }
    if (!operations.length) return;

    const stores = [...new Set(operations.map((operation) => operation.storeName))];
    const transaction = this.db.db.transaction(stores, 'readwrite');
    for (const operation of operations) {
      const store = transaction.objectStore(operation.storeName);
      const cacheKey = operation.storeName === STORE_MOOD_AVATARS
        ? 'mood_' + (operation.record?.id || operation.key)
        : (operation.record?.alias || operation.key);
      this.db._revokeCachedUrl(cacheKey);
      if (operation.type === 'put') store.put(operation.record);
      else store.delete(operation.key);
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('应用远端头像清单失败'));
      transaction.onabort = () => reject(new Error('应用远端头像清单被中止'));
    });
  }

  async _queueNewerLocalRecords(scope, manifest) {
    const records = [
      ...(await this._listAll(STORE_AVATARS)).map((record) => [STORE_AVATARS, record]),
      ...(await this._listAll(STORE_MOOD_AVATARS)).map((record) => [STORE_MOOD_AVATARS, record]),
    ];
    for (const [storeName, record] of records) {
      const identity = this._recordIdentity(storeName, record);
      const recordScope = record.syncScope || this._scopeFromRecord(storeName, record);
      if (recordScope !== scope) continue;
      const kind = storeName === STORE_MOOD_AVATARS ? 'mood' : 'avatar';
      const id = this._logicalId(kind, identity.name, identity.moodId);
      const remote = manifest.entries[id];
      const localTime = Number(record.updatedAt) || 0;
      if (!remote || localTime > (Number(remote.updatedAt) || 0)) this._queueUpsert(storeName, { ...record, syncScope: scope });
    }
  }

  async refreshCurrentScope({ publishLocal = true, force = false } = {}) {
    if (this.destroyed) return;
    if (this.refreshPromise && !force) return this.refreshPromise;
    const run = async () => {
      await this.db.init();
      const scopes = ['global', getCurrentCharacterSyncScope()].filter(Boolean);
      const uniqueScopes = [...new Set(scopes)];
      this._setStatus('syncing', '正在读取头像同步清单…');
      for (const scope of uniqueScopes) {
        const manifest = await this._fetchManifest(scope, true);
        await this._applyManifest(scope, manifest);
        if (publishLocal) await this._queueNewerLocalRecords(scope, manifest);
      }
      if (this.pendingByScope.size) await this.flushNow();
      else this._setStatus('synced', '头像同步目录已是最新');
    };
    const previous = force && this.refreshPromise ? this.refreshPromise.catch(() => {}) : Promise.resolve();
    const promise = previous.then(run).catch((error) => {
      this._setStatus('error', '头像同步暂不可用：' + String(error.message || error), error);
      throw error;
    });
    const tracked = promise.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = null;
    });
    this.refreshPromise = tracked;
    return tracked;
  }

  async init() {
    return this.refreshCurrentScope({ publishLocal: true });
  }

  destroy() {
    this.destroyed = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.listeners.clear();
  }
}


// 全局正文样式：每个设置独立保存修订号，字体按内容寻址；网络传输复用头像同步通道。
const GLOBAL_STYLE_SYNC_KEY = 'global_style_sync_v1';
const GLOBAL_STYLE_SYNC_FILE = 'bdv8_global_style_v1.json';
const GLOBAL_STYLE_SYNC_SCHEMA = 'bubble-dialogue-global-style-v8';
const GLOBAL_STYLE_SYNC_KEYS = new Set([...STYLE_CONFIG_KEYS, 'style_cssFontUrls']);

class GlobalStyleSync {
  constructor(db, transport, onApplied = async () => {}) {
    this.db = db;
    this.transport = transport;
    this.onApplied = onApplied;
    this.writer = transport.writerId;
    this.localChain = Promise.resolve();
    this.refreshPromise = null;
    this.refreshAgain = false;
    this.timer = null;
    this.destroyed = false;
    this.retries = 0;
    this.listeners = new Set();
    this.status = { state: 'idle', text: '等待同步初始化' };
    this._installHooks();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  getStatus() { return { ...this.status }; }

  _setStatus(state, text) {
    this.status = { state, text };
    for (const listener of this.listeners) {
      try { listener(this.getStatus()); } catch (error) { console.warn('[DialogueRenderer] 样式同步状态通知失败:', error); }
    }
  }

  _serial(run) {
    const task = this.localChain.then(run, run);
    this.localChain = task.catch(() => {});
    return task;
  }

  _newer(a, b) {
    if (!b) return true;
    return a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.writer > b.writer);
  }

  _sameRevision(a, b) {
    return Boolean(a && b && a.updatedAt === b.updatedAt && a.writer === b.writer);
  }

  async _state() {
    await this.db._ensureDB();
    const saved = await this.db.getConfig(GLOBAL_STYLE_SYNC_KEY, null);
    if (saved) return saved;
    // 无修订号的旧设置只用于首次播种；设备默认值不会覆盖已有远端设置。
    const entries = {};
    const config = await this.db.getAllConfig();
    for (const key of GLOBAL_STYLE_SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(config, key)) {
        entries['config:' + key] = { kind: 'config', key, value: config[key], updatedAt: 0, writer: '' };
      }
    }
    for (const font of await this.db.listLocalFonts()) {
      entries['font:' + font.id] = { ...this._fontEntry(font), updatedAt: 0, writer: '' };
    }
    return { entries };
  }

  _fontEntry(font) {
    return {
      kind: 'font', key: font.id, deleted: false,
      value: { id: font.id, family: font.family, name: font.name, fileName: font.fileName,
        fileSize: font.fontBlob.size, format: font.format, mimeType: font.mimeType, assetUrl: null },
    };
  }

  // 实际设置/字体和待同步修订在同一事务落盘，离线或退出后不会丢失待传更改。
  async _commit(state, operations = []) {
    await this.db._ensureDB();
    const stores = [...new Set([STORE_CONFIG, ...operations.map(operation => operation.store)])];
    const tx = this.db.db.transaction(stores, 'readwrite');
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(new Error('全局样式保存失败'));
      tx.onabort = () => reject(new Error('全局样式保存已中止'));
    });
    for (const operation of operations) {
      const store = tx.objectStore(operation.store);
      if (operation.deleted) store.delete(operation.key);
      else store.put(operation.record);
    }
    tx.objectStore(STORE_CONFIG).put({ key: GLOBAL_STYLE_SYNC_KEY, value: { ...state, initialized: true } });
    await done;
    const settings = {};
    for (const operation of operations) {
      if (operation.store === STORE_CONFIG && operation.record) settings[operation.record.key] = operation.record.value;
    }
    if (Object.keys(settings).length) writeStyleSnapshot(settings);
  }

  _change(entry, operation) {
    return this._serial(async () => {
      const state = await this._state();
      const id = entry.kind + ':' + entry.key;
      const previous = state.entries[id];
      if (entry.kind === 'config' && previous && JSON.stringify(previous.value) === JSON.stringify(entry.value)) return;
      const latest = Math.max(0, ...Object.values(state.entries).map(item => item.updatedAt));
      state.entries[id] = { ...entry, updatedAt: Math.max(Date.now(), latest + 1), writer: this.writer };
      await this._commit(state, [operation]);
      this._setStatus('pending', '美化设置已保存，等待同步');
      this._schedule();
    });
  }

  _installHooks() {
    const originalPut = this.db._put.bind(this.db);
    this.db._put = (store, record) => {
      if (store === STORE_CONFIG && GLOBAL_STYLE_SYNC_KEYS.has(record.key)) {
        return this._change({ kind: 'config', key: record.key, value: record.value }, { store, record });
      }
      if (store === STORE_LOCAL_FONTS) {
        return this._change(this._fontEntry(record), { store, record });
      }
      return originalPut(store, record);
    };
    this.db.deleteLocalFont = family => {
      const key = this.db._buildLocalFontId(family);
      return this._change({ kind: 'font', key, deleted: true }, { store: STORE_LOCAL_FONTS, key, deleted: true });
    };
    const originalClear = this.db.clearAll.bind(this.db);
    this.db.clearAll = () => this._serial(async () => {
      const state = await this._state();
      const time = Math.max(Date.now(), ...Object.values(state.entries).map(entry => entry.updatedAt + 1));
      for (const key of GLOBAL_STYLE_SYNC_KEYS) state.entries['config:' + key] = {
        kind: 'config', key, value: key === 'style_cssFontUrls' ? '[]' : STYLE_DEFAULTS[key], updatedAt: time, writer: this.writer,
      };
      for (const [id, entry] of Object.entries(state.entries)) {
        if (entry.kind === 'font') state.entries[id] = { kind: 'font', key: entry.key, deleted: true, updatedAt: time, writer: this.writer };
      }
      await originalClear();
      await this._commit(state);
      this._schedule();
    });
  }

  _schedule(delay = 900) {
    if (this.destroyed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch(error => console.warn('[DialogueRenderer] 全局样式同步失败:', error));
    }, delay);
  }

  _validate(id, entry, remote = true) {
    if (!entry || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0 || typeof entry.writer !== 'string') throw new Error('美化同步修订号无效');
    if (id !== entry.kind + ':' + entry.key) throw new Error('美化同步条目标识不匹配');
    if (entry.kind === 'config') {
      if (!GLOBAL_STYLE_SYNC_KEYS.has(entry.key)) throw new Error('未知的美化配置项：' + entry.key);
      const expected = entry.key === 'style_cssFontUrls' ? 'string' : typeof STYLE_DEFAULTS[entry.key];
      if (typeof entry.value !== expected || (expected === 'number' && !Number.isFinite(entry.value))) throw new Error('美化配置值类型不正确：' + entry.key);
      if (entry.key === 'style_cssFontUrls' && !Array.isArray(JSON.parse(entry.value))) throw new Error('CSS 字体清单无效');
      return;
    }
    if (entry.kind !== 'font' || typeof entry.key !== 'string' || !entry.key.startsWith('local__')) throw new Error('美化同步字体标识无效');
    if (entry.deleted === true) return;
    const font = entry.value;
    if (!font || typeof font.family !== 'string' || !font.family.trim() || font.id !== entry.key || font.id !== this.db._buildLocalFontId(font.family)) throw new Error('美化同步字体信息无效');
    if (!Number.isSafeInteger(font.fileSize) || font.fileSize <= 0 || font.fileSize > LOCAL_FONT_MAX_SIZE) throw new Error('同步字体大小超限');
    if (remote && !/^\/user\/files\/bdv8_font_[a-f0-9]{8,64}\.(?:woff2?|ttf|otf)$/.test(font.assetUrl || '')) throw new Error('同步字体路径无效');
    if (!['woff2', 'woff', 'truetype', 'opentype', ''].includes(font.format)) throw new Error('同步字体格式无效');
  }

  async _readRemote() {
    const response = await this.transport._fetchWithTimeout('/user/files/' + GLOBAL_STYLE_SYNC_FILE + '?t=' + Date.now(), { cache: 'no-store' });
    if (response.status === 404) return { entries: {} };
    if (!response.ok) throw new Error('读取全局美化配置失败（HTTP ' + response.status + '）');
    const text = await response.text();
    if (text.length > 512 * 1024) throw new Error('美化同步清单过大');
    const manifest = JSON.parse(text);
    if (manifest.schema !== GLOBAL_STYLE_SYNC_SCHEMA || manifest.version !== 1 || manifest.scope !== 'global' || !manifest.entries || Array.isArray(manifest.entries) || typeof manifest.entries !== 'object') throw new Error('美化同步清单格式不匹配');
    if (Object.keys(manifest.entries).length > 512) throw new Error('美化同步清单条目过多');
    for (const [id, entry] of Object.entries(manifest.entries)) this._validate(id, entry);
    return manifest;
  }

  async _downloadFont(entry) {
    const response = await this.transport._fetchWithTimeout(entry.value.assetUrl);
    if (!response.ok) throw new Error('同步字体下载失败（HTTP ' + response.status + '）');
    const blob = await response.blob();
    if (blob.size !== entry.value.fileSize || blob.size > LOCAL_FONT_MAX_SIZE) throw new Error('同步字体文件大小不匹配');
    const hash = await this.transport._digest(blob);
    if (!entry.value.assetUrl.includes('_' + hash + '.')) throw new Error('同步字体内容校验失败');
    return { ...entry.value, fontBlob: blob, createdAt: entry.updatedAt };
  }

  async _refresh() {
    this._setStatus('syncing', '正在同步全局美化配置…');
    const remote = await this._readRemote();
    const snapshot = await this._serial(() => this._state());
    const candidates = Object.entries(remote.entries).filter(([id, entry]) => this._newer(entry, snapshot.entries[id]));
    const prepared = await this.transport._mapLimit(candidates, 3, async ([id, entry]) => {
      const font = entry.kind === 'font' && !entry.deleted ? await this._downloadFont(entry) : null;
      return { id, entry, font };
    });
    let applied = false;
    await this._serial(async () => {
      const state = await this._state();
      const operations = [];
      for (const { id, entry, font } of prepared) {
        // 下载期间可能发生本地编辑；提交前必须再次比较修订。
        if (!this._newer(entry, state.entries[id])) continue;
        state.entries[id] = entry;
        if (entry.kind === 'config') operations.push({ store: STORE_CONFIG, record: { key: entry.key, value: entry.value } });
        else operations.push({ store: STORE_LOCAL_FONTS, key: entry.key, deleted: entry.deleted === true, record: font });
      }
      if (operations.length || !state.initialized) await this._commit(state, operations);
      applied = operations.length > 0;
    });
    if (applied) await this.onApplied();

    const local = await this._serial(() => this._state());
    const entries = { ...remote.entries };
    let changed = false;
    for (const [id, entry] of Object.entries(local.entries)) {
      if (!this._newer(entry, entries[id])) continue;
      this._validate(id, entry, false);
      let next = entry.updatedAt === 0 ? { ...entry, updatedAt: 1, writer: this.writer } : entry;
      if (entry.kind === 'font' && !entry.deleted && !entry.value.assetUrl) {
        const font = await this.db._getByKey(STORE_LOCAL_FONTS, entry.key);
        if (!font?.fontBlob) throw new Error('待同步字体缺失：' + entry.value.family);
        // 如果字体在读取前已被更新，留给下一轮处理，避免把新 Blob 记入旧修订。
        const current = await this._serial(() => this._state());
        if (!this._sameRevision(entry, current.entries[id])) { this._schedule(); continue; }
        const hash = await this.transport._digest(font.fontBlob);
        const ext = ({ woff2: 'woff2', woff: 'woff', truetype: 'ttf', opentype: 'otf' })[font.format];
        if (!ext) throw new Error('不支持的同步字体格式：' + font.format);
        const name = 'bdv8_font_' + hash + '.' + ext;
        await this.transport._uploadBlob(name, font.fontBlob);
        next = { ...next, value: { ...entry.value, assetUrl: '/user/files/' + name } };
      }
      entries[id] = next;
      changed = true;
    }
    if (changed) {
      const manifest = { schema: GLOBAL_STYLE_SYNC_SCHEMA, version: 1, scope: 'global', entries };
      const json = JSON.stringify(manifest);
      if (json.length > 512 * 1024 || Object.keys(entries).length > 512) throw new Error('美化同步清单超过限制');
      await this.transport._uploadBlob(GLOBAL_STYLE_SYNC_FILE, new Blob([json], { type: 'application/json' }));
      await this._serial(async () => {
        const state = await this._state();
        for (const [id, entry] of Object.entries(entries)) {
          if (this._sameRevision(local.entries[id], state.entries[id])) state.entries[id] = entry;
        }
        await this._commit(state);
      });
    }
    this.retries = 0;
    this._setStatus('synced', '全局美化已写入同步目录；跨设备需同步 user.files');
  }

  refresh() {
    if (this.destroyed) return Promise.resolve();
    if (this.refreshPromise) { this.refreshAgain = true; return this.refreshPromise; }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const task = this._refresh().catch(error => {
      this._setStatus('error', '美化同步失败：' + String(error.message || error));
      if (++this.retries <= 3) this._schedule([5000, 20000, 60000][this.retries - 1]);
      throw error;
    }).finally(() => {
      this.refreshPromise = null;
      if (this.refreshAgain) { this.refreshAgain = false; this._schedule(); }
    });
    this.refreshPromise = task;
    return task;
  }

  destroy() {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

export { AvatarSync, GlobalStyleSync };
