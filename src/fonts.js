const LOCAL_FONT_MAX_SIZE = 8 * 1024 * 1024;
const FONT_EXT_FORMAT_MAP = {
  woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype'
};
const FONT_EXT_MIME_MAP = {
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/opentype'
};

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
  constructor() {
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

  destroy() {
    this.destroyed = true;
    for (const request of this.requests) request.abort();
    this.requests.clear(); this.remote.clear();
  }
}

export { LOCAL_FONT_MAX_SIZE, FONT_EXT_FORMAT_MAP, FONT_EXT_MIME_MAP, normalizeFontPayload };
