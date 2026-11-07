import { DEFAULT_MOOD_GROUPS, MOOD_GROUPS, STYLE_DEFAULTS, writeStyleSnapshot } from './config.js?v=2.0.0';
import { GLOBAL_CHAR_ID, CHAR_ID_SEPARATOR, getCurrentCharId, getCurrentCharName, buildAvatarKey, buildMoodAvatarKey, buildColorConfigKey, extractDisplayName } from './context.js?v=2.0.0';
import { LOCAL_FONT_MAX_SIZE, LOCAL_FONT_ACCEPT, FONT_EXT_FORMAT_MAP, FONT_EXT_MIME_MAP } from './fonts.js?v=2.0.0';
import { STORE_AVATARS, STORE_MOOD_AVATARS } from './storage.js?v=2.0.0';
import { compressImage, getCompressOptions } from './image-utils.js?v=2.0.0';
import { buildPrompt, loadPromptSettings } from './protocol.js?v=2.0.0';

const SCRIPT_DISPLAY_NAME = '对话渲染系统';
const FONT_FETCH_TIMEOUT_MS = 8000;
function escapeHtmlAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class AvatarManagerPanel {
  constructor(db, avatarSync, styleSync, { document = globalThis.document, fonts,
    onPreview = async () => {}, onClose = async () => {}, onRefresh = async () => {},
    onStylesSaved = async () => {}, onFontsChanged = async () => {}, onPromptChanged = async () => {}, onError = console.error } = {}) {
    this.db = db;
    this.document = document;
    this.fonts = fonts;
    this.onPreview = onPreview;
    this.onClose = onClose;
    this.onRefresh = onRefresh;
    this.onStylesSaved = onStylesSaved;
    this.onFontsChanged = onFontsChanged;
    this.onPromptChanged = onPromptChanged;
    this.onError = onError;
    this.avatarSync = avatarSync;
    this.styleSync = styleSync;
    this.pendingFile = null;
    this.isOpen = false;
    this._mainWindow = null;
    this._syncOverlayLayoutBound = null;
    this._livePreviewTimer = null;
    this._styleDraftLoaded = false;
    this._styleDraftDirty = false;
    this._pendingBubbleRefresh = false;
    this._pendingBubbleRefreshDelay = 0;
    this._panelOffset = { x: 0, y: 0 };
    this._panelDragState = null;
    this._panelDragBindings = null;
    this.currentTab = 'avatar';
    this._charId = '';
    this._charName = '';
    this._expandedMoodName = null;
    this._moodConfigLoaded = false;
    this._moodConfigDirty = false;
    this._moodConfigDraft = null;
    this._boundMoodTab = null;
    this._promptSupplementDraft = '';
    this._avatarSyncUnsubscribe = avatarSync?.subscribe(status => {
      this._avatarSyncStatus = status;
      this._renderAvatarSyncStatus();
    });
    this._styleSyncUnsubscribe = styleSync?.subscribe(status => {
      this._styleSyncStatus = status;
      this._renderStyleSyncStatus();
    });
  }

  /**
   * 判断当前是否为移动端（触屏 + 窄屏）
   */
  _isMobile() {
    try {
      const w = this._mainWindow || this._getMainWindow();
      return ('ontouchstart' in w) && (w.innerWidth <= 768);
    } catch { return false; }
  }

  _normalizeHexColor(value, fallback = '#58a6ff') {
    if (typeof value !== 'string') return fallback;
    let hex = value.trim();
    if (!hex) return fallback;
    if (!hex.startsWith('#')) hex = `#${hex}`;
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
      hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
    return fallback;
  }

  _hexToRgb(hex) {
    const normalized = this._normalizeHexColor(hex, '#58a6ff');
    return {
      r: parseInt(normalized.slice(1, 3), 16),
      g: parseInt(normalized.slice(3, 5), 16),
      b: parseInt(normalized.slice(5, 7), 16)
    };
  }

  _rgbToHex(r, g, b) {
    const clamp = (value) => Math.min(255, Math.max(0, Number.parseInt(value, 10) || 0));
    return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }

  _openImagePreview(src, title = '') {
    const doc = this._getMainDocument();
    doc.getElementById('bam-image-preview')?.remove();
    const overlay = doc.createElement('div');
    overlay.id = 'bam-image-preview';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100010;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;flex-direction:column;cursor:pointer;';
    overlay.innerHTML = `
      <div style="color:#999;font-size:12px;margin-bottom:8px;">${escapeHtmlAttr(title)}<span style="margin-left:12px;color:#666;">点击任意处关闭</span></div>
      <img src="${src}" style="max-width:90vw;max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);" />
    `;
    overlay.addEventListener('click', () => overlay.remove());
    doc.body.appendChild(overlay);
  }

  _openMobileColorDialog({ title = '选择颜色', initialValue = '#58a6ff', onConfirm } = {}) {
    const doc = this._getMainDocument();
    const mainWindow = this._mainWindow || this._getMainWindow();
    doc.getElementById('bam-mobile-color-dialog')?.remove();

    const presetColors = ['#f47b67', '#45ddc0', '#e78bff', '#f0b232', '#58a6ff', '#ff9a76', '#7ee787', '#d2a8ff'];
    const current = this._hexToRgb(initialValue);
    const overlay = doc.createElement('div');
    overlay.id = 'bam-mobile-color-dialog';
    overlay.innerHTML = `
      <div class="bam-mobile-color-backdrop" style="position:fixed; inset:0; z-index:100001; background:rgba(0,0,0,0.72);"></div>
      <div class="bam-mobile-color-shell" style="position:fixed; inset:0; z-index:100002; box-sizing:border-box; pointer-events:none;">
        <div class="bam-mobile-color-card" style="position:absolute; width:min(360px, calc(100vw - 28px)); max-height:calc(100vh - 96px); background:#1a1a2e; border:1px solid rgba(255,255,255,0.08); border-radius:18px; box-shadow:0 20px 60px rgba(0,0,0,0.45); overflow:hidden; display:flex; flex-direction:column; pointer-events:auto; transition:left 0.12s ease-out, top 0.12s ease-out;">
          <div class="bam-mobile-color-drag-handle" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px 12px; border-bottom:1px solid rgba(255,255,255,0.06); cursor:grab; touch-action:none;">
            <div style="display:flex; align-items:center; gap:10px; min-width:0;">
              <span style="display:inline-flex; flex-direction:column; gap:3px; opacity:0.45; flex:0 0 auto;">
                <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
                <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
              </span>
              <div style="min-width:0;">
                <div style="color:#e8e8ee; font-size:15px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtmlAttr(title)}</div>
                <div style="color:#7d7d93; font-size:11px; margin-top:3px;">顶部和底部都可以拖动</div>
              </div>
            </div>
            <button type="button" class="bam-mobile-color-cancel" style="background:none; border:none; color:#888; font-size:22px; line-height:1; padding:0 4px; flex:0 0 auto;">&times;</button>
          </div>
          <div class="bam-mobile-color-body" style="padding:16px 18px 18px; overflow:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch;">
            <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
              <div class="bam-mobile-color-preview" style="width:56px; height:56px; border-radius:16px; background:${this._rgbToHex(current.r, current.g, current.b)}; border:1px solid rgba(255,255,255,0.12); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.06);"></div>
              <div style="flex:1; min-width:0;">
                <div style="color:#8b8ba3; font-size:11px; margin-bottom:6px; letter-spacing:0.4px; text-transform:uppercase;">HEX</div>
                <input class="bam-mobile-color-hex" type="text" value="${this._rgbToHex(current.r, current.g, current.b)}" maxlength="7" style="width:100%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:10px; padding:10px 12px; color:#f3f3f7; font-size:15px; box-sizing:border-box; outline:none;" />
              </div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
              ${presetColors.map(color => `<button type="button" class="bam-mobile-color-preset" data-color="${color}" style="width:28px; height:28px; border-radius:50%; border:2px solid rgba(255,255,255,0.14); background:${color}; padding:0;"></button>`).join('')}
            </div>
            ${[
              { key: 'r', label: 'R', color: '#ef4444', value: current.r },
              { key: 'g', label: 'G', color: '#22c55e', value: current.g },
              { key: 'b', label: 'B', color: '#3b82f6', value: current.b }
            ].map(channel => `
              <div style="margin-bottom:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                  <span style="color:#d0d0d8; font-size:13px; font-weight:600;">${channel.label}</span>
                  <span class="bam-mobile-color-value" data-channel="${channel.key}" style="color:#888; font-size:12px;">${channel.value}</span>
                </div>
                <input class="bam-mobile-color-range" data-channel="${channel.key}" type="range" min="0" max="255" step="1" value="${channel.value}" style="width:100%; accent-color:${channel.color};" />
              </div>
            `).join('')}
            <div style="display:flex; gap:10px; margin-top:18px;">
              <button type="button" class="bam-mobile-color-cancel" style="flex:1; background:rgba(255,255,255,0.06); border:none; color:#c5c5cf; padding:12px 14px; border-radius:10px; font-size:14px;">取消</button>
              <button type="button" class="bam-mobile-color-confirm" style="flex:1; background:#4a6cf7; border:none; color:#fff; padding:12px 14px; border-radius:10px; font-size:14px; font-weight:600;">确定</button>
            </div>
            <div class="bam-mobile-color-bottom-drag" style="display:flex; flex-direction:column; align-items:center; gap:6px; padding-top:14px; margin-top:10px; border-top:1px solid rgba(255,255,255,0.06); cursor:grab; touch-action:none; user-select:none;">
              <span style="display:inline-flex; flex-direction:column; gap:3px; opacity:0.34;">
                <span style="display:block; width:26px; height:2px; border-radius:999px; background:rgba(255,255,255,0.5);"></span>
                <span style="display:block; width:26px; height:2px; border-radius:999px; background:rgba(255,255,255,0.5);"></span>
              </span>
              <span style="color:#7d7d93; font-size:11px; line-height:1;">这里也能拖动面板</span>
            </div>
          </div>
        </div>
      </div>`;
    doc.body.appendChild(overlay);

    const backdrop = overlay.querySelector('.bam-mobile-color-backdrop');
    const shell = overlay.querySelector('.bam-mobile-color-shell');
    const card = overlay.querySelector('.bam-mobile-color-card');
    const dragHandle = overlay.querySelector('.bam-mobile-color-drag-handle');
    const bottomDragHandle = overlay.querySelector('.bam-mobile-color-bottom-drag');
    const dragTargets = [dragHandle, bottomDragHandle].filter(Boolean);
    const previewEl = overlay.querySelector('.bam-mobile-color-preview');
    const hexInput = overlay.querySelector('.bam-mobile-color-hex');
    const rangeEls = Array.from(overlay.querySelectorAll('.bam-mobile-color-range'));
    const valueEls = Array.from(overlay.querySelectorAll('.bam-mobile-color-value'));
    const state = { ...current };
    let dialogPosition = { left: 14, top: 72 };
    let dragState = null;
    let viewportBindings = null;
    let shellPaddingX = 14;
    let preferredTop = 72;
    let preferredBottom = 22;

    const clampNumber = (value, min, max) => {
      if (max < min) return min;
      return Math.min(Math.max(value, min), max);
    };
    const computeDialogMetrics = () => {
      const metrics = this._getViewportMetrics();
      shellPaddingX = metrics.width <= 420 ? 14 : 18;
      preferredTop = Math.max(56, Math.min(112, Math.round(metrics.height * 0.16)));
      preferredBottom = Math.max(18, Math.min(30, Math.round(metrics.height * 0.05)));
      const maxHeight = Math.max(220, metrics.height - preferredTop - preferredBottom);
      const dialogWidth = Math.min(360, Math.max(260, metrics.width - shellPaddingX * 2));
      return { ...metrics, maxHeight, dialogWidth };
    };
    const clampDialogPosition = (left, top) => {
      const shellRect = shell.getBoundingClientRect();
      const cardWidth = Math.max(260, Math.round(card.offsetWidth || 0));
      const cardHeight = Math.max(220, Math.round(card.offsetHeight || 0));
      const maxLeft = Math.max(shellPaddingX, shellRect.width - cardWidth - shellPaddingX);
      const maxTop = Math.max(12, shellRect.height - cardHeight - preferredBottom);
      return {
        left: clampNumber(left, shellPaddingX, maxLeft),
        top: clampNumber(top, 12, maxTop)
      };
    };
    const applyDialogPosition = (left, top) => {
      dialogPosition = clampDialogPosition(left, top);
      card.style.left = `${dialogPosition.left}px`;
      card.style.top = `${dialogPosition.top}px`;
    };
    const syncUI = (syncHex = true) => {
      const hex = this._rgbToHex(state.r, state.g, state.b);
      previewEl.style.background = hex;
      if (syncHex) hexInput.value = hex;
      rangeEls.forEach((el) => { el.value = `${state[el.dataset.channel]}`; });
      valueEls.forEach((el) => { el.textContent = `${state[el.dataset.channel]}`; });
    };
    const applyHex = (value) => {
      const normalized = this._normalizeHexColor(value, null);
      if (!normalized) return false;
      const rgb = this._hexToRgb(normalized);
      state.r = rgb.r;
      state.g = rgb.g;
      state.b = rgb.b;
      syncUI();
      return true;
    };
    const setDragCursor = (cursor) => {
      dragTargets.forEach((el) => {
        el.style.cursor = cursor;
      });
    };
    const finishDrag = (event) => {
      if (!dragState?.active) return;
      if (event?.pointerId !== undefined && dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      const activeTarget = dragState.dragTarget;
      if (dragState.pointerId !== null && activeTarget?.hasPointerCapture?.(dragState.pointerId)) {
        try { activeTarget.releasePointerCapture(dragState.pointerId); } catch (_) { /* ignore */ }
      }
      dragState = null;
      setDragCursor('grab');
      card.style.transition = 'left 0.12s ease-out, top 0.12s ease-out';
      doc.body.style.userSelect = '';
    };
    const syncDialogViewport = ({ recenter = false } = {}) => {
      const { width, height, offsetTop, offsetLeft, maxHeight, dialogWidth } = computeDialogMetrics();
      shell.style.left = `${offsetLeft}px`;
      shell.style.top = `${offsetTop}px`;
      shell.style.width = `${width}px`;
      shell.style.height = `${height}px`;
      card.style.width = `${dialogWidth}px`;
      card.style.maxHeight = `${maxHeight}px`;
      const nextLeft = recenter ? (width - dialogWidth) / 2 : dialogPosition.left;
      const nextTop = recenter ? preferredTop : dialogPosition.top;
      applyDialogPosition(nextLeft, nextTop);
    };
    const teardownViewportSync = () => {
      if (!viewportBindings) return;
      mainWindow.removeEventListener('resize', viewportBindings);
      mainWindow.removeEventListener('orientationchange', viewportBindings);
      mainWindow.visualViewport?.removeEventListener('resize', viewportBindings);
      mainWindow.visualViewport?.removeEventListener('scroll', viewportBindings);
      viewportBindings = null;
    };
    const closeDialog = () => {
      teardownViewportSync();
      finishDrag();
      overlay.remove();
    };

    syncDialogViewport({ recenter: true });
    viewportBindings = () => syncDialogViewport();
    mainWindow.addEventListener('resize', viewportBindings, { passive: true });
    mainWindow.addEventListener('orientationchange', viewportBindings, { passive: true });
    mainWindow.visualViewport?.addEventListener('resize', viewportBindings, { passive: true });
    mainWindow.visualViewport?.addEventListener('scroll', viewportBindings, { passive: true });

    const beginDrag = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('button, input, select, textarea, label, a')) return;
      event.preventDefault();
      const dragTarget = event.currentTarget;
      dragState = {
        active: true,
        pointerId: event.pointerId ?? null,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: dialogPosition.left,
        originTop: dialogPosition.top,
        dragTarget
      };
      setDragCursor('grabbing');
      card.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      dragTarget?.setPointerCapture?.(event.pointerId);
    };
    const onDragMove = (event) => {
      if (!dragState?.active) return;
      if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      applyDialogPosition(
        dragState.originLeft + (event.clientX - dragState.startX),
        dragState.originTop + (event.clientY - dragState.startY),
      );
    };
    dragTargets.forEach((target) => {
      target.addEventListener('pointerdown', beginDrag);
      target.addEventListener('pointermove', onDragMove);
      target.addEventListener('pointerup', finishDrag);
      target.addEventListener('pointercancel', finishDrag);
      target.addEventListener('lostpointercapture', finishDrag);
    });

    overlay.querySelectorAll('.bam-mobile-color-cancel').forEach((btn) => {
      btn.addEventListener('click', closeDialog);
    });
    backdrop?.addEventListener('click', closeDialog);
    overlay.querySelector('.bam-mobile-color-confirm')?.addEventListener('click', () => {
      const nextColor = this._rgbToHex(state.r, state.g, state.b);
      closeDialog();
      onConfirm?.(nextColor);
    });
    rangeEls.forEach((el) => {
      el.addEventListener('input', () => {
        state[el.dataset.channel] = Number.parseInt(el.value, 10) || 0;
        syncUI();
      });
    });
    overlay.querySelectorAll('.bam-mobile-color-preset').forEach((btn) => {
      btn.addEventListener('click', () => applyHex(btn.dataset.color));
    });
    hexInput?.addEventListener('change', () => {
      if (!applyHex(hexInput.value)) syncUI();
    });
    hexInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!applyHex(hexInput.value)) syncUI();
      }
    });
    return true;
  }

  /**
   * 为面板内所有 <input type="color"> 设置统一颜色弹窗。
   */
  _setupColorPickerProxy() {
    const doc = this._getMainDocument();
    const container = doc.getElementById('bam-container');
    if (!container) return;

    container.addEventListener('click', (e) => {
      const colorInput = e.target.closest('input[type="color"]');
      if (!colorInput) return;
      e.preventDefault();
      e.stopPropagation();
      this._openMobileColorDialog({
        title: colorInput.title || '选择颜色',
        initialValue: colorInput.value,
        onConfirm: (nextColor) => {
          colorInput.value = nextColor;
          colorInput.dispatchEvent(new Event('input', { bubbles: true }));
          colorInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }, true);
  }

  /**
   * 获取主页面 document
   */
  _getMainDocument() {
    return this.document;
  }

  /**
   * 获取主页面 window
   */
  _getMainWindow() {
    return this.document.defaultView;
  }

  /**
   * 获取当前可见视口尺寸（优先使用 visualViewport，兼容移动端）
   */
  _getViewportMetrics() {
    const mainWindow = this._mainWindow || this._getMainWindow();
    const viewport = mainWindow.visualViewport;
    const width = Math.max(320, Math.round(viewport?.width || mainWindow.innerWidth || this.document.documentElement.clientWidth || 0));
    const height = Math.max(320, Math.round(viewport?.height || mainWindow.innerHeight || this.document.documentElement.clientHeight || 0));
    const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
    const offsetLeft = Math.max(0, Math.round(viewport?.offsetLeft || 0));
    return { width, height, offsetTop, offsetLeft };
  }

  /**
   * 生成遮罩层样式，避免移动端 100vh / safe-area 导致错位
   */
  _buildOverlayStyles() {
    const { width, height, offsetTop, offsetLeft } = this._getViewportMetrics();
    const panelMaxHeight = Math.max(height - 32, 220);
    return `
      #bam-container {
        position:fixed!important;
        top:${offsetTop}px!important;
        left:${offsetLeft}px!important;
        width:${width}px!important;
        height:${height}px!important;
        min-height:${height}px!important;
        background:rgba(0,0,0,0.7)!important;
        z-index:99999!important;
        display:flex!important;
        align-items:flex-start!important;
        justify-content:center!important;
        margin:0!important;
        padding:16px!important;
        padding-top:calc(env(safe-area-inset-top) + 16px)!important;
        padding-right:calc(env(safe-area-inset-right) + 16px)!important;
        padding-bottom:calc(env(safe-area-inset-bottom) + 16px)!important;
        padding-left:calc(env(safe-area-inset-left) + 16px)!important;
        box-sizing:border-box!important;
        overflow:auto!important;
        overscroll-behavior:contain!important;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif!important;
      }
      #bam-panel {
        width:100%!important;
        max-width:460px!important;
        max-height:${panelMaxHeight}px!important;
        margin:0 auto!important;
        flex:0 0 auto!important;
      }
      @media (max-width: 640px) {
        #bam-container {
          padding:12px!important;
          padding-top:calc(env(safe-area-inset-top) + 12px)!important;
          padding-right:calc(env(safe-area-inset-right) + 12px)!important;
          padding-bottom:calc(env(safe-area-inset-bottom) + 12px)!important;
          padding-left:calc(env(safe-area-inset-left) + 12px)!important;
        }
        #bam-panel {
          max-width:100%!important;
          border-radius:14px!important;
        }
      }
    `;
  }

  _syncOverlayLayout() {
    const doc = this._getMainDocument();
    const styleEl = doc.getElementById('bam-style');
    if (!styleEl) return;
    styleEl.textContent = this._buildOverlayStyles();
    this._syncPanelPosition();
  }

  _bindViewportSync() {
    if (!this._mainWindow || this._syncOverlayLayoutBound) return;
    this._syncOverlayLayoutBound = () => this._syncOverlayLayout();
    this._mainWindow.addEventListener('resize', this._syncOverlayLayoutBound, { passive: true });
    this._mainWindow.addEventListener('orientationchange', this._syncOverlayLayoutBound, { passive: true });
    this._mainWindow.visualViewport?.addEventListener('resize', this._syncOverlayLayoutBound, { passive: true });
    this._mainWindow.visualViewport?.addEventListener('scroll', this._syncOverlayLayoutBound, { passive: true });
  }

  _unbindViewportSync() {
    if (!this._mainWindow || !this._syncOverlayLayoutBound) return;
    this._mainWindow.removeEventListener('resize', this._syncOverlayLayoutBound);
    this._mainWindow.removeEventListener('orientationchange', this._syncOverlayLayoutBound);
    this._mainWindow.visualViewport?.removeEventListener('resize', this._syncOverlayLayoutBound);
    this._mainWindow.visualViewport?.removeEventListener('scroll', this._syncOverlayLayoutBound);
    this._syncOverlayLayoutBound = null;
  }

  _getPanelElements() {
    const doc = this._getMainDocument();
    return {
      container: doc.getElementById('bam-container'),
      panel: doc.getElementById('bam-panel'),
      handle: doc.getElementById('bam-drag-handle')
    };
  }

  _applyPanelOffset() {
    const { panel } = this._getPanelElements();
    if (!panel) return;
    panel.style.transform = `translate(${this._panelOffset.x}px, ${this._panelOffset.y}px)`;
  }

  _clampPanelOffset(nextX, nextY) {
    const { container, panel } = this._getPanelElements();
    if (!container || !panel) return { x: nextX, y: nextY };

    const containerRect = container.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const currentOffset = this._panelOffset || { x: 0, y: 0 };
    const baseLeft = panelRect.left - currentOffset.x;
    const baseTop = panelRect.top - currentOffset.y;
    const safePadding = 8;
    const clampAxis = (value, min, max) => {
      if (max < min) return min;
      return Math.min(Math.max(value, min), max);
    };

    return {
      x: clampAxis(nextX, containerRect.left + safePadding - baseLeft, containerRect.right - safePadding - panelRect.width - baseLeft),
      y: clampAxis(nextY, containerRect.top + safePadding - baseTop, containerRect.bottom - safePadding - panelRect.height - baseTop)
    };
  }

  _syncPanelPosition() {
    this._panelOffset = this._clampPanelOffset(this._panelOffset.x, this._panelOffset.y);
    this._applyPanelOffset();
  }

  _setupPanelDrag() {
    if (this._panelDragBindings) return;
    const doc = this._getMainDocument();
    const { panel, handle } = this._getPanelElements();
    if (!panel || !handle) return;

    const finishDrag = (event) => {
      const dragState = this._panelDragState;
      if (!dragState?.active) return;
      if (event?.pointerId !== undefined && dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      if (dragState.pointerId !== null && handle.hasPointerCapture?.(dragState.pointerId)) {
        try { handle.releasePointerCapture(dragState.pointerId); } catch (_) { /* ignore */ }
      }
      this._panelDragState = null;
      handle.style.cursor = 'grab';
      panel.style.transition = 'transform 0.12s ease-out';
      doc.body.style.userSelect = '';
    };

    const onPointerMove = (event) => {
      const dragState = this._panelDragState;
      if (!dragState?.active) return;
      if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      this._panelOffset = this._clampPanelOffset(
        dragState.originX + deltaX,
        dragState.originY + deltaY,
      );
      this._applyPanelOffset();
    };

    const onPointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('button, input, select, textarea, label, a')) return;
      event.preventDefault();
      this._panelDragState = {
        active: true,
        pointerId: event.pointerId ?? null,
        startX: event.clientX,
        startY: event.clientY,
        originX: this._panelOffset.x,
        originY: this._panelOffset.y
      };
      handle.style.cursor = 'grabbing';
      panel.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      handle.setPointerCapture?.(event.pointerId);
    };

    const onWindowBlur = () => finishDrag();

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);
    this._mainWindow?.addEventListener('blur', onWindowBlur);

    this._panelDragBindings = { onPointerDown, onPointerMove, finishDrag, onWindowBlur };
  }

  _teardownPanelDrag() {
    const doc = this._getMainDocument();
    const { handle } = this._getPanelElements();
    if (this._panelDragBindings && handle) {
      handle.removeEventListener('pointerdown', this._panelDragBindings.onPointerDown);
      handle.removeEventListener('pointermove', this._panelDragBindings.onPointerMove);
      handle.removeEventListener('pointerup', this._panelDragBindings.finishDrag);
      handle.removeEventListener('pointercancel', this._panelDragBindings.finishDrag);
      handle.removeEventListener('lostpointercapture', this._panelDragBindings.finishDrag);
    }
    this._mainWindow?.removeEventListener('blur', this._panelDragBindings?.onWindowBlur);
    const pointerId = this._panelDragState?.pointerId;
    if (pointerId !== undefined && pointerId !== null && handle?.hasPointerCapture?.(pointerId)) {
      try { handle.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
    }
    doc.body.style.userSelect = '';
    this._panelDragBindings = null;
    this._panelDragState = null;
  }


  _getDialogueLineHeight(fontSize, spacing) {
    const safeFontSize = Number.isFinite(fontSize) ? fontSize : STYLE_DEFAULTS.style_dialogueFontSize;
    const safeSpacing = Number.isFinite(spacing) ? spacing : STYLE_DEFAULTS.style_dialogueSpacing;
    const computed = Math.max(safeFontSize * 1.35, safeFontSize + safeSpacing);
    return Math.round(computed * 100) / 100;
  }

  _getDefaultStyleSettings() { return { ...STYLE_DEFAULTS }; }

  _getAvailableFontOptions(url, options = {}) {
    return this.fonts.getOptions(url, options);
  }

  _applyFontOptionsToSelect(select, options, selectedFamily, fallbackFamily) {
    if (!select) return;
    const selected = selectedFamily || fallbackFamily;
    const choices = [...options];
    if (selected && !choices.some(font => font.family === selected)) choices.push({ name: selected, family: selected });
    select.replaceChildren(...choices.map(font => {
      const option = select.ownerDocument.createElement('option');
      option.value = font.family; option.textContent = font.name;
      return option;
    }));
    select.value = selected;
  }

  async _refreshFontSelectors({ forceRemote = false } = {}) {
    const doc = this._getMainDocument();
    const url = doc.getElementById('bam-font-url-input')?.value.trim() || '';
    const options = await this.fonts.getOptions(url, { forceRefresh: forceRemote });
    for (const [id, key] of [['bam-select-narration-font','style_narrationFontFamily'],
      ['bam-select-dialogue-font','style_dialogueFontFamily'], ['bam-select-name-font','style_nameFontFamily']]) {
      const select = doc.getElementById(id);
      this._applyFontOptionsToSelect(select, options, select?.value, STYLE_DEFAULTS[key]);
    }
    await this.onFontsChanged();
    return options;
  }

  _getLiveStyleSettings() {
    const doc = this._getMainDocument();
    const defaults = this._getDefaultStyleSettings();
    const getNumberValue = (id, fallback) => {
      const raw = doc.getElementById(id)?.value;
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const getCheckedValue = (name, fallback) => doc.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
    const getSelectValue = (id, fallback) => doc.getElementById(id)?.value || fallback;

    return {
      style_dialogueFontSize: getNumberValue('bam-range-dialogue-font', defaults.style_dialogueFontSize),
      style_narrationFontSize: getNumberValue('bam-range-narration-font', defaults.style_narrationFontSize),
      style_dialogueSpacing: getNumberValue('bam-range-dialogue-spacing', defaults.style_dialogueSpacing),
      style_textColorMode: getCheckedValue('bam-color-mode', defaults.style_textColorMode),
      style_globalTextColor: doc.getElementById('bam-global-color-picker')?.value || defaults.style_globalTextColor,
      style_dialogueFontWeight: getNumberValue('bam-range-dialogue-weight', defaults.style_dialogueFontWeight),
      style_narrationFontWeight: getNumberValue('bam-range-narration-weight', defaults.style_narrationFontWeight),
      style_nameFontWeight: getNumberValue('bam-range-name-weight', defaults.style_nameFontWeight),
      style_narrationBgColor: doc.getElementById('bam-narration-bg-color')?.value || defaults.style_narrationBgColor,
      style_narrationBgOpacity: getNumberValue('bam-range-narration-bg-opacity', defaults.style_narrationBgOpacity),
      style_avatarSize: getNumberValue('bam-range-avatar-size', defaults.style_avatarSize),
      style_narrationIndent: getNumberValue('bam-range-narration-indent', defaults.style_narrationIndent),
      style_narrationFontFamily: getSelectValue('bam-select-narration-font', defaults.style_narrationFontFamily),
      style_dialogueFontFamily: getSelectValue('bam-select-dialogue-font', defaults.style_dialogueFontFamily),
      style_nameFontFamily: getSelectValue('bam-select-name-font', defaults.style_nameFontFamily),
      style_fontConfigUrl: doc.getElementById('bam-font-url-input')?.value?.trim() || defaults.style_fontConfigUrl,
      style_narrationBorderRadius: getNumberValue('bam-range-narration-border-radius', defaults.style_narrationBorderRadius),
      style_avatarShape: getCheckedValue('bam-avatar-shape', defaults.style_avatarShape),
      style_globalAvatarFallback: doc.getElementById('bam-chk-global-avatar-fallback')?.checked === true,
      // v7.0
      style_narrationTextIndent: getNumberValue('bam-range-narration-text-indent', defaults.style_narrationTextIndent),
      style_narrationLineHeight: getNumberValue('bam-range-narration-line-height', defaults.style_narrationLineHeight),
      style_narrationPaddingRight: getNumberValue('bam-range-narration-padding-right', defaults.style_narrationPaddingRight),
      style_imageCompressEnabled: doc.getElementById('bam-chk-compress-enabled')?.checked !== false,
      style_imageCompressQuality: getNumberValue('bam-range-compress-quality', defaults.style_imageCompressQuality),
    };
  }

  async _applyBubblePreviewStyles(styleSettings = null) {
    const settings = { ...this._getDefaultStyleSettings(), ...(styleSettings || this._getLiveStyleSettings()) };
    const baseline = this._styleSavedBaseline || STYLE_DEFAULTS;
    const changes = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== baseline[key]));
    await this.onPreview(changes);
    return true;
  }

  _refreshBubblePreview() {
    this.onRefresh().catch(this.onError);
  }

  _scheduleBubblePreviewRefresh(delay = 80) {
    if (this._livePreviewTimer) clearTimeout(this._livePreviewTimer);
    this._livePreviewTimer = setTimeout(() => {
      this._livePreviewTimer = null;
      this._refreshBubblePreview();
    }, delay);
  }

  _requestBubblePreviewRefresh(delay = 80, deferUntilPanelClose = false) {
    if (deferUntilPanelClose && this.isOpen) {
      this._pendingBubbleRefreshDelay = this._pendingBubbleRefresh
        ? Math.min(this._pendingBubbleRefreshDelay, delay)
        : delay;
      this._pendingBubbleRefresh = true;
      return;
    }
    this._scheduleBubblePreviewRefresh(delay);
  }

  _requestAvatarAssetPreviewRefresh(delay = 80) {
    this._requestBubblePreviewRefresh(delay, true);
  }

  _renderAvatarSyncStatus() {
    if (!this.isOpen) return;
    const doc = this._getMainDocument();
    const statusEl = doc.getElementById('bam-avatar-sync-status');
    if (!statusEl) return;
    const status = this._avatarSyncStatus || { state: 'idle', text: '等待同步初始化' };
    const colors = { synced: '#7ee787', syncing: '#8ba4f7', pending: '#eab308', error: '#ff8a8a', local: '#eab308', idle: '#888' };
    statusEl.textContent = status.text;
    statusEl.style.color = colors[status.state] || '#888';
    statusEl.title = status.error || status.text;
  }

  _renderStyleSyncStatus() {
    if (!this.isOpen) return;
    const element = this._getMainDocument().getElementById('bam-style-sync-status');
    if (!element) return;
    const status = this._styleSyncStatus || { text: '等待同步初始化' };
    element.textContent = status.text;
    element.style.color = status.state === 'error' ? '#ff8a8a' : '#888';
  }

  async onGlobalStyleApplied() {
    if (this.isOpen) {
      await this._loadGlobalFallbackSetting();
      if (this._styleDraftLoaded && !this._styleDraftDirty) await this._loadStyleSettings();
    }
  }

  async _loadGlobalFallbackSetting() {
    const doc = this._getMainDocument();
    const checkbox = doc.getElementById('bam-chk-global-avatar-fallback');
    if (!checkbox) return;
    const value = await this.db.getConfig('style_globalAvatarFallback', STYLE_DEFAULTS.style_globalAvatarFallback);
    checkbox.checked = value === true || value === 'true';
  }

  async open() {
    if (this.isOpen) { this.close(); }
    this.isOpen = true;
    try {
      await this.db.init();
      if (!this.isOpen) return;

      this._charId = getCurrentCharId() || GLOBAL_CHAR_ID;
      this._charName = this._charId === GLOBAL_CHAR_ID ? '全局头像' : getCurrentCharName();
      this._expandedMoodName = null;

      const doc = this._getMainDocument();
      this._mainWindow = this._getMainWindow();

      const styleEl = doc.createElement('style');
      styleEl.id = 'bam-style';
      doc.head.appendChild(styleEl);
      this._syncOverlayLayout();
      this._bindViewportSync();


      const container = doc.createElement('div');
      container.id = 'bam-container';
      container.innerHTML = this._panelHTML();
      doc.body.appendChild(container);
      this._panelOffset = { x: 0, y: 0 };
      this._setupPanelDrag();
      this._syncPanelPosition();
      this._setupColorPickerProxy();

      this._bindEvents();
      this._renderAvatarSyncStatus();
      this._renderStyleSyncStatus();
      await this._loadGlobalFallbackSetting();
      await this._refreshList();
      this.avatarSync?.refreshCurrentScope({ publishLocal: true }).then(async () => {
        if (this.isOpen) await this._refreshList();
      }).catch(() => {});
      this.styleSync?.refresh().catch(error => console.warn('[DialogueRenderer] 打开面板时同步样式失败:', error));
    } catch (err) {
      this.isOpen = false;
      console.error('[DialogueRenderer] open() 执行出错:', err);
      throw err;
    }
  }

  close() {
    const doc = this._getMainDocument();
    const shouldRefreshAfterClose = this._pendingBubbleRefresh;
    const refreshDelay = this._pendingBubbleRefreshDelay;
    this._unbindViewportSync();
    this._teardownPanelDrag();
    if (this._livePreviewTimer) {
      clearTimeout(this._livePreviewTimer);
      this._livePreviewTimer = null;
    }
    const el = doc.getElementById('bam-container');
    if (el) el.remove();
    const st = doc.getElementById('bam-style');
    if (st) st.remove();
    this._mainWindow = null;
    this.pendingFile = null;
    this._styleDraftLoaded = false;
    this._styleDraftDirty = false;
    this._moodConfigLoaded = false;
    this._moodConfigDirty = false;
    this._moodConfigDraft = null;
    this._boundMoodTab = null;
    this._promptSupplementDraft = '';
    this._pendingBubbleRefresh = false;
    this._pendingBubbleRefreshDelay = 0;
    this._panelOffset = { x: 0, y: 0 };
    this._charId = '';
    this._charName = '';
    this._expandedMoodName = null;
    this.isOpen = false;
    this.onClose().catch(this.onError);
    if (shouldRefreshAfterClose) this._scheduleBubblePreviewRefresh(refreshDelay);
  }

  destroy() {
    if (this.isOpen) this.close();
    if (this._livePreviewTimer) clearTimeout(this._livePreviewTimer);
    this._avatarSyncUnsubscribe?.();
    this._styleSyncUnsubscribe?.();
  }

  // -- HTML 模板 --

  _panelHTML() {
    return `
  <div id="bam-panel" style="
    background:#1a1a2e; border-radius:16px; width:460px; max-width:calc(100vw - 32px);
    display:flex; flex-direction:column;
    box-shadow:0 20px 60px rgba(0,0,0,0.5);
    border:1px solid rgba(255,255,255,0.08); overflow:hidden;
    will-change:transform; transition:transform 0.12s ease-out;
  ">
    <div id="bam-drag-handle" style="display:flex; align-items:center; justify-content:space-between;
      padding:16px 20px 12px; border-bottom:1px solid rgba(255,255,255,0.06); cursor:grab; touch-action:none;">
      <div style="display:flex; align-items:center; gap:10px; min-width:0;">
        <span style="display:inline-flex; flex-direction:column; gap:3px; opacity:0.45;">
          <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
          <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
        </span>
        <div style="font-size:16px; font-weight:600; color:#e0e0e0;">${SCRIPT_DISPLAY_NAME}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button id="bam-btn-import" style="background:rgba(255,255,255,0.06); border:none; color:#aaa;
          padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;">导入</button>
        <button id="bam-btn-export" style="background:rgba(255,255,255,0.06); border:none; color:#aaa;
          padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;">导出</button>
        <button id="bam-btn-close" style="background:none; border:none; color:#888;
          font-size:20px; cursor:pointer; padding:0 4px; line-height:1;">&times;</button>
      </div>
    </div>

    <div id="bam-tab-bar" style="display:flex; padding:0 20px; border-bottom:1px solid rgba(255,255,255,0.06);">
      <button class="bam-tab-btn bam-tab-active" data-tab="avatar" style="
        flex:1; padding:10px 0; border:none; background:none; color:#e0e0e0; font-size:13px;
        font-weight:600; cursor:pointer; border-bottom:2px solid #4a6cf7; transition:all 0.2s;">头像管理</button>
      <button class="bam-tab-btn" data-tab="style" style="
        flex:1; padding:10px 0; border:none; background:none; color:#666; font-size:13px;
        font-weight:500; cursor:pointer; border-bottom:2px solid transparent; transition:all 0.2s;">正文美化</button>
      <button class="bam-tab-btn" data-tab="mood" style="
        flex:1; padding:10px 0; border:none; background:none; color:#666; font-size:13px;
        font-weight:500; cursor:pointer; border-bottom:2px solid transparent; transition:all 0.2s;">情绪与提示词</button>
    </div>

    <div id="bam-tab-avatar" style="display:flex; flex-direction:column; flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch;">
      <div id="bam-char-info" style="padding:8px 20px; font-size:12px; color:#888; border-bottom:1px solid rgba(255,255,255,0.04); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="opacity:0.6;">📋</span>
          <span>当前角色卡: <span id="bam-char-name" style="color:#ccc;">—</span></span>
        </div>
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <span style="min-width:0;">☁️ 多端头像: <span id="bam-avatar-sync-status" style="color:#888;">等待同步初始化</span></span>
          <button id="bam-btn-sync-now" type="button" style="background:rgba(74,108,247,0.16); border:1px solid rgba(74,108,247,0.35); color:#b9c7ff; padding:4px 8px; border-radius:6px; cursor:pointer; font-size:11px; white-space:nowrap;">立即同步</button>
        </div>
        <div style="color:#666; font-size:10px; line-height:1.45;">图片会自动写入 /user/files；跨设备传输由 TauriTavern 的 user.files 同步范围负责。</div>
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="color:#888; font-size:11px;">操作目标:</span>
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="radio" name="bam-target-scope" value="character" checked style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:11px;">当前角色卡</span>
          </label>
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="radio" name="bam-target-scope" value="global" style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:11px;">全局（跨卡共享）</span>
          </label>
        </div>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#aaa; font-size:11px;">
          <input id="bam-chk-global-avatar-fallback" type="checkbox" style="accent-color:#4a6cf7;" />
          <span>找不到本卡头像时，允许使用全局同名头像</span>
        </label>
        <div style="color:#765; font-size:10px; line-height:1.4;">默认开启，同名角色可跨卡共享头像；如需完全隔离，可手动关闭，关闭后绝不自动读取全局分区。</div>
      </div>
      <div id="bam-upload-area" style="
        margin:16px 20px 8px; border:2px dashed rgba(255,255,255,0.12);
        border-radius:12px; padding:20px; text-align:center; cursor:pointer; transition:all 0.2s;
      ">
        <div style="font-size:28px; margin-bottom:6px;">+</div>
        <div style="color:#888; font-size:13px;">点击或拖拽图片到此处上传</div>
        <div style="color:#555; font-size:11px; margin-top:4px;">支持 JPG / PNG / GIF / WebP，最大 2MB，推荐 200×200 正方形</div>
        <input id="bam-file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none;" />
      </div>
      <div style="text-align:center; margin:0 20px 8px;">
        <button id="bam-btn-add-remote-avatar" style="background:none; border:1px dashed rgba(74,108,247,0.3); color:#8ba4f7; padding:6px 16px; border-radius:8px; cursor:pointer; font-size:12px; width:100%;">🔗 使用远程图片 URL</button>
      </div>

      <div id="bam-alias-input-area" style="display:none; margin:8px 20px; padding:12px 16px; background:rgba(255,255,255,0.04); border-radius:10px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <img id="bam-preview-img" style="width:44px; height:44px; border-radius:50%; object-fit:cover; border:2px solid rgba(255,255,255,0.1);" />
          <div style="flex:1;">
            <div style="color:#ccc; font-size:12px; margin-bottom:4px;">设置角色名（AI 输出时使用的全名）</div>
            <input id="bam-alias-input" type="text" placeholder="例如: 城崎诺亚" style="width:100%; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:6px 10px; color:#e0e0e0; font-size:14px; outline:none; box-sizing:border-box;" />
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <div style="color:#ccc; font-size:12px; flex-shrink:0;">角色主题色</div>
          <div id="bam-color-presets" style="display:flex; gap:4px; flex-wrap:wrap;">
            <span class="bam-color-dot" data-color="#f47b67" style="width:22px;height:22px;border-radius:50%;background:#f47b67;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#45ddc0" style="width:22px;height:22px;border-radius:50%;background:#45ddc0;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#e78bff" style="width:22px;height:22px;border-radius:50%;background:#e78bff;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#f0b232" style="width:22px;height:22px;border-radius:50%;background:#f0b232;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#58a6ff" style="width:22px;height:22px;border-radius:50%;background:#58a6ff;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#ff9a76" style="width:22px;height:22px;border-radius:50%;background:#ff9a76;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#7ee787" style="width:22px;height:22px;border-radius:50%;background:#7ee787;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#d2a8ff" style="width:22px;height:22px;border-radius:50%;background:#d2a8ff;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
          </div>
          <input id="bam-color-input" type="color" value="#58a6ff" style="width:28px;height:28px;border:none;background:none;cursor:pointer;padding:0;" title="自定义颜色" />
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button id="bam-btn-cancel-upload" style="background:rgba(255,255,255,0.06); border:none; color:#aaa; padding:6px 16px; border-radius:6px; cursor:pointer; font-size:13px;">取消</button>
          <button id="bam-btn-confirm-upload" style="background:#4a6cf7; border:none; color:white; padding:6px 16px; border-radius:6px; cursor:pointer; font-size:13px;">确认添加</button>
        </div>
      </div>

      <div id="bam-avatar-list" style="flex:1; overflow-y:auto; padding:8px 20px 16px; min-height:100px;">
        <div id="bam-empty-tip" style="text-align:center; color:#555; padding:30px 0; font-size:13px;">还没有头像，点击上方区域添加</div>
      </div>

      <div id="bam-stats" style="padding:10px 20px; border-top:1px solid rgba(255,255,255,0.06); font-size:12px; color:#555; text-align:center;">已存储: 0 张 | 总计: 0 KB</div>

      <div id="bam-remote-actions" style="padding:6px 20px 10px; display:flex; gap:8px; flex-wrap:wrap; justify-content:center; border-top:1px solid rgba(255,255,255,0.04);">
        <button id="bam-btn-fetch-remote" style="background:rgba(74,108,247,0.12); border:1px solid rgba(74,108,247,0.25); color:#b9c7ff; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:11px;">拉取远程头像</button>
        <button id="bam-btn-clear-remote-cache" style="background:rgba(255,80,80,0.08); border:1px solid rgba(255,80,80,0.2); color:#e88; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:11px;">清除远程缓存</button>
      </div>

    </div>

    <div id="bam-tab-style" style="display:none; flex-direction:column; flex:1; overflow-y:auto; padding:16px 20px;">
      <div style="margin-bottom:14px;padding:10px;border:1px solid rgba(74,108,247,.25);border-radius:8px;font-size:11px;line-height:1.6;">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
          <span>☁️ 全局美化同步</span><button id="bam-btn-style-sync-now" type="button" style="cursor:pointer;">立即同步</button>
        </div>
        <div id="bam-style-sync-status" style="color:#888;">等待同步初始化</div>
        <div style="color:#888;">保存的样式在所有角色卡间共用；字体与配置随 user.files 跨设备同步，另一端拉取后生效。</div>
      </div>
      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">文字</div>

      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">台词字号</span><span id="bam-val-dialogue-font" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_dialogueFontSize}px</span></div>
        <input id="bam-range-dialogue-font" type="range" min="12" max="22" step="0.5" value="${STYLE_DEFAULTS.style_dialogueFontSize}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文字号</span><span id="bam-val-narration-font" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationFontSize}px</span></div>
        <input id="bam-range-narration-font" type="range" min="12" max="22" step="0.5" value="${STYLE_DEFAULTS.style_narrationFontSize}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">台词行距</span><span id="bam-val-dialogue-spacing" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_dialogueSpacing}px</span></div>
        <input id="bam-range-dialogue-spacing" type="range" min="4" max="24" step="1" value="${STYLE_DEFAULTS.style_dialogueSpacing}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">台词字重</span><span id="bam-val-dialogue-weight" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_dialogueFontWeight}</span></div>
        <input id="bam-range-dialogue-weight" type="range" min="100" max="900" step="10" value="${STYLE_DEFAULTS.style_dialogueFontWeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文字重</span><span id="bam-val-narration-weight" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationFontWeight}</span></div>
        <input id="bam-range-narration-weight" type="range" min="100" max="900" step="10" value="${STYLE_DEFAULTS.style_narrationFontWeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">角色名字重</span><span id="bam-val-name-weight" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_nameFontWeight}</span></div>
        <input id="bam-range-name-weight" type="range" min="100" max="900" step="10" value="${STYLE_DEFAULTS.style_nameFontWeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">颜色</div>
      <div style="margin-bottom:20px;">
        <label style="display:flex; align-items:center; gap:8px; margin-bottom:8px; cursor:pointer;">
          <input type="radio" name="bam-color-mode" value="global" checked style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">全局统一色</span>
          <input id="bam-global-color-picker" type="color" value="${STYLE_DEFAULTS.style_globalTextColor}" style="width:28px; height:28px; border:none; background:none; cursor:pointer; padding:0; margin-left:auto;" />
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="bam-color-mode" value="character" style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">跟随角色主题色</span>
        </label>
        <div style="color:#555; font-size:11px; margin-top:6px; padding-left:24px;">正文颜色始终跟随全局统一色</div>
      </div>
      <div style="display:flex; gap:12px; margin-bottom:10px; align-items:center;">
        <label style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
          <span style="color:#ccc; font-size:13px; flex-shrink:0;">正文背景色</span>
          <input id="bam-narration-bg-color" type="color" value="${STYLE_DEFAULTS.style_narrationBgColor}" style="width:36px; height:30px; border:none; background:none; cursor:pointer; padding:0;" />
        </label>
        <div style="flex:1; min-width:0;">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文背景透明度</span><span id="bam-val-narration-bg-opacity" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationBgOpacity.toFixed(2)}</span></div>
          <input id="bam-range-narration-bg-opacity" type="range" min="0" max="0.4" step="0.01" value="${STYLE_DEFAULTS.style_narrationBgOpacity}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
        </div>
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">布局</div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">头像大小</span><span id="bam-val-avatar-size" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_avatarSize}px</span></div>
        <input id="bam-range-avatar-size" type="range" min="36" max="120" step="1" value="${STYLE_DEFAULTS.style_avatarSize}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="color:#ccc; font-size:13px; margin-bottom:6px;">头像形状</div>
        <div style="display:flex; gap:12px;">
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="bam-avatar-shape" value="rounded" checked style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:12px;">圆角矩形</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="bam-avatar-shape" value="circle" style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:12px;">纯圆形</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="bam-avatar-shape" value="square" style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:12px;">纯方形</span>
          </label>
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文左侧留白</span><span id="bam-val-narration-indent" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationIndent}px</span></div>
        <input id="bam-range-narration-indent" type="range" min="0" max="120" step="2" value="${STYLE_DEFAULTS.style_narrationIndent}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文背景圆角</span><span id="bam-val-narration-border-radius" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationBorderRadius}px</span></div>
        <input id="bam-range-narration-border-radius" type="range" min="0" max="24" step="1" value="${STYLE_DEFAULTS.style_narrationBorderRadius}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文首行缩进</span><span id="bam-val-narration-text-indent" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationTextIndent}em</span></div>
        <input id="bam-range-narration-text-indent" type="range" min="0" max="4" step="0.5" value="${STYLE_DEFAULTS.style_narrationTextIndent}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文行距</span><span id="bam-val-narration-line-height" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationLineHeight}</span></div>
        <input id="bam-range-narration-line-height" type="range" min="1.2" max="3.0" step="0.05" value="${STYLE_DEFAULTS.style_narrationLineHeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">正文右边距</span><span id="bam-val-narration-padding-right" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationPaddingRight}px</span></div>
        <input id="bam-range-narration-padding-right" type="range" min="0" max="120" step="2" value="${STYLE_DEFAULTS.style_narrationPaddingRight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">字体</div>
      <div style="display:grid; gap:12px; margin-bottom:14px;">
        <label style="display:flex; flex-direction:column; gap:6px;">
          <span style="color:#ccc; font-size:13px;">正文字体</span>
          <select id="bam-select-narration-font" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;"></select>
        </label>
        <label style="display:flex; flex-direction:column; gap:6px;">
          <span style="color:#ccc; font-size:13px;">台词字体</span>
          <select id="bam-select-dialogue-font" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;"></select>
        </label>
        <label style="display:flex; flex-direction:column; gap:6px;">
          <span style="color:#ccc; font-size:13px;">角色名字体</span>
          <select id="bam-select-name-font" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;"></select>
        </label>
      </div>
      <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
        <span style="color:#ccc; font-size:13px;">远程字体配置 URL</span>
        <input id="bam-font-url-input" type="url" placeholder="https://example.com/fonts.json" value="${STYLE_DEFAULTS.style_fontConfigUrl}" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;" />
      </label>
      <div style="display:flex; justify-content:flex-end; margin-bottom:20px;">
        <button id="bam-btn-refresh-fonts" style="background:rgba(74,108,247,0.16); border:1px solid rgba(74,108,247,0.35); color:#b9c7ff; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:12px;">刷新字体列表</button>
      </div>

      <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
        <span style="color:#ccc; font-size:13px;">在线 CSS 字体导入</span>
        <div style="display:flex; gap:8px;">
          <input id="bam-css-font-url-input" type="url" placeholder="https://fontsapi.xxx.com/.../result.css" style="flex:1; background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px; min-width:0;" />
          <button id="bam-btn-import-css-font" style="background:rgba(74,108,247,0.16); border:1px solid rgba(74,108,247,0.35); color:#b9c7ff; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:12px; white-space:nowrap;">解析并导入</button>
        </div>
      </label>
      <div id="bam-css-font-sources" style="margin-bottom:16px; max-height:150px; overflow-y:auto;"></div>

      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <span style="color:#ccc; font-size:13px;">本地字体</span>
        <button id="bam-btn-upload-local-font" style="background:rgba(74,108,247,0.16); border:1px solid rgba(74,108,247,0.35); color:#b9c7ff; padding:6px 12px; border-radius:8px; cursor:pointer; font-size:12px;">+ 上传字体文件</button>
        <input id="bam-local-font-input" type="file" accept="${LOCAL_FONT_ACCEPT}" style="display:none;" />
      </div>
      <div id="bam-local-font-list" style="margin-bottom:20px; max-height:150px; overflow-y:auto;"></div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">存储优化</div>
      <div style="margin-bottom:10px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input id="bam-chk-compress-enabled" type="checkbox" checked style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">自动压缩图片（存储前转为 WebP）</span>
        </label>
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">压缩质量</span><span id="bam-val-compress-quality" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_imageCompressQuality.toFixed(2)}</span></div>
        <input id="bam-range-compress-quality" type="range" min="0.5" max="1.0" step="0.01" value="${STYLE_DEFAULTS.style_imageCompressQuality}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
        <div style="color:#555; font-size:11px; margin-top:4px;">质量 0.8 视觉几乎无损，体积可减少 30~60%。设为 1.0 则近似无损。</div>
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">Markdown 渲染</div>
      <div style="margin-bottom:20px;color:#aaa;font-size:12px;line-height:1.6;">沿用酒馆完成的 Markdown 格式，支持标题、列表、引用和行内格式。插件在显示正则之后处理对话标记；Markdown 行为在酒馆设置中调整。</div>

      <div style="display:flex; justify-content:center; gap:12px; margin-bottom:12px;">
        <button id="bam-btn-save-style" style="background:#4a6cf7; border:none; color:#fff; padding:8px 24px; border-radius:6px; cursor:pointer; font-size:13px; opacity:0.65;" disabled>保存样式</button>
        <button id="bam-btn-reset-style" style="background:rgba(255,255,255,0.06); border:none; color:#aaa; padding:8px 24px; border-radius:6px; cursor:pointer; font-size:13px;">恢复默认</button>
      </div>
      <div id="bam-style-save-tip" style="text-align:center; color:#555; font-size:11px; padding:8px 0; border-top:1px solid rgba(255,255,255,0.06);">
        当前样式已保存；调整时只影响预览，点击保存后下次静态重渲染读取新值</div>
    </div>

    <div id="bam-tab-mood" style="display:none; flex-direction:column; flex:1; overflow-y:auto; padding:16px 20px;">
    </div>
  </div>
  <input id="bam-import-input" type="file" accept=".json,.zip" style="display:none;" />`;
  }

  _avatarItemHTML(avatar, blobUrl, color, sourceInfo = '📁') {
    const sizeKB = (avatar.fileSize / 1024).toFixed(1);
    const displayName = avatar.displayName || avatar.alias;
    const safeName = escapeHtmlAttr(displayName);
    const safeImgSrc = escapeHtmlAttr(blobUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    const colorDot = color ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px;vertical-align:middle;"></span>` : '';
    return `
<div class="bam-avatar-item" data-name="${safeName}" style="
  display:flex; flex-direction:column; gap:0; margin-bottom:6px;
  background:rgba(255,255,255,0.03); border-radius:10px; overflow:hidden;
">
  <div style="display:flex; align-items:center; gap:12px; padding:10px 12px;">
    <img src="${safeImgSrc}" class="bam-avatar-thumb" data-preview-src="${safeImgSrc}" data-preview-title="${safeName}" style="width:44px; height:44px; border-radius:50%;
      object-fit:cover; flex-shrink:0; border:2px solid ${color || 'rgba(255,255,255,0.1)'}; cursor:pointer;" />
    <div style="flex:1; min-width:0;">
      <div style="color:#e0e0e0; font-size:14px; font-weight:500;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${colorDot}${safeName}</div>
      <div style="color:#666; font-size:11px; margin-top:2px;">${sourceInfo} ${sizeKB} KB · ${avatar.mimeType.split('/')[1].toUpperCase()}</div>
    </div>
    <div style="display:flex; gap:4px; flex-shrink:0;">
      <button class="bam-action-btn bam-btn-color" data-name="${safeName}" title="修改颜色" style="
        background:rgba(255,255,255,0.06); border:none; color:#888;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&#x1F3A8;</button>
      <button class="bam-action-btn bam-btn-replace" data-name="${safeName}" title="替换图片" style="
        background:rgba(255,255,255,0.06); border:none; color:#888;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&#x21BB;</button>
      <button class="bam-action-btn bam-btn-rename" data-name="${safeName}" title="重命名" style="
        background:rgba(255,255,255,0.06); border:none; color:#888;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&#x270E;</button>
      <button class="bam-action-btn bam-btn-delete" data-name="${safeName}" title="删除" style="
        background:rgba(255,80,80,0.1); border:none; color:#e55;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&times;</button>
      <button class="bam-action-btn bam-btn-mood-toggle" data-name="${safeName}" title="情绪差分" style="
        background:rgba(74,108,247,0.12); border:none; color:#8ba4f7;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:11px;">▼</button>
    </div>
  </div>
  <div class="bam-mood-panel" data-name="${safeName}" style="display:none; padding:8px 12px 12px; border-top:1px solid rgba(255,255,255,0.04); max-height:40vh; overflow-y:auto; -webkit-overflow-scrolling:touch;"></div>
</div>`;
  }

  // -- 事件绑定 --

  _bindEvents() {
    const doc = this._getMainDocument();
    const $ = (s) => doc.querySelector(s);

    $('#bam-btn-close').addEventListener('click', () => this.close());
    $('#bam-btn-style-sync-now')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await this.styleSync.refresh(); }
      catch (error) { alert('美化同步失败: ' + String(error.message || error)); }
      finally { button.disabled = false; }
    });
    $('#bam-btn-sync-now')?.addEventListener('click', async () => {
      const button = $('#bam-btn-sync-now');
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = '同步中…';
      try {
        await Promise.all([
          this.avatarSync.refreshCurrentScope({ publishLocal: true, force: true }),
          this.styleSync.refresh(),
        ]);
        await this._refreshList();
      } catch (error) {
        alert('头像同步失败: ' + String(error.message || error));
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    });

    // - Tab 切换 -
    doc.querySelectorAll('.bam-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab).catch(this.onError));
    });

    // - 全局头像切换 -
    doc.querySelectorAll('input[name="bam-target-scope"]').forEach(radio => {
      radio.addEventListener('change', () => this._refreshList());
    });
    $('#bam-chk-global-avatar-fallback')?.addEventListener('change', async (event) => {
      const checkbox = event.currentTarget;
      const enabled = Boolean(checkbox.checked);
      checkbox.disabled = true;
      try {
        await this.db.setConfig('style_globalAvatarFallback', enabled);
        writeStyleSnapshot({ style_globalAvatarFallback: enabled });
        this._requestAvatarAssetPreviewRefresh();
      } catch (error) {
        checkbox.checked = !enabled;
        alert('保存全局头像回退设置失败: ' + String(error.message || error));
      } finally {
        checkbox.disabled = false;
      }
    });

    // - 远程头像操作 -
    $('#bam-btn-fetch-remote')?.addEventListener('click', async () => {
      const btn = doc.getElementById('bam-btn-fetch-remote');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '检查中...';

      const charId = this._getActiveCharId();
      let fetched = 0, failed = 0;
      const compOpts = await getCompressOptions(this.db);

      // 收集所有需要拉取的记录
      const tasks = [];

      const avatars = await this.db.list(charId);
      for (const av of avatars) {
        const record = await this.db.get(charId, av.displayName);
        if (record && record.sourceUrl && record.sourceUrl !== 'null' && !record.imageBlob) {
          tasks.push({ type: 'avatar', name: av.displayName, record });
        }
      }

      const allMoods = await new Promise((resolve, reject) => {
        const req = this.db.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('查询失败'));
      });
      for (const r of allMoods.filter(r => r.charId === charId && r.sourceUrl && r.sourceUrl !== 'null' && !r.imageBlob)) {
        tasks.push({ type: 'mood', record: r });
      }

      if (!tasks.length) {
        btn.textContent = originalText;
        btn.disabled = false;
        alert('没有需要拉取的远程头像');
        return;
      }

      // 逐个拉取并更新进度
      for (let i = 0; i < tasks.length; i++) {
        btn.textContent = `拉取中 ${i + 1}/${tasks.length}...`;
        const task = tasks[i];
        try {
          const resp = await fetch(task.record.sourceUrl);
          if (!resp.ok) { failed++; continue; }
          let blob = await resp.blob();
          blob = await compressImage(blob, compOpts);
          if (task.type === 'avatar') {
            await this.db.update(charId, task.name, blob);
          } else {
            task.record.imageBlob = blob;
            task.record.fileSize = blob.size;
            task.record.mimeType = blob.type || task.record.mimeType;
            task.record.updatedAt = Date.now();
            await this.db._put(STORE_MOOD_AVATARS, task.record);
          }
          fetched++;
        } catch (_) { failed++; }
      }

      btn.textContent = originalText;
      btn.disabled = false;
      alert(`远程头像拉取完成: ${fetched} 张成功${failed ? ', ' + failed + ' 张失败' : ''}`);
      await this._refreshList();
    });
    $('#bam-btn-clear-remote-cache')?.addEventListener('click', async () => {
      if (!confirm('确定清除所有远程头像的本地缓存？下次渲染时会重新拉取。')) return;
      const charId = this._getActiveCharId();
      let cleared = 0;

      // 主头像
      const allAvatars = await new Promise((resolve, reject) => {
        const req = this.db.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('查询失败'));
      });
      const prefix = charId + CHAR_ID_SEPARATOR;
      for (const r of allAvatars.filter(r => r.alias.startsWith(prefix) && r.sourceUrl && r.sourceUrl !== 'null')) {
        r.imageBlob = null;
        r.fileSize = 0;
        r.updatedAt = Date.now();
        await this.db._put(STORE_AVATARS, r);
        cleared++;
      }

      // 情绪差分头像
      const allMoods = await new Promise((resolve, reject) => {
        const req = this.db.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('查询失败'));
      });
      for (const r of allMoods.filter(r => r.charId === charId && r.sourceUrl && r.sourceUrl !== 'null')) {
        r.imageBlob = null;
        r.fileSize = 0;
        r.updatedAt = Date.now();
        await this.db._put(STORE_MOOD_AVATARS, r);
        cleared++;
      }

      alert(`已清除 ${cleared} 张远程头像缓存`);
      this.db._blobUrlCache.clear();
      await this._refreshList();
    });

    // - 缩略图点击大图预览（头像 + 情绪差分统一处理）-
    const container = doc.getElementById('bam-container');
    container?.addEventListener('click', (e) => {
      const thumb = e.target.closest('.bam-avatar-thumb');
      if (!thumb) return;
      const src = thumb.dataset.previewSrc;
      if (!src || src.startsWith('data:')) return;
      e.stopPropagation();
      this._openImagePreview(src, thumb.dataset.previewTitle || '');
    });

    // - 头像管理 Tab 事件 -

    $('#bam-btn-add-remote-avatar')?.addEventListener('click', async () => {
      const name = prompt('角色名（用于渲染时匹配）:');
      if (!name || !name.trim()) return;
      const url = prompt('远程图片 URL（如 https://files.catbox.moe/xxx.png）:');
      if (!url || !url.trim()) return;
      const charId = this._getActiveCharId();
      try {
        const existing = await this.db.get(charId, name.trim());
        if (existing) {
          this.db._revokeCachedUrl(buildAvatarKey(charId, name.trim()));
          await this.db._put(STORE_AVATARS, {
            ...existing, imageBlob: null, sourceUrl: url.trim(), syncedUrl: null,
            fileSize: 0, updatedAt: Date.now()
          });
        } else {
          await this.db.add(charId, name.trim(), null, { sourceUrl: url.trim(), mimeType: 'image/webp' });
        }
        await this._refreshList();
      } catch (err) { alert('添加失败: ' + err.message); }
    });

    $('#bam-upload-area').addEventListener('click', () => $('#bam-file-input').click());

    const uploadArea = $('#bam-upload-area');
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = 'rgba(74,108,247,0.5)';
      uploadArea.style.background = 'rgba(74,108,247,0.05)';
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.style.borderColor = 'rgba(255,255,255,0.12)';
      uploadArea.style.background = 'transparent';
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = 'rgba(255,255,255,0.12)';
      uploadArea.style.background = 'transparent';
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) this._handleFileSelected(file);
    });

    $('#bam-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this._handleFileSelected(file);
      e.target.value = '';
    });

    $('#bam-btn-cancel-upload').addEventListener('click', () => this._hideAliasInput());
    $('#bam-btn-confirm-upload').addEventListener('click', () => this._confirmUpload());
    $('#bam-alias-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._confirmUpload(); });

    // 颜色预设圆点点击
    this.selectedColor = '#58a6ff';
    doc.querySelectorAll('.bam-color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        this.selectedColor = dot.dataset.color;
        $('#bam-color-input').value = dot.dataset.color;
        doc.querySelectorAll('.bam-color-dot').forEach(d => d.style.borderColor = 'transparent');
        dot.style.borderColor = '#fff';
      });
    });
    // 自定义颜色输入同步
    $('#bam-color-input').addEventListener('input', (e) => {
      this.selectedColor = e.target.value;
      doc.querySelectorAll('.bam-color-dot').forEach(d => d.style.borderColor = 'transparent');
    });

    $('#bam-btn-export').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const originalText = button.textContent;
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = '正在导出...';
      try {
        if (this.currentTab === 'mood') await this.db.exportTemplateToFile();
        else if (this.currentTab === 'style') await this.db.exportStyleSettingsToFile();
        else await this.db.exportCharacterDataToFile(this._getActiveCharId());
      }
      catch (err) { alert('导出失败: ' + err.message); }
      finally { button.disabled = false; button.textContent = originalText; }
    });

    $('#bam-btn-import').addEventListener('click', () => $('#bam-import-input').click());
    $('#bam-import-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const importBtn = $('#bam-btn-import');
      const origText = importBtn ? importBtn.textContent : '';
      if (importBtn) { importBtn.disabled = true; importBtn.textContent = '导入中...'; }
      try {
        const result = await this.db.importFromFile(file, this._getActiveCharId());
        let msg = `导入完成: 成功 ${result.imported} 项`;
        if (result.linked) msg += `\n其中 ${result.linked} 项仅含图片链接，备份中没有图片文件，显示仍依赖链接可用`;
        if (result.skipped) msg += `, 跳过 ${result.skipped} 项`;
        if (result.errors?.length) msg += `\n错误: ${result.errors.join(', ')}`;
        alert(msg);
        await this.onRefresh();
        await this._refreshList();
        if (this.currentTab === 'mood') await this._loadMoodConfigTab();
        if (this.currentTab === 'style') await this._loadStyleSettings();
      } catch (err) { alert('导入失败: ' + err.message); }
      finally {
        if (importBtn) { importBtn.disabled = false; importBtn.textContent = origText; }
        e.target.value = '';
      }
    });

    $('#bam-avatar-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.bam-action-btn');
      if (!btn) return;
      const name = btn.dataset.name;
      if (btn.classList.contains('bam-btn-delete')) this._handleDelete(name);
      else if (btn.classList.contains('bam-btn-rename')) this._handleRename(name);
      else if (btn.classList.contains('bam-btn-replace')) this._handleReplace(name);
      else if (btn.classList.contains('bam-btn-color')) this._handleChangeColor(name);
      else if (btn.classList.contains('bam-btn-mood-toggle')) this._handleMoodToggle(name);
    });

    $('#bam-avatar-list').addEventListener('click', (e) => {
      const moodBtn = e.target.closest('.bam-mood-action');
      if (!moodBtn) return;
      const name = moodBtn.dataset.name;
      const moodId = moodBtn.dataset.moodId;
      if (moodBtn.classList.contains('bam-mood-upload')) this._handleMoodUpload(name, moodId);
      else if (moodBtn.classList.contains('bam-mood-delete')) this._handleMoodDelete(name, moodId);
      else if (moodBtn.classList.contains('bam-mood-remote')) this._handleMoodRemoteUrl(name, moodId);
    });

    // - 正文美化 Tab 事件 -
    const applyLiveStylePreview = () => {
      this._applyBubblePreviewStyles().catch((err) => {
        console.warn('Bubble 预览样式应用失败:', err);
      });
    };
    const markStyleDirty = () => {
      if (!this._styleDraftLoaded) this._styleDraftLoaded = true;
      this._setStyleDraftDirty(true);
    };
    const previewAndMarkDirty = () => {
      applyLiveStylePreview();
      markStyleDirty();
    };
    const bindRangeSetting = ({ inputId, valueId, formatter }) => {
      const inputEl = $(inputId);
      const valueEl = $(valueId);
      if (!inputEl || !valueEl) return;
      const syncDisplay = (value) => {
        valueEl.textContent = formatter(value);
      };
      inputEl.addEventListener('input', (e) => {
        syncDisplay(e.target.value);
        previewAndMarkDirty();
      });
      inputEl.addEventListener('change', (e) => {
        syncDisplay(e.target.value);
        previewAndMarkDirty();
      });
    };

    bindRangeSetting({ inputId: '#bam-range-dialogue-font', valueId: '#bam-val-dialogue-font', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-narration-font', valueId: '#bam-val-narration-font', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-dialogue-spacing', valueId: '#bam-val-dialogue-spacing', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-dialogue-weight', valueId: '#bam-val-dialogue-weight', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-narration-weight', valueId: '#bam-val-narration-weight', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-name-weight', valueId: '#bam-val-name-weight', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-narration-bg-opacity', valueId: '#bam-val-narration-bg-opacity', formatter: (v) => Number.parseFloat(v).toFixed(2) });
    bindRangeSetting({ inputId: '#bam-range-avatar-size', valueId: '#bam-val-avatar-size', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-narration-indent', valueId: '#bam-val-narration-indent', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-narration-border-radius', valueId: '#bam-val-narration-border-radius', formatter: (v) => `${v}px` });
    // v7.0
    bindRangeSetting({ inputId: '#bam-range-narration-text-indent', valueId: '#bam-val-narration-text-indent', formatter: (v) => `${v}em` });
    bindRangeSetting({ inputId: '#bam-range-narration-line-height', valueId: '#bam-val-narration-line-height', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-narration-padding-right', valueId: '#bam-val-narration-padding-right', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-compress-quality', valueId: '#bam-val-compress-quality', formatter: (v) => Number.parseFloat(v).toFixed(2) });
    $('#bam-chk-compress-enabled')?.addEventListener('change', () => { markStyleDirty(); });

    doc.querySelectorAll('input[name="bam-avatar-shape"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    doc.querySelectorAll('input[name="bam-color-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    ['#bam-global-color-picker', '#bam-narration-bg-color'].forEach((selector) => {
      $(selector)?.addEventListener('input', () => {
        previewAndMarkDirty();
      });
      $(selector)?.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    ['#bam-select-narration-font', '#bam-select-dialogue-font', '#bam-select-name-font'].forEach((selector) => {
      $(selector)?.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    const fontUrlInput = $('#bam-font-url-input');
    fontUrlInput?.addEventListener('input', () => {
      markStyleDirty();
    });
    fontUrlInput?.addEventListener('change', () => {
      markStyleDirty();
    });
    $('#bam-btn-refresh-fonts')?.addEventListener('click', async () => {
      try {
        await this._refreshFontSelectors({ forceRemote: true, silent: false });
        await this._applyBubblePreviewStyles();
        markStyleDirty();
      } catch (err) {
        console.warn('刷新远程字体失败:', err);
        alert(`字体列表刷新失败：${err.message}`);
      }
    });

    // - CSS 字体导入 -
    $('#bam-btn-import-css-font')?.addEventListener('click', async () => {
      const urlInput = doc.getElementById('bam-css-font-url-input');
      const cssUrl = urlInput?.value?.trim();
      if (!cssUrl) { alert('请输入 CSS URL'); return; }
      const btn = doc.getElementById('bam-btn-import-css-font');
      const originalText = btn.textContent;
      btn.textContent = '解析中...';
      btn.disabled = true;
      try {
        const result = await this._parseCssFontFaces(cssUrl);
        if (!result.families.length) { alert('未在 CSS 中找到任何 @font-face 声明'); return; }
        await this.db.addCssFontSource(cssUrl, result.families);
        urlInput.value = '';
        await this._renderCssFontSources();
        await this._refreshFontSelectors({ forceRemote: false, silent: true });
        previewAndMarkDirty();
        alert(`成功导入 ${result.families.length} 个字体族：${result.families.join('、')}`);
      } catch (err) {
        alert(`CSS 字体导入失败：${err.message}`);
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
    doc.getElementById('bam-css-font-sources')?.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.bam-css-font-delete');
      if (!delBtn) return;
      const url = delBtn.dataset.url;
      if (!confirm(`确定删除此 CSS 字体源？`)) return;
      await this.db.deleteCssFontSource(url);
      await this._renderCssFontSources();
      await this._refreshFontSelectors({ forceRemote: false, silent: true });
      previewAndMarkDirty();
    });

    // - 本地字体上传 -
    const fontUploadBtn = $('#bam-btn-upload-local-font');
    fontUploadBtn?.addEventListener('click', () => {
      doc.getElementById('bam-local-font-input')?.click();
    });
    $('#bam-local-font-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      if (file.size > LOCAL_FONT_MAX_SIZE) { alert(`字体文件不能超过 ${LOCAL_FONT_MAX_SIZE / 1024 / 1024}MB`); return; }
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!FONT_EXT_FORMAT_MAP[ext]) { alert('不支持的字体格式，请选择 .woff2 / .woff / .ttf / .otf'); return; }
      const family = file.name.replace(/\.[^.]+$/, '').trim();
      if (!family) { alert('无法从文件名提取字体名称'); return; }
      const existing = await this.db.getLocalFont(family);
      if (existing && !confirm(`已存在同名字体「${family}」，是否替换？`)) return;
      const origText = fontUploadBtn ? fontUploadBtn.textContent : '';
      if (fontUploadBtn) { fontUploadBtn.disabled = true; fontUploadBtn.textContent = '上传中...'; }
      try {
        await this.db.addLocalFont(family, file, { fileName: file.name, mimeType: FONT_EXT_MIME_MAP[ext] });
        await this._renderLocalFontList();
        await this._refreshFontSelectors({ forceRemote: false, silent: true });
        previewAndMarkDirty();
      } catch (err) { alert('字体上传失败：' + err.message); }
      finally { if (fontUploadBtn) { fontUploadBtn.disabled = false; fontUploadBtn.textContent = origText; } }
    });
    doc.getElementById('bam-local-font-list')?.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.bam-local-font-delete');
      if (!delBtn) return;
      const family = delBtn.dataset.family;
      if (!confirm(`确定删除本地字体「${family}」？`)) return;
      try {
        await this.db.deleteLocalFont(family);
        await this._renderLocalFontList();
        await this._refreshFontSelectors({ forceRemote: false, silent: true });
        previewAndMarkDirty();
      } catch (err) { alert('删除失败：' + err.message); }
    });

    doc.querySelectorAll('input[name="bam-md-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        markStyleDirty();
      });
    });

    $('#bam-btn-save-style')?.addEventListener('click', async () => {
      await this._saveCurrentStyleSettings();
    });
    $('#bam-btn-reset-style').addEventListener('click', () => this._resetStyleDefaults());
  }

  // -- CSS 字体解析 --

  async _parseCssFontFaces(cssUrl) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS) : null;
    try {
      const response = await fetch(cssUrl, { method: 'GET', cache: 'no-store', signal: controller?.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const cssText = await response.text();
      const fontFaceRegex = /@font-face\s*\{([^}]+)\}/gi;
      const familyRegex = /font-family\s*:\s*['"]?([^'";]+)['"]?\s*;/i;
      const families = new Set();
      let match;
      while ((match = fontFaceRegex.exec(cssText)) !== null) {
        const familyMatch = familyRegex.exec(match[1]);
        if (familyMatch) families.add(familyMatch[1].trim());
      }
      return { url: cssUrl, families: Array.from(families) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- 本地字体列表渲染 --

  async _renderLocalFontList() {
    const doc = this._getMainDocument();
    const container = doc.getElementById('bam-local-font-list');
    if (!container) return;
    try {
      const fonts = await this.db.listLocalFonts();
      if (!fonts.length) {
        container.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:6px 0;">暂无本地字体</div>';
        return;
      }
      container.innerHTML = fonts.map(f => {
        const sizeKB = (f.fileSize / 1024).toFixed(1);
        const safeFamily = escapeHtmlAttr(f.family);
        return `<div style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:rgba(255,255,255,0.03); border-radius:6px; margin-bottom:4px;">
          <span style="color:#ccc; font-size:12px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeFamily}">${safeFamily}</span>
          <span style="color:#666; font-size:11px; flex-shrink:0;">${sizeKB} KB</span>
          <button class="bam-local-font-delete" data-family="${safeFamily}" style="background:rgba(255,80,80,0.1); border:none; color:#e55; width:22px; height:22px; border-radius:4px; cursor:pointer; font-size:12px; flex-shrink:0; line-height:1;">&times;</button>
        </div>`;
      }).join('');
    } catch (_) {
      container.innerHTML = '';
    }
  }

  // -- CSS 字体源列表渲染 --

  async _renderCssFontSources() {
    const doc = this._getMainDocument();
    const container = doc.getElementById('bam-css-font-sources');
    if (!container) return;
    try {
      const sources = await this.db.getCssFontSources();
      if (!sources.length) {
        container.innerHTML = '';
        return;
      }
      container.innerHTML = sources.map(src => {
        const safeUrl = escapeHtmlAttr(src.url);
        const familyText = (src.families || []).join('、') || '未知';
        return `<div style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:rgba(255,255,255,0.03); border-radius:6px; margin-bottom:4px;">
          <div style="flex:1; min-width:0; overflow:hidden;">
            <div style="color:#ccc; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeUrl}">${safeUrl}</div>
            <div style="color:#888; font-size:10px; margin-top:2px;">字体族：${escapeHtmlAttr(familyText)}</div>
          </div>
          <button class="bam-css-font-delete" data-url="${safeUrl}" style="background:rgba(255,80,80,0.1); border:none; color:#e55; width:22px; height:22px; border-radius:4px; cursor:pointer; font-size:12px; flex-shrink:0; line-height:1;">&times;</button>
        </div>`;
      }).join('');
    } catch (_) {
      container.innerHTML = '';
    }
  }

  // -- 文件处理 --

  _handleFileSelected(file) {
    if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
    if (!file.type.startsWith('image/')) { alert('请选择图片文件'); return; }
    this.pendingFile = file;
    const doc = this._getMainDocument();
    const reader = new FileReader();
    reader.onload = (e) => { doc.getElementById('bam-preview-img').src = e.target.result; };
    reader.readAsDataURL(file);
    const suggested = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '').toLowerCase().slice(0, 20);
    doc.getElementById('bam-alias-input').value = suggested;
    this._showAliasInput();
  }

  _showAliasInput() {
    const doc = this._getMainDocument();
    doc.getElementById('bam-alias-input-area').style.display = 'block';
    doc.getElementById('bam-alias-input').focus();
  }

  _hideAliasInput() {
    const doc = this._getMainDocument();
    doc.getElementById('bam-alias-input-area').style.display = 'none';
    this.pendingFile = null;
  }

  async _confirmUpload() {
    if (!this.pendingFile) return;
    const doc = this._getMainDocument();
    const name = doc.getElementById('bam-alias-input').value.trim();
    if (!name) { alert('请输入角色名'); return; }
    const color = this.selectedColor || '#58a6ff';
    const charId = this._getActiveCharId();
    const confirmBtn = doc.getElementById('bam-btn-confirm-upload');
    const origText = confirmBtn ? confirmBtn.textContent : '确认添加';
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '处理中...'; }
    try {
      const meta = await this._getImageMeta(this.pendingFile);
      const compOpts = await getCompressOptions(this.db);
      const blob = await compressImage(this.pendingFile, compOpts);
      await this.db.add(charId, name, blob, meta);
      await this.db.setConfig(buildColorConfigKey(charId, name), color);
      this._hideAliasInput();
      await this._refreshList();
      this._requestAvatarAssetPreviewRefresh();
    } catch (err) {
      if (err.message.includes('已存在')) {
        if (confirm(`角色名 "${name}" 已存在，是否替换图片和颜色？`)) {
          try {
            const meta = await this._getImageMeta(this.pendingFile);
            const compOpts2 = await getCompressOptions(this.db);
            const rBlob = await compressImage(this.pendingFile, compOpts2);
            await this.db.update(charId, name, rBlob, meta);
            await this.db.setConfig(buildColorConfigKey(charId, name), color);
            this._hideAliasInput();
            await this._refreshList();
            this._requestAvatarAssetPreviewRefresh();
          } catch (e2) { alert('替换失败: ' + e2.message); }
        }
      } else { alert('添加失败: ' + err.message); }
    } finally {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = origText; }
    }
  }

  _getImageMeta(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { resolve({ fileName: file.name, width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(img.src); };
      img.onerror = () => { resolve({ fileName: file.name, width: 0, height: 0 }); };
      img.src = URL.createObjectURL(file);
    });
  }

  // -- 列表操作 --

  async _handleDelete(name) {
    if (!confirm(`确定删除头像 "${name}" 及其所有情绪差分头像吗？`)) return;
    const charId = this._getActiveCharId();
    try {
      // 尝试用标准 key 删除
      await this.db.delete(charId, name);
      // 同时尝试直接用 alias 删除（兼容旧版脏数据 key 格式不一致的情况）
      try {
        const prefix = String(charId || GLOBAL_CHAR_ID) + CHAR_ID_SEPARATOR;
        const allAvatars = await new Promise((resolve, reject) => {
          const req = this.db.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(new Error('查询失败'));
        });
        for (const r of allAvatars) {
          if (r.alias.startsWith(prefix) && extractDisplayName(r.alias, charId) === name) {
            await new Promise((resolve, reject) => {
              const tx = this.db.db.transaction(STORE_AVATARS, 'readwrite');
              const req = tx.objectStore(STORE_AVATARS).delete(r.alias);
              req.onsuccess = () => resolve();
              req.onerror = () => reject(new Error('删除失败'));
            });
          }
        }
      } catch (_) {}
      await this.db.deleteAllMoodAvatars(charId, name);
      try { await this.db.setConfig(buildColorConfigKey(charId, name), null); } catch (_) { /* ignore */ }
      if (this._expandedMoodName === name) this._expandedMoodName = null;
      await this._refreshList();
      this._requestAvatarAssetPreviewRefresh();
    }
    catch (err) { alert('删除失败: ' + err.message); }
  }

  async _handleChangeColor(name) {
    const charId = this._getActiveCharId();
    const currentColor = await this.db.getConfig(buildColorConfigKey(charId, name), '#58a6ff');
    this._openMobileColorDialog({
      title: `角色主题色 · ${name}`,
      initialValue: currentColor || '#58a6ff',
      onConfirm: async (nextColor) => {
        await this.db.setConfig(buildColorConfigKey(charId, name), nextColor);
        await this._refreshList();
        this._requestAvatarAssetPreviewRefresh();
      }
    });
  }

  async _handleRename(name) {
    const newName = prompt(`将 "${name}" 重命名为:`, name);
    if (!newName || newName.trim().toLowerCase() === name) return;
    try {
      await this.db.rename(this._getActiveCharId(), name, newName.trim());
      await this._refreshList();
      this._requestAvatarAssetPreviewRefresh();
    }
    catch (err) { alert('重命名失败: ' + err.message); }
  }

  async _handleReplace(name) {
    const doc = this._getMainDocument();
    const charId = this._getActiveCharId();
    const replaceBtn = doc.querySelector(`.bam-btn-replace[data-name="${name}"]`);
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/gif,image/webp';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
      const origText = replaceBtn ? replaceBtn.textContent : '';
      if (replaceBtn) { replaceBtn.disabled = true; replaceBtn.textContent = '处理中...'; }
      try {
        const meta = await this._getImageMeta(file);
        const compOpts = await getCompressOptions(this.db);
        const blob = await compressImage(file, compOpts);
        await this.db.update(charId, name, blob, meta);
        await this._refreshList();
        this._requestAvatarAssetPreviewRefresh();
      } catch (err) {
        alert('替换失败: ' + err.message);
        if (replaceBtn) { replaceBtn.disabled = false; replaceBtn.textContent = origText; }
      }
    };
    input.click();
  }

  _getActiveCharId() {
    const doc = this._getMainDocument();
    const radio = doc.querySelector('input[name="bam-target-scope"]:checked');
    if (radio && radio.value === 'global') return GLOBAL_CHAR_ID;
    return this._charId;
  }

  async _refreshList() {
    const doc = this._getMainDocument();
    const listEl = doc.getElementById('bam-avatar-list');
    const statsEl = doc.getElementById('bam-stats');
    const charNameEl = doc.getElementById('bam-char-name');
    const charId = this._getActiveCharId();

    if (charNameEl) {
      charNameEl.textContent = charId === GLOBAL_CHAR_ID
        ? '⚠ 全局分区'
        : `${this._charName}`;
    }

    const avatars = await this.db.list(charId);
    const stats = await this.db.getStats(charId);
    statsEl.textContent = `已存储: ${stats.count} 张 | 总计: ${(stats.totalSize / 1024).toFixed(1)} KB`;
    if (avatars.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:#555;padding:30px 0;font-size:13px;">还没有头像，点击上方区域添加</div>';
      return;
    }
    const rows = await Promise.all(avatars.map(async (avatar) => {
      const [record, color] = await Promise.all([
        this.db.get(charId, avatar.displayName),
        this.db.getConfig(buildColorConfigKey(charId, avatar.displayName), null),
      ]);
      const blobUrl = this.db._recordUrl(buildAvatarKey(charId, avatar.displayName), record);
      const sourceInfo = record?.syncedUrl
        ? '<span style="color:#7ee787;font-size:9px;">多端✓</span>'
        : (record?.sourceUrl && record.sourceUrl !== 'null'
          ? '<span style="color:#58a6ff;font-size:9px;">远程</span>'
          : '<span style="color:#aaa;font-size:9px;">本地待同步</span>');
      return this._avatarItemHTML(avatar, blobUrl, color, sourceInfo);
    }));
    const html = rows.join('');
    listEl.innerHTML = html;

    if (this._expandedMoodName) {
      await this._renderMoodPanel(this._expandedMoodName);
    }
  }

  // -- 情绪差分面板 --

  async _handleMoodToggle(name) {
    const doc = this._getMainDocument();
    const panel = doc.querySelector(`.bam-mood-panel[data-name="${name}"]`);
    if (!panel) return;

    if (this._expandedMoodName === name) {
      panel.style.display = 'none';
      this._expandedMoodName = null;
      return;
    }

    doc.querySelectorAll('.bam-mood-panel').forEach(p => { p.style.display = 'none'; });
    this._expandedMoodName = name;
    await this._renderMoodPanel(name);
  }

  async _renderMoodPanel(name) {
    const doc = this._getMainDocument();
    const panel = doc.querySelector(`.bam-mood-panel[data-name="${name}"]`);
    if (!panel) return;

    const charId = this._getActiveCharId();
    const safeName = escapeHtmlAttr(name);
    const moodAvatars = await this.db.listMoodAvatars(charId, name);
    const moodMap = new Map(moodAvatars.map(ma => [ma.moodId, ma]));
    const uploadedCount = moodMap.size;

    // 从 mood_config 动态读取颜色，回退到 MOOD_GROUPS 默认色
    const moodColorMap = new Map(MOOD_GROUPS.map(g => [g.id, g.color]));
    try {
      const raw = await this.db.getConfig('mood_config', null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.groups)) {
          parsed.groups.forEach(g => { if (g.id && g.color) moodColorMap.set(g.id, g.color); });
        }
      }
    } catch (_) { /* 回退到默认色 */ }

    let html = `<div style="color:#999; font-size:11px; margin-bottom:8px;">情绪差分头像（已上传 ${uploadedCount}/${MOOD_GROUPS.length}）</div>`;
    for (const group of MOOD_GROUPS) {
      const groupColor = moodColorMap.get(group.id) || group.color;
      const colorDot = `<span style="width:16px; height:16px; border-radius:50%; background:${groupColor}; display:inline-block; flex-shrink:0;"></span>`;
      const ma = moodMap.get(group.id);
      if (ma) {
        const blobUrl = await this.db.getMoodAvatarBlobUrl(charId, name, group.id);
        const safeMoodSrc = blobUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const moodSourceTag = (ma.sourceUrl && ma.sourceUrl !== 'null')
          ? (ma.imageBlob ? '<span style="color:#58a6ff;font-size:9px;">远程✓</span>' : '<span style="color:#eab308;font-size:9px;">远程⏳</span>')
          : '<span style="color:#7ee787;font-size:9px;">本地</span>';
        html += `<div style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          ${colorDot}
          <span style="width:40px; color:#aaa; font-size:12px;">${group.label}</span>
          <img src="${safeMoodSrc}" class="bam-avatar-thumb" data-preview-src="${safeMoodSrc}" data-preview-title="${safeName} · ${group.label}" style="width:32px; height:32px; border-radius:4px; object-fit:cover; border:1px solid rgba(255,255,255,0.1); cursor:pointer;" />
          ${moodSourceTag}
          <span style="flex:1; color:#666; font-size:11px;">${(ma.fileSize/1024).toFixed(1)} KB</span>
          <button class="bam-mood-action bam-mood-upload" data-name="${safeName}" data-mood-id="${group.id}" style="background:rgba(255,255,255,0.06); border:none; color:#888; padding:3px 8px; border-radius:4px; cursor:pointer; font-size:11px;">替换</button>
          <button class="bam-mood-action bam-mood-delete" data-name="${safeName}" data-mood-id="${group.id}" style="background:rgba(255,80,80,0.1); border:none; color:#e55; padding:3px 8px; border-radius:4px; cursor:pointer; font-size:11px;">删除</button>
        </div>`;
      } else {
        html += `<div style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          ${colorDot}
          <span style="width:40px; color:#aaa; font-size:12px;">${group.label}</span>
          <button class="bam-mood-action bam-mood-upload" data-name="${safeName}" data-mood-id="${group.id}" style="flex:1; background:rgba(255,255,255,0.04); border:1px dashed rgba(255,255,255,0.1); color:#666; padding:4px 0; border-radius:4px; cursor:pointer; font-size:11px; text-align:center;">点击上传</button>
          <button class="bam-mood-action bam-mood-remote" data-name="${safeName}" data-mood-id="${group.id}" style="background:none; border:1px dashed rgba(74,108,247,0.3); color:#8ba4f7; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; flex-shrink:0;">🔗</button>
        </div>`;
      }
    }
    panel.innerHTML = html;
    panel.style.display = 'block';
  }

  async _handleMoodUpload(name, moodId) {
    const doc = this._getMainDocument();
    const charId = this._getActiveCharId();
    const moodBtn = doc.querySelector(`.bam-mood-upload[data-name="${name}"][data-mood-id="${moodId}"]`);
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/gif,image/webp';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
      const origText = moodBtn ? moodBtn.textContent : '';
      if (moodBtn) { moodBtn.disabled = true; moodBtn.textContent = '处理中...'; }
      try {
        const meta = await this._getImageMeta(file);
        const compOpts = await getCompressOptions(this.db);
        const blob = await compressImage(file, compOpts);
        await this.db.addMoodAvatar(charId, name, moodId, blob, meta);
        await this._renderMoodPanel(name);
        this._requestAvatarAssetPreviewRefresh();
      } catch (err) {
        alert('上传失败: ' + err.message);
        if (moodBtn) { moodBtn.disabled = false; moodBtn.textContent = origText; }
      }
    };
    input.click();
  }

  async _handleMoodRemoteUrl(name, moodId) {
    const url = prompt(`输入 "${name}" 的 ${moodId} 情绪差分远程图片 URL:`);
    if (!url || !url.trim()) return;
    const charId = this._getActiveCharId();
    try {
      const id = buildMoodAvatarKey(charId, name, moodId);
      const existing = await this.db._getByKey(STORE_MOOD_AVATARS, id);
      if (existing) {
        this.db._revokeCachedUrl('mood_' + id);
        existing.imageBlob = null;
        existing.sourceUrl = url.trim();
        existing.syncedUrl = null;
        existing.fileSize = 0;
        existing.updatedAt = Date.now();
        await this.db._put(STORE_MOOD_AVATARS, existing);
      } else {
        const record = {
          id, charId, alias: name.trim().toLowerCase(), moodId,
          imageBlob: null, sourceUrl: url.trim(), syncedUrl: null,
          mimeType: 'image/webp', fileName: '',
          fileSize: 0, width: 0, height: 0,
          createdAt: Date.now(), updatedAt: Date.now()
        };
        await this.db._put(STORE_MOOD_AVATARS, record);
      }
      await this._renderMoodPanel(name);
    } catch (err) { alert('设置失败: ' + err.message); }
  }

  async _handleMoodDelete(name, moodId) {
    const group = MOOD_GROUPS.find(g => g.id === moodId);
    if (!confirm(`确定删除 "${name}" 的 ${group?.label || moodId} 差分头像吗？`)) return;
    try {
      await this.db.deleteMoodAvatar(this._getActiveCharId(), name, moodId);
      await this._renderMoodPanel(name);
      this._requestAvatarAssetPreviewRefresh();
    } catch (err) { alert('删除失败: ' + err.message); }
  }

  // -- Tab 切换 --

  async _switchTab(tabName) {
    const doc = this._getMainDocument();
    this.currentTab = tabName;
    doc.querySelectorAll('.bam-tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === tabName;
      btn.style.color = isActive ? '#e0e0e0' : '#666';
      btn.style.fontWeight = isActive ? '600' : '500';
      btn.style.borderBottomColor = isActive ? '#4a6cf7' : 'transparent';
    });
    const avatarTab = doc.getElementById('bam-tab-avatar');
    const styleTab = doc.getElementById('bam-tab-style');
    const moodTab = doc.getElementById('bam-tab-mood');
    const importBtn = doc.getElementById('bam-btn-import');
    const exportBtn = doc.getElementById('bam-btn-export');

    avatarTab.style.display = 'none';
    styleTab.style.display = 'none';
    moodTab.style.display = 'none';
    importBtn.style.display = '';
    exportBtn.style.display = '';
    const scope = tabName === 'mood' ? '情绪与提示词' : tabName === 'style' ? '美化设置' : '角色头像';
    importBtn.title = '导入' + scope;
    exportBtn.title = '导出' + scope;

    if (tabName === 'avatar') {
      avatarTab.style.display = 'flex';
      importBtn.style.display = '';
      exportBtn.style.display = '';
      // 切换回头像管理时刷新已展开的差分面板（颜色可能在情绪配置页被修改）
      if (this._expandedMoodName) {
        await this._renderMoodPanel(this._expandedMoodName);
      }
    } else if (tabName === 'style') {
      styleTab.style.display = 'flex';
      if (!this._styleDraftLoaded) await this._loadStyleSettings();
      await this._renderLocalFontList();
      await this._renderCssFontSources();
    } else if (tabName === 'mood') {
      moodTab.style.display = 'flex';
      if (!this._moodConfigLoaded) await this._loadMoodConfigTab();
    }
  }

  // -- 正文美化：加载配置 --

  _applyStyleSettingsToControls(settings) {
    const doc = this._getMainDocument();
    const $ = (s) => doc.querySelector(s);

    $('#bam-range-dialogue-font').value = settings.style_dialogueFontSize;
    $('#bam-val-dialogue-font').textContent = `${settings.style_dialogueFontSize}px`;
    $('#bam-range-narration-font').value = settings.style_narrationFontSize;
    $('#bam-val-narration-font').textContent = `${settings.style_narrationFontSize}px`;
    $('#bam-range-dialogue-spacing').value = settings.style_dialogueSpacing;
    $('#bam-val-dialogue-spacing').textContent = `${settings.style_dialogueSpacing}px`;
    $('#bam-range-dialogue-weight').value = settings.style_dialogueFontWeight;
    $('#bam-val-dialogue-weight').textContent = `${settings.style_dialogueFontWeight}`;
    $('#bam-range-narration-weight').value = settings.style_narrationFontWeight;
    $('#bam-val-narration-weight').textContent = `${settings.style_narrationFontWeight}`;
    $('#bam-range-name-weight').value = settings.style_nameFontWeight;
    $('#bam-val-name-weight').textContent = `${settings.style_nameFontWeight}`;
    $('#bam-global-color-picker').value = settings.style_globalTextColor;
    $('#bam-narration-bg-color').value = settings.style_narrationBgColor;
    $('#bam-range-narration-bg-opacity').value = settings.style_narrationBgOpacity;
    $('#bam-val-narration-bg-opacity').textContent = Number.parseFloat(settings.style_narrationBgOpacity).toFixed(2);
    $('#bam-range-avatar-size').value = settings.style_avatarSize;
    $('#bam-val-avatar-size').textContent = `${settings.style_avatarSize}px`;
    $('#bam-range-narration-indent').value = settings.style_narrationIndent;
    $('#bam-val-narration-indent').textContent = `${settings.style_narrationIndent}px`;
    $('#bam-range-narration-border-radius').value = settings.style_narrationBorderRadius;
    $('#bam-val-narration-border-radius').textContent = `${settings.style_narrationBorderRadius}px`;
    // v7.0
    if ($('#bam-range-narration-text-indent')) {
      $('#bam-range-narration-text-indent').value = settings.style_narrationTextIndent;
      $('#bam-val-narration-text-indent').textContent = `${settings.style_narrationTextIndent}em`;
    }
    if ($('#bam-range-narration-line-height')) {
      $('#bam-range-narration-line-height').value = settings.style_narrationLineHeight;
      $('#bam-val-narration-line-height').textContent = `${settings.style_narrationLineHeight}`;
    }
    if ($('#bam-range-narration-padding-right')) {
      $('#bam-range-narration-padding-right').value = settings.style_narrationPaddingRight;
      $('#bam-val-narration-padding-right').textContent = `${settings.style_narrationPaddingRight}px`;
    }
    if ($('#bam-chk-global-avatar-fallback')) {
      $('#bam-chk-global-avatar-fallback').checked = settings.style_globalAvatarFallback === true || settings.style_globalAvatarFallback === 'true';
    }
    if ($('#bam-chk-compress-enabled')) {
      $('#bam-chk-compress-enabled').checked = settings.style_imageCompressEnabled !== false && settings.style_imageCompressEnabled !== 'false';
    }
    if ($('#bam-range-compress-quality')) {
      $('#bam-range-compress-quality').value = settings.style_imageCompressQuality;
      $('#bam-val-compress-quality').textContent = `${Number(settings.style_imageCompressQuality).toFixed(2)}`;
    }
    $('#bam-font-url-input').value = settings.style_fontConfigUrl || '';

    doc.querySelectorAll('input[name="bam-color-mode"]').forEach((radio) => {
      radio.checked = radio.value === settings.style_textColorMode;
    });
    doc.querySelectorAll('input[name="bam-avatar-shape"]').forEach((radio) => {
      radio.checked = radio.value === settings.style_avatarShape;
    });

    $('#bam-select-narration-font').value = settings.style_narrationFontFamily;
    $('#bam-select-dialogue-font').value = settings.style_dialogueFontFamily;
    $('#bam-select-name-font').value = settings.style_nameFontFamily;
  }

  _setStyleDraftDirty(isDirty) {
    this._styleDraftDirty = Boolean(isDirty);
    const doc = this._getMainDocument();
    const saveBtn = doc.getElementById('bam-btn-save-style');
    const tipEl = doc.getElementById('bam-style-save-tip');
    if (saveBtn) {
      saveBtn.disabled = !this._styleDraftDirty;
      saveBtn.style.opacity = this._styleDraftDirty ? '1' : '0.65';
      saveBtn.style.cursor = this._styleDraftDirty ? 'pointer' : 'default';
    }
    if (tipEl) {
      tipEl.textContent = this._styleDraftDirty
        ? '当前调整仅作用于预览；保存后应用到全局，并加入多端同步'
        : '当前样式已保存；多端同步状态见上方，调整后需再次保存';
    }
  }

  async _loadStyleSettings() {
    const config = await this.db.getAllConfig();
    const settings = { ...STYLE_DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([key]) => key in STYLE_DEFAULTS)) };

    this._applyStyleSettingsToControls(settings);
    await this._refreshFontSelectors({ silent: true });
    this._applyStyleSettingsToControls(settings);
    this._styleDraftLoaded = true;
    this._styleSavedBaseline = { ...settings };
    this._setStyleDraftDirty(false);
    await this._applyBubblePreviewStyles(settings);
  }

  // -- 正文美化：保存当前草稿 --

  async _saveCurrentStyleSettings() {
    const settings = this._getLiveStyleSettings();
    try {
      // 只提交相对打开面板时实际改过的字段，保留期间同步进来的其他设置。
      const changes = Object.entries(settings).filter(([key, value]) => !this._styleSavedBaseline || value !== this._styleSavedBaseline[key]);
      await Promise.all(changes.map(([key, value]) => this.db.setConfig(key, value)));
      await this.onStylesSaved();
      await this._loadStyleSettings();
    }
    catch (err) {
      console.error('保存样式配置失败:', err);
      alert('保存样式失败: ' + err.message);
    }
  }

  // -- 正文美化：恢复默认草稿 --

  async _resetStyleDefaults() {
    const defaults = this._getDefaultStyleSettings();
    this._applyStyleSettingsToControls(defaults);
    await this._refreshFontSelectors({ silent: true });
    this._applyStyleSettingsToControls(defaults);
    this._styleDraftLoaded = true;
    this._setStyleDraftDirty(true);
    await this._applyBubblePreviewStyles(defaults);
  }

  // -- 情绪配置 Tab --

  async _loadMoodConfigTab() {
    const { supplement, groups } = await loadPromptSettings(this.db);
    this._promptSupplementDraft = supplement;
    this._moodConfigDraft = groups.map(group => ({ ...group, words: [...group.words] }));
    this._moodConfigLoaded = true;
    this._moodConfigDirty = false;
    this._renderMoodConfigContent();
    this._bindMoodConfigEvents();
  }

  _renderMoodConfigContent() {
    const container = this._getMainDocument().getElementById('bam-tab-mood');
    if (!container) return;
    const prompt = buildPrompt({ supplement: this._promptSupplementDraft, groups: this._moodConfigDraft });
    let html = `
      <div class="bam-prompt-heading">注入预览 <span id="bam-prompt-length">${prompt.length} 字符</span></div>
      <p class="bam-prompt-hint">固定展示协议由程序生成；下面是保存后将使用的完整模板，用户名等宏由酒馆在生成时替换。</p>
      <textarea id="bam-protocol-preview" class="bam-prompt-textarea" aria-label="完整注入模板" readonly>${escapeHtmlAttr(prompt)}</textarea>
      <label class="bam-prompt-heading" for="bam-prompt-supplement">补充提示词</label>
      <p class="bam-prompt-hint">可补充表达偏好，留空即可使用默认规则。请保留固定协议的行头和字段。</p>
      <textarea id="bam-prompt-supplement" class="bam-prompt-textarea bam-prompt-supplement" placeholder="可选的补充要求">${escapeHtmlAttr(this._promptSupplementDraft)}</textarea>
      <div class="bam-prompt-heading">情绪与差分匹配</div>
      <p class="bam-prompt-hint">每组第一个词会作为简短参考注入，其余词只用于本地匹配。池外描述原样显示并使用基础头像。</p>`;
    for (let gi = 0; gi < this._moodConfigDraft.length; gi++) {
      const group = this._moodConfigDraft[gi];
      html += `<div class="bam-mood-group" data-group-index="${gi}" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="bam-mood-color-dot" style="width:16px;height:16px;border-radius:50%;background:${group.color}"></span>
          <span style="color:#ccc;font-size:13px;font-weight:600">${escapeHtmlAttr(group.label)}</span>
          <input type="color" class="bam-mood-color-picker" data-group-index="${gi}" value="${group.color}"
            style="width:24px;height:24px;border:none;background:none;padding:0;margin-left:auto" aria-label="${escapeHtmlAttr(group.label)}分类颜色">
        </div><div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;background:rgba(255,255,255,.03);border-radius:8px">`;
      group.words.forEach((word, wi) => {
        html += `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:rgba(255,255,255,.06);border-radius:4px;font-size:12px;color:#ccc">
          ${escapeHtmlAttr(word)}<button class="bam-mood-word-delete" data-group-index="${gi}" data-word-index="${wi}" aria-label="移除${escapeHtmlAttr(word)}" style="background:none;border:none;color:#888;cursor:pointer">×</button></span>`;
      });
      html += `<button class="bam-mood-word-add" data-group-index="${gi}" style="padding:3px 8px;background:rgba(74,108,247,.12);border:1px dashed rgba(74,108,247,.3);border-radius:4px;color:#8ba4f7;font-size:12px;cursor:pointer">+ 添加</button></div></div>`;
    }
    html += `<div style="display:flex;justify-content:center;gap:12px;margin:16px 0 8px">
        <button id="bam-btn-save-mood" class="bam-prompt-button">保存</button>
        <button id="bam-btn-reset-mood" class="bam-prompt-button">恢复默认</button>
      </div><div id="bam-mood-save-tip" class="bam-prompt-hint" role="status">修改后保存生效；导入和导出包含补充提示词与完整情绪配置。</div>`;
    container.innerHTML = html;
  }

  _updatePromptPreview() {
    const doc = this._getMainDocument();
    const prompt = buildPrompt({ supplement: this._promptSupplementDraft, groups: this._moodConfigDraft });
    const preview = doc.getElementById('bam-protocol-preview');
    if (preview) preview.value = prompt;
    const count = doc.getElementById('bam-prompt-length');
    if (count) count.textContent = prompt.length + ' 字符';
  }

  _bindMoodConfigEvents() {
    const tab = this._getMainDocument().getElementById('bam-tab-mood');
    if (!tab || this._boundMoodTab === tab) return;
    this._boundMoodTab = tab;
    tab.addEventListener('input', event => {
      if (event.target.id === 'bam-prompt-supplement') {
        this._promptSupplementDraft = event.target.value;
        this._moodConfigDirty = true;
        this._updatePromptPreview();
      }
      const picker = event.target.closest('.bam-mood-color-picker');
      if (picker) {
        this._moodConfigDraft[Number(picker.dataset.groupIndex)].color = picker.value;
        picker.closest('.bam-mood-group').querySelector('.bam-mood-color-dot').style.background = picker.value;
        this._moodConfigDirty = true;
      }
    });
    tab.addEventListener('click', async event => {
      const remove = event.target.closest('.bam-mood-word-delete');
      const add = event.target.closest('.bam-mood-word-add');
      if (remove) {
        const group = this._moodConfigDraft[Number(remove.dataset.groupIndex)];
        if (group.words.length === 1) { alert('每个分类至少保留一个参考词'); return; }
        group.words.splice(Number(remove.dataset.wordIndex), 1);
      } else if (add) {
        const word = prompt('请输入简短的情绪词：')?.trim();
        if (!word) return;
        if (/[|\r\n]/.test(word)) { alert('情绪词不能包含分隔符或换行'); return; }
        if (this._moodConfigDraft.some(group => group.words.includes(word))) { alert('这个词已属于一个情绪分组'); return; }
        this._moodConfigDraft[Number(add.dataset.groupIndex)].words.push(word);
      } else if (event.target.closest('#bam-btn-reset-mood')) {
        if (!confirm('恢复默认情绪词并清空补充提示词？保存后生效。')) return;
        this._promptSupplementDraft = '';
        this._moodConfigDraft = DEFAULT_MOOD_GROUPS.map(group => ({ ...group, words: [...group.words] }));
      } else if (event.target.closest('#bam-btn-save-mood')) {
        await this._saveMoodConfig(); return;
      } else return;
      this._moodConfigDirty = true;
      this._renderMoodConfigContent();
    });
  }

  async _saveMoodConfig() {
    try {
      await this.db.savePromptSettings({ supplement: this._promptSupplementDraft, groups: this._moodConfigDraft });
      await this.onPromptChanged();
      this._moodConfigDirty = false;
      const tip = this._getMainDocument().getElementById('bam-mood-save-tip');
      if (tip) tip.textContent = '已保存；启用时将使用上方的注入模板。';
      if (this._expandedMoodName) await this._renderMoodPanel(this._expandedMoodName);
    } catch (error) {
      this.onError(error);
      alert('保存失败：' + error.message);
    }
  }
}


export { AvatarManagerPanel };
