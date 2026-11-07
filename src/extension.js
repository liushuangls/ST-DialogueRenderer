import {
  AvatarDB, AvatarSyncV8, GlobalStyleSyncV8, AvatarManagerPanel, configureManagerRuntime,
  upgradeMoodConfig, upgradePromptConfig, buildInjectionPrompt, invalidateInjectionCache,
  resolveRequestedAvatarCharId, MOOD_GROUPS, buildColorConfigKey,
} from './avatar-manager.js?v=1.0.3';
import { RenderAssets } from './assets.js?v=1.0.3';
import { DialogueController } from './controller.js?v=1.0.3';
import { readSettings, SETTINGS_KEY } from './settings.js?v=1.0.3';

const PROMPT_ID = 'bubble-dialogue-format-v8';

export function createExtension({ getContext, getRegexScripts = () => [], document = globalThis.document,
  chatSurface = globalThis.__TAURITAVERN__?.api?.chatSurface,
  db = new AvatarDB(), syncEnabled = true } = {}) {
  const context = getContext();
  const settings = readSettings(context.extensionSettings[SETTINGS_KEY]);
  context.extensionSettings[SETTINGS_KEY] = settings;
  let disposed = false;
  let panel;
  let controls;
  let promptRevision = 0;
  const listeners = [];
  const report = error => {
    console.error('[DialogueRenderer]', error);
    if (controls) controls.status.textContent = error.message || String(error);
  };
  const avatarSync = syncEnabled ? new AvatarSyncV8(db) : null;
  const styleSync = syncEnabled ? new GlobalStyleSyncV8(db, avatarSync, () => refresh()) : null;
  const assets = new RenderAssets(db, { onError: report,
    loadFonts: (...args) => panel._getAvailableFontOptions(...args) });
  panel = new AvatarManagerPanel(db, avatarSync, styleSync);
  const ready = db.init().then(async () => {
    await upgradeMoodConfig(db);
    await upgradePromptConfig(db);
    await assets.refresh();
  });
  const controller = new DialogueController({ getContext, assets, document, ready, onError: report, chatSurface });
  const avatarApi = {
    async getAvatar(name, charId) {
      await ready;
      const scope = resolveRequestedAvatarCharId(charId);
      return scope ? db.getBlobUrl(scope, name) : null;
    },
    async getMoodAvatar(name, mood, charId) {
      await ready;
      const scope = resolveRequestedAvatarCharId(charId);
      const group = MOOD_GROUPS.find(item => item.id === mood || item.label === mood);
      return scope ? db.getMoodAvatarBlobUrl(scope, name, group?.id || mood) : null;
    },
    async getColor(name, charId) {
      await ready;
      const scope = resolveRequestedAvatarCharId(charId);
      return scope ? db.getConfig(buildColorConfigKey(scope, name)) : null;
    },
    async syncNow() {
      await ready;
      return Promise.all([avatarSync?.refreshCurrentScope({ publishLocal: true, force: true }), styleSync?.refresh()]);
    },
    getSyncStatus: () => avatarSync?.getStatus() || { state: 'local', text: '本地模式' },
  };

  function legacyConflicts() {
    if (globalThis.avatarManagerPanelV8) return ['旧版管理脚本'];
    const regexDisabled = getContext().extensionSettings.disabledExtensions?.includes('regex');
    return regexDisabled ? [] : getRegexScripts({ allowedOnly: true })
      .filter(rule => !rule.disabled && rule.markdownOnly
        && /id=["']dc(?:Lite)?Root["']/.test(rule.replaceString || ''))
      .map(rule => rule.scriptName);
  }

  async function applyPrompt(content) {
    const conflicts = legacyConflicts();
    const enabled = settings.enabled && !disposed && !conflicts.length;
    getContext().setExtensionPrompt(PROMPT_ID, enabled ? content : '', 1, 0, false, 0);
    controller.suspend(conflicts.length > 0);
    if (controls) controls.status.textContent = conflicts.length
      ? '请先停用旧版脚本/渲染正则：' + conflicts.join('、')
      : enabled ? `已启用 · 最近 ${settings.recentAiCount} 条 AI 回复` : '已关闭 · 显示原始消息';
  }

  async function syncPrompt() {
    const revision = ++promptRevision;
    await ready;
    const content = settings.enabled ? await buildInjectionPrompt(db) : '';
    if (!disposed && revision === promptRevision) await applyPrompt(content);
  }

  async function refresh() {
    await ready;
    if (disposed) return;
    await assets.refresh();
    await assets.syncFonts(document);
    if (!disposed) controller.refresh();
  }

  configureManagerRuntime({
    getContext, applyPrompt,
    previewStyles: async values => {
      await ready;
      controller.previewStyles(values);
      await assets.syncFonts(document);
    },
    refresh: () => refresh().catch(report),
  });

  async function setSettings(next) {
    const normalized = readSettings({ ...settings, ...next });
    Object.assign(settings, normalized);
    getContext().extensionSettings[SETTINGS_KEY] = { ...settings };
    getContext().saveSettingsDebounced();
    await ready;
    controller.setSettings(settings);
    if (!settings.enabled) { assets.cache.clear(); db.revokeAllUrls(); }
    await syncPrompt();
    if (controls) {
      controls.enabled.checked = settings.enabled;
      controls.count.value = String(settings.recentAiCount);
    }
  }

  function mountControls() {
    if (controls) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('未找到酒馆扩展设置容器');
    const section = document.createElement('div');
    section.className = 'bd-settings inline-drawer';
    section.innerHTML = `
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>对话渲染系统</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="bd-switch-card">
          <div class="bd-switch-copy">
            <span class="bd-switch-title" id="bd-enabled-title">启用对话渲染</span>
            <p class="bd-switch-description" id="bd-enabled-description">为角色台词和心理活动显示头像与情绪标签。</p>
          </div>
          <span class="bd-toggle">
            <input id="bd-enabled" class="bd-enabled bd-toggle-input" type="checkbox" role="switch"
              aria-labelledby="bd-enabled-title" aria-describedby="bd-enabled-description">
            <label class="bd-toggle-label" for="bd-enabled" aria-label="启用对话渲染"></label>
          </span>
        </div>
        <label class="bd-count-label">最近 AI 回复数量 <input class="bd-count text_pole" type="number" min="1" max="100" step="1"></label>
        <small>按实际 AI 回复计数，较早消息保留酒馆原始显示。</small>
        <button class="bd-manager menu_button" type="button">头像、情绪与正文美化</button>
        <div class="bd-status" role="status"></div>
        <small>更新：扩展管理 → 对话渲染系统 → 更新，然后刷新页面。</small>
      </div>`;
    container.append(section);
    controls = { section, enabled: section.querySelector('.bd-enabled'), count: section.querySelector('.bd-count'),
      status: section.querySelector('.bd-status') };
    controls.enabled.checked = settings.enabled;
    controls.count.value = String(settings.recentAiCount);
    controls.enabled.addEventListener('change', () => setSettings({ enabled: controls.enabled.checked }).catch(report));
    controls.count.addEventListener('change', () => setSettings({ recentAiCount: Number(controls.count.value) }).catch(error => {
      controls.count.value = String(settings.recentAiCount); report(error);
    }));
    section.querySelector('.bd-manager').addEventListener('click', () => ready.then(() => panel.open()).catch(report));
  }

  function start() {
    for (const name of ['BubbleAvatarV8', 'BubbleAvatar']) {
      if (!document.defaultView[name]) {
        document.defaultView[name] = avatarApi;
        listeners.push(() => { if (document.defaultView[name] === avatarApi) delete document.defaultView[name]; });
      }
    }
    controller.start();
    const initialized = async () => {
      try {
        mountControls();
        await ready;
        if (disposed) return;
        await syncPrompt();
        await assets.syncFonts(document);
        controller.schedule();
        if (syncEnabled) {
          avatarSync.init().then(() => refresh()).catch(report);
          styleSync.refresh().catch(report);
        }
      } catch (error) { report(error); }
    };
    const event = context.eventTypes.APP_READY;
    context.eventSource.on(event, initialized);
    listeners.push(() => context.eventSource.removeListener(event, initialized));
    const chatChanged = () => {
      invalidateInjectionCache();
      assets.cache.clear();
      syncPrompt().catch(report);
      if (syncEnabled) avatarSync.refreshCurrentScope({ publishLocal: true }).then(() => refresh()).catch(report);
    };
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, chatChanged);
    listeners.push(() => context.eventSource.removeListener(context.eventTypes.CHAT_CHANGED, chatChanged));
    const resume = () => {
      if (document.visibilityState === 'hidden' || disposed || !syncEnabled) return;
      Promise.all([avatarSync.refreshCurrentScope({ publishLocal: true }), styleSync.refresh()]).then(() => refresh()).catch(report);
    };
    document.addEventListener('visibilitychange', resume);
    document.defaultView.addEventListener('online', resume);
    document.defaultView.addEventListener('pagehide', dispose, { once: true });
    listeners.push(() => document.removeEventListener('visibilitychange', resume),
      () => document.defaultView.removeEventListener('online', resume),
      () => document.defaultView.removeEventListener('pagehide', dispose));
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    promptRevision++;
    controller.dispose();
    getContext().setExtensionPrompt(PROMPT_ID, '', 1, 0, false, 0);
    for (const off of listeners) off();
    if (panel.isOpen) panel.close();
    panel._avatarSyncUnsubscribe?.(); panel._styleSyncUnsubscribe?.();
    if (panel._livePreviewTimer) clearTimeout(panel._livePreviewTimer);
    avatarSync?.destroy(); styleSync?.destroy(); assets.destroy();
    controls?.section.remove();
    configureManagerRuntime(null);
    await ready.catch(() => {});
    db.revokeAllUrls();
    db.db?.close();
  }

  return { start, dispose, setSettings, refresh, controller, assets, panel, ready };
}
