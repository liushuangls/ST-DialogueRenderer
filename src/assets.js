import { DEFAULT_MOOD_GROUPS, STYLE_DEFAULTS, normalizeMoodConfig } from './config.js?v=2.0.0';
import { GLOBAL_CHAR_ID, getCurrentCharId, buildColorConfigKey } from './context.js?v=2.0.0';
import { FontCatalog } from './fonts.js?v=2.0.0';

export class RenderAssets {
  constructor(db, { onError = console.error, fonts = new FontCatalog(db) } = {}) {
    this.db = db;
    this.onError = onError;
    this.fonts = fonts;
    this.savedSettings = { ...STYLE_DEFAULTS };
    this.preview = null;
    this.moods = new Map();
    this.cache = new Map();
    this.fontUrls = new Map();
    this.fontNodes = [];
    this.fontSignature = null;
    this.fontRevision = 0;
    this.revision = 0;
    this.destroyed = false;
    this.updateMoodGroups(DEFAULT_MOOD_GROUPS);
  }

  get settings() { return { ...this.savedSettings, ...this.preview }; }

  setPreview(changes) { this.preview = changes ? { ...changes } : null; }

  updateMoodGroups(groups) {
    this.moods = new Map(groups.flatMap(group => group.words.map(word => [word, group])));
  }

  async refresh() {
    if (this.destroyed) return;
    const revision = ++this.revision;
    const config = await this.db.getAllConfig();
    if (this.destroyed || revision !== this.revision) return;
    this.savedSettings = { ...STYLE_DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([key]) => key in STYLE_DEFAULTS)) };
    this.updateMoodGroups(config.mood_config === undefined ? DEFAULT_MOOD_GROUPS
      : normalizeMoodConfig(JSON.parse(config.mood_config)).groups);
    this.cache.clear();
  }

  getMood(text) { return this.moods.get(text.trim()) || null; }

  resolve(name, mood) {
    const charId = getCurrentCharId();
    const group = this.getMood(mood);
    const globalFallback = this.settings.style_globalAvatarFallback === true;
    const key = JSON.stringify([charId, name.toLowerCase(), group?.id, globalFallback]);
    if (!this.cache.has(key)) {
      const pending = this.resolveUncached(charId, name, group?.id, globalFallback);
      this.cache.set(key, pending);
      pending.catch(() => { if (this.cache.get(key) === pending) this.cache.delete(key); });
    }
    return this.cache.get(key);
  }

  async resolveUncached(charId, name, moodId, globalFallback) {
    let avatar = charId && moodId ? await this.db.getMoodAvatarBlobUrl(charId, name, moodId) : null;
    if (!avatar && charId) avatar = await this.db.getBlobUrl(charId, name);
    if (!avatar && globalFallback && moodId) avatar = await this.db.getMoodAvatarBlobUrl(GLOBAL_CHAR_ID, name, moodId);
    if (!avatar && globalFallback) avatar = await this.db.getBlobUrl(GLOBAL_CHAR_ID, name);
    let color = charId ? await this.db.getConfig(buildColorConfigKey(charId, name)) : null;
    if (!color && globalFallback) color = await this.db.getConfig(buildColorConfigKey(GLOBAL_CHAR_ID, name));
    return { avatar, color };
  }

  async syncFonts(doc) {
    if (this.destroyed) return;
    const revision = ++this.fontRevision;
    const [fonts, local, cssSources] = await Promise.all([
      this.fonts.getRemote(this.settings.style_fontConfigUrl),
      this.db.listLocalFonts(), this.db.getCssFontSources(),
    ]);
    if (this.destroyed || revision !== this.fontRevision) return;
    const signature = JSON.stringify([fonts, cssSources, local.map(font =>
      [font.id, font.family, font.createdAt, font.fontBlob?.size, font.mimeType])]);
    if (signature === this.fontSignature) return;
    const cssUrls = new Set(cssSources.map(source => source.url));
    const rules = [];
    const nextUrls = new Map();
    const nextNodes = [];
    try {
      for (const font of fonts) {
        if (font.type === 'css') cssUrls.add(font.url);
        else rules.push(`@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(font.url)});font-display:swap}`);
      }
      for (const font of local) {
        if (!font.family || !font.fontBlob) throw new Error('本地字体记录缺少字体族或内容');
        const url = URL.createObjectURL(font.fontBlob);
        nextUrls.set(font.id, url);
        rules.push(`@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(url)});font-display:swap}`);
      }
      if (rules.length) {
        const node = doc.createElement('style');
        node.textContent = rules.join('\n'); nextNodes.push(node);
      }
      for (const url of cssUrls) {
        if (typeof url !== 'string' || !url.trim()) throw new Error('CSS 字体源 URL 无效');
        const node = doc.createElement('link');
        node.rel = 'stylesheet'; node.href = url; nextNodes.push(node);
      }
      // Keep the current font set intact until its replacement is fully prepared.
      doc.head.append(...nextNodes);
    } catch (error) {
      for (const node of nextNodes) node.remove();
      for (const url of nextUrls.values()) URL.revokeObjectURL(url);
      throw error;
    }
    for (const node of this.fontNodes) node.remove();
    for (const url of this.fontUrls.values()) URL.revokeObjectURL(url);
    this.fontNodes = nextNodes; this.fontUrls = nextUrls; this.fontSignature = signature;
  }

  destroy() {
    this.destroyed = true;
    this.revision++; this.fontRevision++;
    this.fonts.destroy(); this.cache.clear();
    for (const node of this.fontNodes) node.remove();
    for (const url of this.fontUrls.values()) URL.revokeObjectURL(url);
    this.fontNodes = []; this.fontUrls.clear();
  }
}
