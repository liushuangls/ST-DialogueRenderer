const LOCAL_FONT_MAX_SIZE = 8 * 1024 * 1024;
const LOCAL_FONT_ACCEPT = '.woff2,.woff,.ttf,.otf';
const FONT_EXT_FORMAT_MAP = {
  woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype'
};
const FONT_EXT_MIME_MAP = {
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/opentype'
};

const BUILTIN_FONT_OPTIONS = [
  { id: 'noto-sans-sc', name: 'Noto Sans SC', family: 'Noto Sans SC', type: 'builtin' },
  { id: 'source-han-sans-sc', name: 'Source Han Sans SC', family: 'Source Han Sans SC', type: 'builtin' },
  { id: 'noto-serif-sc', name: 'Noto Serif SC', family: 'Noto Serif SC', type: 'builtin' },
  { id: 'source-han-serif-sc', name: 'Source Han Serif SC', family: 'Source Han Serif SC', type: 'builtin' },
  { id: 'lxgw-wenkai', name: 'LXGW WenKai', family: 'LXGW WenKai', type: 'builtin' },
  { id: 'fira-code', name: 'Fira Code', family: 'Fira Code', type: 'builtin' }
];

function normalizeFontPayload(payload) {
  if (!Array.isArray(payload?.fonts)) throw new Error('远程字体配置必须包含 fonts 数组');
  return payload.fonts.map((item, index) => {
      const family = typeof item?.family === 'string' ? item.family.trim() : '';
      const name = typeof item?.name === 'string' ? item.name.trim() : family;
      const url = typeof item?.url === 'string' ? item.url.trim() : '';
      const type = item?.type === 'file' ? 'file' : item?.type === 'css' ? 'css' : '';
      const format = typeof item?.format === 'string' ? item.format.trim() : '';
      const id = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : `remote-font-${index}`;
      if (!family || !name || !url || !type) throw new Error(`远程字体配置第 ${index + 1} 项缺少名称、字体族、URL 或有效类型`);
      return { id, name, family, url, type, format };
    });
}

export class FontCatalog {
  constructor(db) {
    this.db = db;
    this.remote = new Map();
    this.requests = new Set();
    this.destroyed = false;
  }

  getRemote(url, { forceRefresh = false } = {}) {
    const address = String(url || '').trim();
    if (!address) return Promise.resolve([]);
    if (this.destroyed) return Promise.reject(new Error('字体目录已关闭'));
    if (forceRefresh) this.remote.delete(address);
    if (this.remote.has(address)) return this.remote.get(address);
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    const request = Promise.resolve().then(async () => {
      try {
        const response = await fetch(address, { signal: controller.signal, cache: forceRefresh ? 'reload' : 'default' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return normalizeFontPayload(await response.json());
      } catch (error) {
        if (this.remote.get(address) === request) this.remote.delete(address);
        throw new Error(`远程字体目录加载失败（${address}）：${error.message}`);
      } finally {
        clearTimeout(timer);
        this.requests.delete(controller);
      }
    });
    this.remote.set(address, request);
    return request;
  }

  async getOptions(url, options) {
    if (this.destroyed) throw new Error('字体目录已关闭');
    const [local, sources, remote] = await Promise.all([
      this.db.listLocalFonts(), this.db.getCssFontSources(), this.getRemote(url, options),
    ]);
    const fonts = [...BUILTIN_FONT_OPTIONS,
      ...local.map(font => ({ id: font.id, name: `${font.family}（本地）`, family: font.family, type: 'local' })),
      ...sources.flatMap(source => (source.families || []).map(family => ({
        id: 'css-' + family, name: `${family}（CSS）`, family, type: 'css', url: source.url,
      }))), ...remote];
    const families = new Set();
    return fonts.filter(font => {
      if (families.has(font.family)) return false;
      families.add(font.family); return true;
    });
  }

  destroy() {
    this.destroyed = true;
    for (const request of this.requests) request.abort();
    this.requests.clear(); this.remote.clear();
  }
}

export { LOCAL_FONT_MAX_SIZE, LOCAL_FONT_ACCEPT, FONT_EXT_FORMAT_MAP, FONT_EXT_MIME_MAP, BUILTIN_FONT_OPTIONS, normalizeFontPayload };
