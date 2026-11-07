import { DEFAULT_MOOD_GROUPS, STYLE_DEFAULTS, GLOBAL_CHAR_ID, getCurrentCharId, buildColorConfigKey, normalizeMoodConfig } from './avatar-manager.js?v=1.0.3';

export class RenderAssets {
  constructor(db, { onError = console.error, loadFonts = async () => [] } = {}) {
    this.db = db;
    this.onError = onError;
    this.loadFonts = loadFonts;
    this.settings = { ...STYLE_DEFAULTS };
    this.moods = new Map();
    this.cache = new Map();
    this.fontUrls = new Map();
    this.fontNodes = [];
    this.revision = 0;
    this.destroyed = false;
    this.updateMoodGroups(DEFAULT_MOOD_GROUPS);
  }

  updateMoodGroups(groups) {
    this.moods = new Map(groups.flatMap(group => group.words.map(word => [word, group])));
  }

  async refresh() {
    const revision = ++this.revision;
    const config = await this.db.getAllConfig();
    if (this.destroyed || revision !== this.revision) return;
    this.settings = { ...STYLE_DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([key]) => key in STYLE_DEFAULTS)) };
    this.updateMoodGroups(config.mood_config
      ? normalizeMoodConfig(JSON.parse(config.mood_config)).groups : DEFAULT_MOOD_GROUPS);
    this.cache.clear();
  }

  getMood(text) { return this.moods.get(text.trim()) || null; }

  resolve(name, mood) {
    const charId = getCurrentCharId();
    const group = this.getMood(mood);
    const globalFallback = this.settings.style_globalAvatarFallback === true || this.settings.style_globalAvatarFallback === 'true';
    const key = JSON.stringify([charId, name.toLowerCase(), group?.id, globalFallback]);
    if (!this.cache.has(key)) this.cache.set(key, this.resolveUncached(charId, name, group?.id, globalFallback));
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
    const revision = this.revision;
    const [fonts, local, cssSources] = await Promise.all([
      this.loadFonts(this.settings.style_fontConfigUrl, { silent: true }),
      this.db.listLocalFonts(), this.db.getCssFontSources(),
    ]);
    if (this.destroyed || revision !== this.revision) return;
    for (const node of this.fontNodes) node.remove();
    this.fontNodes = [];
    for (const url of this.fontUrls.values()) URL.revokeObjectURL(url);
    this.fontUrls.clear();
    const cssUrls = new Set(cssSources.map(source => source.url));
    const rules = [];
    // JSON quoting keeps user-selected font names inside their CSS string.
    for (const font of fonts) {
      if (font.cssUrl) cssUrls.add(font.cssUrl);
      if (font.type === 'css') cssUrls.add(font.url);
      else if (font.url) rules.push(`@font-face{font-family:${JSON.stringify(font.family || font.name)};src:url(${JSON.stringify(font.url)});font-display:swap}`);
    }
    for (const font of local) {
      if (!font.family || !font.fontBlob) continue;
      const url = URL.createObjectURL(font.fontBlob);
      this.fontUrls.set(font.id, url);
      rules.push(`@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(url)});font-display:swap}`);
    }
    if (rules.length) {
      const node = doc.createElement('style');
      node.textContent = rules.join('\n');
      doc.head.append(node);
      this.fontNodes.push(node);
    }
    for (const url of cssUrls) {
      if (!url) continue;
      const node = doc.createElement('link');
      node.rel = 'stylesheet'; node.href = url;
      doc.head.append(node); this.fontNodes.push(node);
    }
  }

  destroy() {
    this.destroyed = true;
    this.revision++;
    this.cache.clear();
    for (const node of this.fontNodes) node.remove();
    for (const url of this.fontUrls.values()) URL.revokeObjectURL(url);
    this.fontNodes = []; this.fontUrls.clear();
  }
}
