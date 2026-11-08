import { STYLE_DEFAULTS, STYLE_CONFIG_KEYS, normalizeMoodConfig, writeStyleSnapshot, clearStyleSnapshot } from "./config.js?v=2.1.2";
import { GLOBAL_CHAR_ID, CHAR_ID_SEPARATOR, buildAvatarKey, buildMoodAvatarKey, buildColorConfigKey, extractDisplayName, getAvatarSyncScopeForCharId, getCurrentCharName } from "./context.js?v=2.1.2";
import { FONT_EXT_FORMAT_MAP, FONT_EXT_MIME_MAP } from "./fonts.js?v=2.1.2";
import { zipCreate, zipExtract, mimeToExt, extToMime, safeFileName } from "./zip.js?v=2.1.2";
import { compressImage, getCompressOptions } from "./image-utils.js?v=2.1.2";
import { PROTOCOL_VERSION, PROMPT_TEMPLATE_KEY, loadPromptSettings, validatePromptTemplate } from "./protocol.js?v=2.1.2";

const DB_NAME = 'BubbleDialogueAvatarsV8';
const DB_VERSION = 1;
const STORE_AVATARS = 'avatars';
const STORE_CONFIG = 'config';
const STORE_MOOD_AVATARS = 'mood_avatars';
const STORE_LOCAL_FONTS = 'local_fonts';
const TEMPLATE_VERSION = '2.1';

class AvatarDB {
  constructor({ dbName = DB_NAME } = {}) {
    this.dbName = dbName;
    this.db = null;
    this._blobUrlCache = new Map();
  }

  async init() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_AVATARS)) {
          const store = db.createObjectStore(STORE_AVATARS, { keyPath: 'alias' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_CONFIG)) {
          db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_MOOD_AVATARS)) {
          const moodStore = db.createObjectStore(STORE_MOOD_AVATARS, { keyPath: 'id' });
          moodStore.createIndex('charId', 'charId', { unique: false });
          moodStore.createIndex('alias', 'alias', { unique: false });
          moodStore.createIndex('moodId', 'moodId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_LOCAL_FONTS)) {
          db.createObjectStore(STORE_LOCAL_FONTS, { keyPath: 'id' });
        }

      };
      request.onsuccess = (event) => { this.db = event.target.result; resolve(this.db); };
      request.onerror = (event) => { reject(new Error(`IndexedDB 打开失败: ${event.target.error}`)); };
    });
  }

  async _ensureDB() { if (!this.db) await this.init(); }

  _recordMatchesStorageScope(record, charId) {
    if (!record) return false;
    const safeCharId = String(charId == null ? '' : charId);
    if (!safeCharId) return false;
    if (safeCharId === GLOBAL_CHAR_ID) {
      return !record.syncScope || record.syncScope === 'global';
    }
    const expectedScope = getAvatarSyncScopeForCharId(safeCharId);
    return Boolean(expectedScope && record.syncScope === expectedScope);
  }

  // -- 头像 CRUD --

  async add(charId, name, imageBlob, metadata = {}) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    const existing = await this.get(charId, name);
    if (existing) throw new Error(`角色名 "${name}" 已存在，请使用 update() 或换一个角色名`);
    const record = {
      alias: key, imageBlob,
      syncedUrl: metadata.syncedUrl || null,
      mimeType: imageBlob ? (imageBlob.type || 'image/jpeg') : (metadata.mimeType || 'image/webp'),
      fileName: metadata.fileName || `${name.trim().toLowerCase()}.jpg`,
      fileSize: imageBlob ? imageBlob.size : 0,
      width: metadata.width || 0,
      height: metadata.height || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    return this._put(STORE_AVATARS, record);
  }

  async get(charId, name) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    const record = await this._getByKey(STORE_AVATARS, key);
    return this._recordMatchesStorageScope(record, charId) ? record : null;
  }

  _recordUrl(cacheKey, record) {
    if (this._blobUrlCache.has(cacheKey)) return this._blobUrlCache.get(cacheKey);
    if (!record) return null;
    if (record.imageBlob) {
      const url = URL.createObjectURL(record.imageBlob);
      this._blobUrlCache.set(cacheKey, url);
      return url;
    }
    return record.syncedUrl || null;
  }

  async getBlobUrl(charId, name) {
    const key = buildAvatarKey(charId, name);
    return this._recordUrl(key, await this.get(charId, name));
  }

  async update(charId, name, imageBlob, metadata = {}) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    const existing = await this.get(charId, name);
    if (!existing) throw new Error(`角色名 "${name}" 不存在`);
    this._revokeCachedUrl(key);
    const record = {
      ...existing, imageBlob,
      syncedUrl: metadata.syncedUrl !== undefined ? metadata.syncedUrl : null,
      mimeType: imageBlob ? (imageBlob.type || metadata.mimeType || existing.mimeType) : (metadata.mimeType || existing.mimeType),
      fileName: metadata.fileName || existing.fileName,
      fileSize: imageBlob ? imageBlob.size : 0,
      width: metadata.width || existing.width,
      height: metadata.height || existing.height,
      updatedAt: Date.now()
    };
    return this._put(STORE_AVATARS, record);
  }

  async rename(charId, oldName, newName) {
    await this._ensureDB();
    const oldKey = buildAvatarKey(charId, oldName);
    const newKey = buildAvatarKey(charId, newName);
    if (oldKey === newKey) return null;
    if (!newName.trim()) throw new Error('角色名不能为空');
    const oldColorKey = buildColorConfigKey(charId, oldName);
    const newColorKey = buildColorConfigKey(charId, newName);
    const changes = await new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_AVATARS, STORE_MOOD_AVATARS, STORE_CONFIG], 'readwrite');
      const avatars = tx.objectStore(STORE_AVATARS);
      const moods = tx.objectStore(STORE_MOOD_AVATARS);
      const config = tx.objectStore(STORE_CONFIG);
      const reads = [avatars.get(oldKey), avatars.get(newKey),
        moods.index('charId').getAll(IDBKeyRange.only(charId)), config.get(oldColorKey), config.get(newColorKey)];
      let remaining = reads.length;
      let failure;
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || new Error('角色重命名事务失败：' + (tx.error?.message || '已取消')));
      for (const request of reads) request.onsuccess = () => {
        if (--remaining) return;
        const [source, target, allMoods, color, targetColor] = reads.map(read => read.result);
        const oldAlias = oldName.trim().toLowerCase();
        const newAlias = newName.trim().toLowerCase();
        if (!this._recordMatchesStorageScope(source, charId)) failure = new Error(`角色名 "${oldName}" 不存在`);
        else if (target || targetColor?.value != null || allMoods.some(mood => mood.alias === newAlias)) {
          failure = new Error(`角色名 "${newName}" 已有头像、差分或颜色，不能覆盖`);
        }
        if (failure) { tx.abort(); return; }
        const previousMoods = allMoods.filter(mood => mood.alias === oldAlias);
        const updatedAt = Date.now();
        const currentAvatar = { ...source, alias: newKey, updatedAt };
        const currentMoods = previousMoods.map(mood => ({ ...mood, alias: newAlias,
          id: buildMoodAvatarKey(charId, newName, mood.moodId), updatedAt }));
        avatars.delete(oldKey); avatars.put(currentAvatar);
        for (let i = 0; i < previousMoods.length; i++) {
          moods.delete(previousMoods[i].id); moods.put(currentMoods[i]);
        }
        if (color) { config.delete(oldColorKey); config.put({ ...color, key: newColorKey }); }
        result = { previous: { avatar: source, moods: previousMoods }, current: { avatar: currentAvatar, moods: currentMoods } };
      };
    });
    this._revokeCachedUrl(oldKey);
    for (const mood of changes.previous.moods) this._revokeCachedUrl('mood_' + mood.id);
    return changes;
  }

  async delete(charId, name) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    this._revokeCachedUrl(key);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_AVATARS, 'readwrite');
      const req = tx.objectStore(STORE_AVATARS).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`删除失败`));
    });
  }

  async list(charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const prefix = safeCharId + CHAR_ID_SEPARATOR;
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll(range);
      req.onsuccess = () => {
        const records = req.result.filter(r => this._recordMatchesStorageScope(r, safeCharId));
        resolve(records.map(r => ({
          alias: r.alias, displayName: extractDisplayName(r.alias, safeCharId),
          mimeType: r.mimeType, fileName: r.fileName,
          fileSize: r.fileSize, width: r.width, height: r.height,
          createdAt: r.createdAt, updatedAt: r.updatedAt
        })));
      };
      req.onerror = () => reject(new Error(`列表查询失败`));
    });
  }

  async getStats(charId) {
    await this._ensureDB();
    const prefix = String(charId || GLOBAL_CHAR_ID) + CHAR_ID_SEPARATOR;
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll(range);
      req.onsuccess = () => {
        const records = req.result.filter(r => this._recordMatchesStorageScope(r, charId));
        resolve({ count: records.length, totalSize: records.reduce((s, r) => s + (r.fileSize || 0), 0) });
      };
      req.onerror = () => reject(new Error(`统计查询失败`));
    });
  }

  // -- 情绪差分头像 CRUD --

  async addMoodAvatar(charId, name, moodId, imageBlob, metadata = {}) {
    await this._ensureDB();
    const id = buildMoodAvatarKey(charId, name, moodId);
    this._revokeCachedUrl('mood_' + id);
    const safeName = name.trim().toLowerCase();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const record = {
      id, charId: safeCharId, alias: safeName, moodId,
      imageBlob,
      syncedUrl: metadata.syncedUrl || null,
      mimeType: imageBlob ? (imageBlob.type || 'image/jpeg') : (metadata.mimeType || 'image/webp'),
      fileName: metadata.fileName || `${safeName}-${moodId}.jpg`,
      fileSize: imageBlob ? imageBlob.size : 0,
      width: metadata.width || 0,
      height: metadata.height || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    return this._put(STORE_MOOD_AVATARS, record);
  }

  async getMoodAvatar(charId, name, moodId) {
    await this._ensureDB();
    const id = buildMoodAvatarKey(charId, name, moodId);
    const record = await this._getByKey(STORE_MOOD_AVATARS, id);
    return this._recordMatchesStorageScope(record, charId) ? record : null;
  }

  async getMoodAvatarBlobUrl(charId, name, moodId) {
    const cacheKey = 'mood_' + buildMoodAvatarKey(charId, name, moodId);
    return this._recordUrl(cacheKey, await this.getMoodAvatar(charId, name, moodId));
  }

  async listMoodAvatars(charId, name) {
    await this._ensureDB();
    const safeName = name.trim().toLowerCase();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_MOOD_AVATARS, 'readonly');
      const index = tx.objectStore(STORE_MOOD_AVATARS).index('charId');
      const req = index.getAll(IDBKeyRange.only(safeCharId));
      req.onsuccess = () => {
        resolve(req.result.filter(r => r.alias === safeName && this._recordMatchesStorageScope(r, safeCharId)));
      };
      req.onerror = () => reject(new Error(`情绪差分列表查询失败`));
    });
  }

  async deleteMoodAvatar(charId, name, moodId) {
    await this._ensureDB();
    const id = buildMoodAvatarKey(charId, name, moodId);
    const cacheKey = 'mood_' + id;
    if (this._blobUrlCache.has(cacheKey)) {
      URL.revokeObjectURL(this._blobUrlCache.get(cacheKey));
      this._blobUrlCache.delete(cacheKey);
    }
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_MOOD_AVATARS, 'readwrite');
      const req = tx.objectStore(STORE_MOOD_AVATARS).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`情绪差分删除失败`));
    });
  }

  async deleteAllMoodAvatars(charId, name) {
    await this._ensureDB();
    const moodAvatars = await this.listMoodAvatars(charId, name);
    const tx = this.db.transaction(STORE_MOOD_AVATARS, 'readwrite');
    const store = tx.objectStore(STORE_MOOD_AVATARS);
    for (const ma of moodAvatars) {
      store.delete(ma.id);
      const cacheKey = 'mood_' + ma.id;
      if (this._blobUrlCache.has(cacheKey)) {
        URL.revokeObjectURL(this._blobUrlCache.get(cacheKey));
        this._blobUrlCache.delete(cacheKey);
      }
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(`情绪差分批量删除失败`));
    });
  }

  // -- 本地字体 CRUD --

  _buildLocalFontId(family) {
    return 'local__' + family.trim();
  }

  async addLocalFont(family, fontBlob, metadata = {}) {
    await this._ensureDB();
    const id = this._buildLocalFontId(family);
    const ext = (metadata.fileName || '').split('.').pop()?.toLowerCase() || '';
    const record = {
      id, family: family.trim(), name: metadata.name || family.trim(),
      fontBlob,
      mimeType: metadata.mimeType || FONT_EXT_MIME_MAP[ext] || 'application/octet-stream',
      fileName: metadata.fileName || `${family}.${ext || 'woff2'}`,
      fileSize: fontBlob.size,
      format: FONT_EXT_FORMAT_MAP[ext] || '',
      createdAt: Date.now(),
    };
    return this._put(STORE_LOCAL_FONTS, record);
  }

  async getLocalFont(family) {
    await this._ensureDB();
    const id = this._buildLocalFontId(family);
    return this._getByKey(STORE_LOCAL_FONTS, id);
  }

  async listLocalFonts() {
    await this._ensureDB();
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_LOCAL_FONTS, 'readonly').objectStore(STORE_LOCAL_FONTS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error('本地字体列表查询失败'));
    });
  }

  async deleteLocalFont(family) {
    await this._ensureDB();
    const id = this._buildLocalFontId(family);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_LOCAL_FONTS, 'readwrite');
      const req = tx.objectStore(STORE_LOCAL_FONTS).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error('本地字体删除失败'));
    });
  }

  // -- CSS 字体源管理 --

  async getCssFontSources() {
    const raw = await this.getConfig('style_cssFontUrls', '[]');
    const sources = JSON.parse(raw);
    if (!Array.isArray(sources)) throw new Error('CSS 字体源配置必须是数组');
    return sources;
  }

  async addCssFontSource(url, families) {
    const sources = await this.getCssFontSources();
    const existing = sources.findIndex(s => s.url === url);
    const entry = { url, families: families || [], importedAt: Date.now() };
    if (existing >= 0) sources[existing] = entry;
    else sources.push(entry);
    await this.setConfig('style_cssFontUrls', JSON.stringify(sources));
  }

  async deleteCssFontSource(url) {
    const sources = await this.getCssFontSources();
    const filtered = sources.filter(s => s.url !== url);
    await this.setConfig('style_cssFontUrls', JSON.stringify(filtered));
  }

  // -- 配置管理 --

  async getConfig(key, defaultValue = null) {
    await this._ensureDB();
    const record = await this._getByKey(STORE_CONFIG, key);
    return record ? record.value : defaultValue;
  }

  async setConfig(key, value) {
    await this._ensureDB();
    if (key === 'mood_config') value = JSON.stringify(normalizeMoodConfig(JSON.parse(value)));
    const result = await this._put(STORE_CONFIG, { key, value });
    if (STYLE_CONFIG_KEYS.includes(key)) {
      writeStyleSnapshot({ [key]: value });
    }
    return result;
  }

  async getAllConfig() {
    await this._ensureDB();
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_CONFIG, 'readonly').objectStore(STORE_CONFIG).getAll();
      req.onsuccess = () => {
        const config = {};
        req.result.forEach(r => { config[r.key] = r.value; });
        resolve(config);
      };
      req.onerror = () => reject(new Error(`配置查询失败`));
    });
  }

  // -- 导入导出（v6.0 三文件拆分） --

  _downloadJsonFile(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  _downloadZipFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // 完整备份必须携带图片；解析顺序与显示一致，不依赖图片是否已缓存到 IndexedDB。
  // downloads 只在本次导出内去重，不写库，也不触发同步或重新压缩图片。
  async _resolveExportImage(record, label, downloads) {
    try {
      let blob = record.imageBlob;
      if (!blob) {
        const url = record.syncedUrl;
        if (!url || url === 'null') throw new Error('没有图片数据或同步图片，请重新上传');
        if (!downloads.has(url)) {
          downloads.set(url, (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
              const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
              if (!response.ok) throw new Error('读取图片失败（HTTP ' + response.status + '）');
              return await response.blob();
            } catch (error) {
              if (controller.signal.aborted) throw new Error('读取图片超时（30 秒）');
              throw error;
            } finally { clearTimeout(timer); }
          })());
        }
        blob = await downloads.get(url);
      }
      if (!(blob instanceof Blob) || !blob.size) throw new Error('图片内容为空或无效');
      let mimeType = String(blob.type || '').split(';')[0].trim().toLowerCase();
      if (!mimeType || mimeType === 'application/octet-stream') mimeType = String(record.mimeType || '').trim().toLowerCase();
      if (!mimeType.startsWith('image/')) throw new Error('返回内容不是图片（' + (mimeType || '未知类型') + '）');
      return mimeType === blob.type ? blob : blob.slice(0, blob.size, mimeType);
    } catch (error) {
      throw new Error(label + '：' + String(error.message || error));
    }
  }

  //  角色卡配置
  async exportCharacterData(charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const prefix = safeCharId + CHAR_ID_SEPARATOR;
    const downloads = new Map();

    const allAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('导出失败'));
    });
    const avatars = [];
    for (const r of allAvatars.filter(r => r.alias.startsWith(prefix))) {
      const name = extractDisplayName(r.alias, safeCharId);
      const imageBlob = await this._resolveExportImage(r, '头像“' + name + '”', downloads);
      const entry = {
        name, mimeType: imageBlob.type, fileName: r.fileName,
        fileSize: imageBlob.size, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        imageBase64: await this._blobToBase64(imageBlob)
      };
      avatars.push(entry);
    }

    const allMoodAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('情绪差分导出失败'));
    });
    const moodAvatars = [];
    for (const r of allMoodAvatars.filter(r => r.charId === safeCharId)) {
      const imageBlob = await this._resolveExportImage(r, '表情头像“' + r.alias + ' / ' + r.moodId + '”', downloads);
      moodAvatars.push({
        name: r.alias, moodId: r.moodId, mimeType: imageBlob.type, fileName: r.fileName,
        fileSize: imageBlob.size, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        imageBase64: await this._blobToBase64(imageBlob)
      });
    }

    const allConfig = await this.getAllConfig();
    const colors = {};
    const colorPrefix = 'color_' + prefix;
    for (const [k, v] of Object.entries(allConfig)) {
      if (k.startsWith(colorPrefix)) {
        colors[k.slice(colorPrefix.length)] = v;
      }
    }

    return {
      type: 'bubble-character',
      version: '8.0',
      exportedAt: new Date().toISOString(),
      charId: safeCharId,
      charName: getCurrentCharName(),
      avatars,
      moodAvatars,
      colors,
    };
  }

  async exportCharacterDataToFile(charId) {
    await this._exportCharacterDataToZip(charId);
  }

  /**
   * 将角色数据导出为 ZIP 格式（图片以二进制文件存储，不再用 base64）
   * ZIP 结构：
   *   manifest.json          — 元数据（不含图片数据）
   *   avatars/0_name.webp    — 头像图片
   *   mood/0_name_moodId.webp — 情绪差分头像
   */
  async _exportCharacterDataToZip(charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const prefix = safeCharId + CHAR_ID_SEPARATOR;
    const zipFiles = [];
    const downloads = new Map();

    // - 头像 -
    const allAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('导出失败'));
    });
    const avatarsMeta = [];
    let avatarIdx = 0;
    for (const r of allAvatars.filter(r => r.alias.startsWith(prefix))) {
      const displayName = extractDisplayName(r.alias, safeCharId);
      const imageBlob = await this._resolveExportImage(r, '头像“' + displayName + '”', downloads);
      const meta = {
        name: displayName, mimeType: imageBlob.type, fileName: r.fileName,
        fileSize: imageBlob.size, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        zipPath: null
      };
      const ext = mimeToExt(imageBlob.type);
      const zipPath = `avatars/${avatarIdx}_${safeFileName(displayName)}${ext}`;
      const buf = await imageBlob.arrayBuffer();
      zipFiles.push({ name: zipPath, data: new Uint8Array(buf) });
      meta.zipPath = zipPath;
      avatarsMeta.push(meta);
      avatarIdx++;
    }

    // - 情绪差分头像 -
    const allMoodAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('情绪差分导出失败'));
    });
    const moodAvatarsMeta = [];
    let moodIdx = 0;
    for (const r of allMoodAvatars.filter(r => r.charId === safeCharId)) {
      const imageBlob = await this._resolveExportImage(r, '表情头像“' + r.alias + ' / ' + r.moodId + '”', downloads);
      const meta = {
        name: r.alias, moodId: r.moodId, mimeType: imageBlob.type, fileName: r.fileName,
        fileSize: imageBlob.size, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        zipPath: null
      };
      const ext = mimeToExt(imageBlob.type);
      const zipPath = `mood/${moodIdx}_${safeFileName(r.alias)}_${r.moodId}${ext}`;
      const buf = await imageBlob.arrayBuffer();
      zipFiles.push({ name: zipPath, data: new Uint8Array(buf) });
      meta.zipPath = zipPath;
      moodAvatarsMeta.push(meta);
      moodIdx++;
    }

    // - 颜色配置 -
    const allConfig = await this.getAllConfig();
    const colors = {};
    const colorPrefix = 'color_' + prefix;
    for (const [k, v] of Object.entries(allConfig)) {
      if (k.startsWith(colorPrefix)) colors[k.slice(colorPrefix.length)] = v;
    }

    // - manifest.json -
    const manifest = {
      type: 'bubble-character',
      version: '8.0-zip',
      exportedAt: new Date().toISOString(),
      charId: safeCharId,
      charName: getCurrentCharName(),
      avatars: avatarsMeta,
      moodAvatars: moodAvatarsMeta,
      colors,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const encoder = new TextEncoder();
    zipFiles.unshift({ name: 'manifest.json', data: encoder.encode(manifestJson) });

    // - 打包并下载 -
    const zipBlob = zipCreate(zipFiles);
    const charName = manifest.charName || 'unknown';
    const date = new Date().toISOString().slice(0, 10);
    this._downloadZipFile(zipBlob, `bubble-character-${charName}-${date}.zip`);
  }

  async _importCharacterData(data, charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const result = { imported: 0, errors: [] };
    const compOpts = await getCompressOptions(this);
    // 所有条目必须自带图片；先完整解码，避免缺图时覆盖部分已有头像。
    const images = new Map();
    for (const list of [data.avatars, data.moodAvatars]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const name = item?.name || item?.alias || '未知角色';
        if (typeof item?.imageBase64 !== 'string' || !item.imageBase64) {
          throw new Error('备份图片缺失或为空：' + name);
        }
        let blob;
        try { blob = this._base64ToBlob(item.imageBase64, item.mimeType); }
        catch (error) { throw new Error('备份图片无效：' + name + '：' + error.message); }
        if (!blob.size) throw new Error('备份图片缺失或为空：' + name);
        images.set(item, blob);
      }
    }

    if (Array.isArray(data.avatars)) {
      for (const item of data.avatars) {
        try {
          const itemName = item.name || item.alias;
          const blob = await compressImage(images.get(item), compOpts);
          const metadata = { fileName: item.fileName, width: item.width, height: item.height };
          if (await this.get(safeCharId, itemName)) {
            await this.update(safeCharId, itemName, blob, metadata);
          } else {
            await this.add(safeCharId, itemName, blob, metadata);
          }
          result.imported++;
        } catch (err) { result.errors.push(`${item.name || item.alias}: ${err.message}`); }
      }
    }

    if (Array.isArray(data.moodAvatars)) {
      for (const item of data.moodAvatars) {
        try {
          const blob = await compressImage(images.get(item), compOpts);
          await this.addMoodAvatar(safeCharId, item.name || item.alias, item.moodId, blob, {
            fileName: item.fileName, width: item.width, height: item.height
          });
          result.imported++;
        } catch (err) { result.errors.push(`${item.name || item.alias}/${item.moodId}: ${err.message}`); }
      }
    }

    if (data.colors) {
      for (const [name, color] of Object.entries(data.colors)) {
        await this.setConfig(buildColorConfigKey(safeCharId, name), color);
      }
    }

    return result;
  }

  //  样式配置
  async exportStyleSettings() {
    const allConfig = await this.getAllConfig();
    const settings = {};
    for (const key of STYLE_CONFIG_KEYS) {
      settings[key] = allConfig[key] !== undefined ? allConfig[key] : STYLE_DEFAULTS[key];
    }
    return {
      type: 'bubble-style',
      version: '8.0',
      exportedAt: new Date().toISOString(),
      settings
    };
  }

  async exportStyleSettingsToFile() {
    const data = await this.exportStyleSettings();
    const date = new Date().toISOString().slice(0, 10);
    this._downloadJsonFile(data, `bubble-style-${date}.json`);
  }

  async _importStyleSettings(data) {
    if (!data.settings || typeof data.settings !== 'object') throw new Error('样式配置数据无效');
    for (const [key, value] of Object.entries(data.settings)) {
      if (STYLE_CONFIG_KEYS.includes(key)) {
        await this.setConfig(key, value);
      }
    }
    return { imported: Object.keys(data.settings).length };
  }

  //  情绪与格式模板
  async exportTemplate() {
    const { prompt, groups } = await loadPromptSettings(this);
    return {
      type: 'bubble-template',
      version: TEMPLATE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      exportedAt: new Date().toISOString(),
      promptTemplate: prompt,
      moodConfig: { groups },
    };
  }

  async savePromptSettings({ prompt, groups }) {
    const template = validatePromptTemplate(prompt);
    const moodConfig = JSON.stringify(normalizeMoodConfig({ groups }));
    await this._ensureDB();
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_CONFIG, 'readwrite');
      const store = tx.objectStore(STORE_CONFIG);
      store.put({ key: PROMPT_TEMPLATE_KEY, value: template });
      store.put({ key: 'mood_config', value: moodConfig });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('提示词配置保存失败：' + (tx.error?.message || '事务已取消')));
    });
  }

  async exportTemplateToFile() {
    const data = await this.exportTemplate();
    const date = new Date().toISOString().slice(0, 10);
    this._downloadJsonFile(data, `bubble-template-${date}.json`);
  }

  async _importTemplate(data) {
    if (data.version !== TEMPLATE_VERSION || data.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error('情绪与提示词模板必须使用 ' + TEMPLATE_VERSION + ' 格式');
    }
    await this.savePromptSettings({ prompt: data.promptTemplate, groups: data.moodConfig?.groups });
    return { imported: 1 };
  }

  //  统一导入路由
  async importFromFile(file, charId) {
    // 读取文件头 4 字节判断是 ZIP 还是 JSON
    const headerBuf = await file.slice(0, 4).arrayBuffer();
    const headerView = new DataView(headerBuf);
    const isZip = headerBuf.byteLength >= 4 && headerView.getUint32(0, true) === 0x04034B50; // PK\x03\x04

    if (isZip) {
      return this._importCharacterDataFromZip(file, charId);
    }

    // JSON 格式（v8 独立格式）
    const data = JSON.parse(await file.text());
    if (data.type === 'bubble-template') return this._importTemplate(data);
    if (!/^8\./.test(String(data.version || ''))) {
      throw new Error('仅支持 v8 导出文件；v7 及更早版本不会自动迁移');
    }
    switch (data.type) {
      case 'bubble-character':
        return this._importCharacterData(data, charId);
      case 'bubble-style':
        return this._importStyleSettings(data);
      default:
        throw new Error('无法识别的文件格式');
    }
  }

  /**
   * 从 ZIP 文件导入角色数据（逐文件处理，内存友好）
   * 每处理完一张图片就释放其 Uint8Array 引用，避免峰值内存过高
   */
  async _importCharacterDataFromZip(file, charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const result = { imported: 0, errors: [] };
    const compOpts = await getCompressOptions(this);

    // 解包 ZIP
    const buffer = await file.arrayBuffer();
    const zipEntries = zipExtract(buffer);

    // 读取 manifest.json
    const manifestData = zipEntries.get('manifest.json');
    if (!manifestData) throw new Error('ZIP 文件中缺少 manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestData));
    zipEntries.delete('manifest.json'); // 释放 manifest 的 Uint8Array

    if (manifest.type !== 'bubble-character') {
      throw new Error(`ZIP 中的 manifest 类型不匹配：期望 bubble-character，实际 ${manifest.type}`);
    }
    if (manifest.version !== '8.0-zip') {
      throw new Error('仅支持 v8 ZIP 导出文件；v7 及更早版本不会自动迁移');
    }

    // 所有条目必须包含图片文件；缺图时在写库前拒绝。
    const imageReferences = new Map();
    for (const list of [manifest.avatars, manifest.moodAvatars]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item?.zipPath) throw new Error('备份图片缺失或为空：' + (item?.name || item?.alias || '未知角色'));
        const bytes = zipEntries.get(item.zipPath);
        if (!bytes?.length) throw new Error('备份图片缺失或为空：' + (item.name || item.alias || '未知角色') + ' / ' + item.zipPath);
        imageReferences.set(item.zipPath, (imageReferences.get(item.zipPath) || 0) + 1);
      }
    }
    const takeImage = (path) => {
      const bytes = zipEntries.get(path);
      const remaining = imageReferences.get(path) - 1;
      imageReferences.set(path, remaining);
      if (!remaining) zipEntries.delete(path); // 共享同一文件的最后一个条目处理后释放引用。
      return bytes;
    };

    // - 导入头像 -
    if (Array.isArray(manifest.avatars)) {
      for (const item of manifest.avatars) {
        try {
          const itemName = item.name || item.alias;
          const imgData = takeImage(item.zipPath);
          const ext = item.zipPath.substring(item.zipPath.lastIndexOf('.'));
          const mime = item.mimeType || extToMime(ext);
          const blob = await compressImage(new Blob([imgData], { type: mime }), compOpts);
          const metadata = { fileName: item.fileName, width: item.width, height: item.height };
          if (await this.get(safeCharId, itemName)) {
            await this.update(safeCharId, itemName, blob, metadata);
          } else {
            await this.add(safeCharId, itemName, blob, metadata);
          }
          result.imported++;
        } catch (err) { result.errors.push(`${item.name || item.alias}: ${err.message}`); }
      }
    }

    // - 导入情绪差分头像 -
    if (Array.isArray(manifest.moodAvatars)) {
      for (const item of manifest.moodAvatars) {
        try {
          const imgData = takeImage(item.zipPath);
          const ext = item.zipPath.substring(item.zipPath.lastIndexOf('.'));
          const mime = item.mimeType || extToMime(ext);
          const blob = await compressImage(new Blob([imgData], { type: mime }), compOpts);
          await this.addMoodAvatar(safeCharId, item.name || item.alias, item.moodId, blob, {
            fileName: item.fileName, width: item.width, height: item.height
          });
          result.imported++;
        } catch (err) { result.errors.push(`${item.name || item.alias}/${item.moodId}: ${err.message}`); }
      }
    }

    // - 导入颜色配置 -
    if (manifest.colors) {
      for (const [name, color] of Object.entries(manifest.colors)) {
        await this.setConfig(buildColorConfigKey(safeCharId, name), color);
      }
    }

    return result;
  }

  // -- 缓存管理 --

  _revokeCachedUrl(key) {
    if (this._blobUrlCache.has(key)) {
      URL.revokeObjectURL(this._blobUrlCache.get(key));
      this._blobUrlCache.delete(key);
    }
  }

  revokeAllUrls() {
    for (const url of this._blobUrlCache.values()) URL.revokeObjectURL(url);
    this._blobUrlCache.clear();
  }

  async clearAll() {
    await this._ensureDB();
    this.revokeAllUrls();
    const stores = [STORE_AVATARS, STORE_CONFIG, STORE_MOOD_AVATARS];
    if (this.db.objectStoreNames.contains(STORE_LOCAL_FONTS)) stores.push(STORE_LOCAL_FONTS);
    const tx = this.db.transaction(stores, 'readwrite');
    for (const s of stores) tx.objectStore(s).clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        clearStyleSnapshot();
        resolve();
      };
      tx.onerror = () => reject(new Error(`清空失败`));
    });
  }

  // -- 内部工具 --

  _put(storeName, record) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(storeName, 'readwrite').objectStore(storeName).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`写入失败`));
    });
  }

  _getByKey(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new Error(`读取失败`));
    });
  }

  _blobToBase64(blob) {
    if (!blob) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Blob 转 Base64 失败'));
      reader.readAsDataURL(blob);
    });
  }

  _base64ToBlob(base64, mimeType = 'image/jpeg') {
    const byteChars = atob(base64);
    const chunks = [];
    for (let i = 0; i < byteChars.length; i += 512) {
      const slice = byteChars.slice(i, i + 512);
      const bytes = new Uint8Array(slice.length);
      for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
      chunks.push(bytes);
    }
    return new Blob(chunks, { type: mimeType });
  }
}



export { AvatarDB, STORE_AVATARS, STORE_CONFIG, STORE_MOOD_AVATARS, STORE_LOCAL_FONTS };
