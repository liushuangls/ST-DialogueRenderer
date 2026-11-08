import { AvatarDB } from "./storage.js?v=2.1.2";
import { AvatarSync, GlobalStyleSync } from "./sync.js?v=2.1.2";
import { configureContext } from "./context.js?v=2.1.2";
import { buildInjectionPrompt } from "./protocol.js?v=2.1.2";
import { RenderAssets } from "./assets.js?v=2.1.2";
import { DialogueController } from "./controller.js?v=2.1.2";
import { readSettings, SETTINGS_KEY } from "./settings.js?v=2.1.2";

const PROMPT_ID = 'dialogue-renderer/protocol';

export function createExtension({ getContext, document = globalThis.document,
  chatSurface = globalThis.__TAURITAVERN__?.api?.chatSurface,
  db = new AvatarDB(), syncEnabled = true } = {}) {
  configureContext(getContext);
  const context = getContext();
  const settings = readSettings(context.extensionSettings[SETTINGS_KEY]);
  context.extensionSettings[SETTINGS_KEY] = settings;
  let started = false;
  let disposed = false;
  let panel;
  let panelPromise;
  let controls;
  let promptRevision = 0;
  let diagnostics = [];
  const listeners = [];
  const report = error => {
    if (disposed) return;
    console.error('[DialogueRenderer]', error);
    if (controls) controls.error.textContent = error.message || String(error);
  };
  const avatarSync = syncEnabled ? new AvatarSync(db) : null;
  const styleSync = syncEnabled ? new GlobalStyleSync(db, avatarSync, async () => {
    await refresh();
    if (panel?.isOpen) await panel.onGlobalStyleApplied();
  }) : null;
  const assets = new RenderAssets(db, { onError: report });
  const ready = db.init().then(() => assets.refresh());
  const controller = new DialogueController({ getContext, assets, document, ready, onError: report, chatSurface,
    onDiagnostics: value => { diagnostics = value; renderStatus(); } });

  function renderStatus() {
    if (!controls) return;
    controls.status.textContent = settings.enabled ? `已启用 · 最近 ${settings.recentAiCount} 条 AI 回复` : '已关闭 · 显示原始消息';
    controls.diagnostics.textContent = diagnostics.slice(0, 5)
      .map(issue => `消息 #${issue.mesid}，第 ${issue.marker} 个标记：${issue.reason}`).join('\n');
    if (diagnostics.length > 5) controls.diagnostics.textContent += `\n另有 ${diagnostics.length - 5} 处格式问题。`;
  }

  async function syncPrompt() {
    const revision = ++promptRevision;
    await ready;
    if (disposed) return;
    const text = settings.enabled ? await buildInjectionPrompt(db) : '';
    if (disposed || revision !== promptRevision) return;
    // IN_CHAT, depth 0, no world-info scan, SYSTEM role.
    getContext().setExtensionPrompt(PROMPT_ID, text, 1, 0, false, 0);
    renderStatus();
  }

  async function refresh() {
    await ready;
    if (disposed) return;
    await assets.refresh();
    if (disposed) return;
    await syncPrompt();
    controller.refresh();
    if (settings.enabled || panel?.isOpen) await assets.syncFonts(document);
  }

  async function previewStyles(changes) {
    if (disposed) return;
    const previousUrl = assets.settings.style_fontConfigUrl;
    controller.previewStyles(changes);
    if (previousUrl !== assets.settings.style_fontConfigUrl) await assets.syncFonts(document);
  }

  async function saveStyles() {
    if (disposed) return;
    const fallback = assets.savedSettings.style_globalAvatarFallback;
    await assets.refresh();
    if (disposed) return;
    controller.previewStyles(null);
    if (fallback !== assets.savedSettings.style_globalAvatarFallback) controller.refresh();
    await assets.syncFonts(document);
  }

  async function openManager() {
    await ready;
    if (disposed) throw new Error('对话渲染扩展已关闭');
    if (!panelPromise) {
      panelPromise = import("./manager-panel.js?v=2.1.2").then(({ AvatarManagerPanel }) => {
        if (disposed) throw new Error('对话渲染扩展已关闭');
        panel = new AvatarManagerPanel(db, avatarSync, styleSync, { document, fonts: assets.fonts,
          onPreview: previewStyles, onClose: () => previewStyles(null), onRefresh: refresh,
          onStylesSaved: saveStyles, onFontsChanged: () => assets.syncFonts(document),
          onPromptChanged: refresh, onError: report });
        return panel;
      }).catch(error => { panelPromise = null; throw error; });
    }
    const manager = await panelPromise;
    await manager.open();
    return manager;
  }

  async function setSettings(next) {
    const normalized = readSettings({ ...settings, ...next });
    const wasEnabled = settings.enabled;
    Object.assign(settings, normalized);
    getContext().extensionSettings[SETTINGS_KEY] = { ...settings };
    getContext().saveSettingsDebounced();
    await ready;
    if (disposed) return;
    controller.setSettings(settings);
    if (!settings.enabled) { assets.cache.clear(); db.revokeAllUrls(); }
    await syncPrompt();
    if (settings.enabled && !wasEnabled) await assets.syncFonts(document);
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
        <div class="bd-diagnostics" role="status"></div><div class="bd-error" role="alert"></div>
        <small>协议 2.0：台词使用 @say，心理活动使用 @think。更新扩展后请刷新页面。</small>
      </div>`;
    container.append(section);
    controls = { section, enabled: section.querySelector('.bd-enabled'), count: section.querySelector('.bd-count'),
      status: section.querySelector('.bd-status'), diagnostics: section.querySelector('.bd-diagnostics'), error: section.querySelector('.bd-error') };
    controls.enabled.checked = settings.enabled;
    controls.count.value = String(settings.recentAiCount);
    controls.enabled.addEventListener('change', () => setSettings({ enabled: controls.enabled.checked }).catch(report));
    controls.count.addEventListener('change', () => setSettings({ recentAiCount: Number(controls.count.value) }).catch(error => {
      controls.count.value = String(settings.recentAiCount); report(error);
    }));
    section.querySelector('.bd-manager').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await openManager(); } catch (error) { report(error); } finally { button.disabled = false; }
    });
    renderStatus();
  }

  function start() {
    if (started || disposed) return;
    started = true;
    controller.start();
    const initialized = async () => {
      if (disposed) return;
      try {
        mountControls();
        await ready;
        if (disposed) return;
        await syncPrompt();
        controller.schedule();
        if (settings.enabled) assets.syncFonts(document).catch(report);
        if (syncEnabled) {
          avatarSync.init().then(refresh).catch(report);
          styleSync.refresh().catch(report);
        }
      } catch (error) { report(error); }
    };
    const event = context.eventTypes.APP_READY;
    context.eventSource.on(event, initialized);
    listeners.push(() => context.eventSource.removeListener(event, initialized));
    const chatChanged = () => {
      assets.cache.clear();
      syncPrompt().catch(report);
      if (syncEnabled) avatarSync.refreshCurrentScope({ publishLocal: true }).then(refresh).catch(report);
    };
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, chatChanged);
    listeners.push(() => context.eventSource.removeListener(context.eventTypes.CHAT_CHANGED, chatChanged));
    const resume = () => {
      if (document.visibilityState === 'hidden' || disposed || !syncEnabled) return;
      Promise.all([avatarSync.refreshCurrentScope({ publishLocal: true }), styleSync.refresh()]).then(refresh).catch(report);
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
    panel?.destroy();
    avatarSync?.destroy(); styleSync?.destroy(); assets.destroy();
    controls?.section.remove();
    await ready.catch(() => {});
    db.revokeAllUrls(); db.db?.close();
    configureContext(null);
  }

  return { start, dispose, setSettings, refresh, openManager, controller, assets, ready, get panel() { return panel; } };
}
