import { decorateMessage } from './dom-renderer.js?v=1.0.3';
import { readSettings, recentAiMessageIds, SETTINGS_KEY } from './settings.js?v=1.0.3';

export class DialogueController {
  constructor({ getContext, assets, document, ready = Promise.resolve(), onError = console.error, chatSurface }) {
    this.getContext = getContext;
    this.assets = assets;
    this.document = document;
    this.ready = ready;
    this.onError = onError;
    this.active = new Map();
    this.mounted = new Map();
    this.dirty = new Set();
    this.listeners = [];
    this.frame = null;
    this.chatKey = null;
    this.disposed = false;
    this.suspended = false;
    this.managed = chatSurface?.isManagedOwnershipRequired?.() === true;
    this.settings = readSettings(getContext().extensionSettings?.[SETTINGS_KEY]);
    // Registration must be synchronous, before the first managed projection.
    if (this.managed) this.registration = chatSurface.registerParticipant({
      id: 'dialogue-renderer/message-content',
      protocolVersion: chatSurface.protocolVersion,
      didCommitContent: ({ mesid, content, signal }) => {
        const lease = { content, signal };
        this.mounted.set(mesid, lease);
        this.ready.then(() => {
          if (!signal.aborted && this.mounted.get(mesid) === lease) this.schedule();
        }).catch(onError);
        return () => {
          if (this.mounted.get(mesid) !== lease) return;
          this.release(mesid);
          this.mounted.delete(mesid);
        };
      },
    });
  }

  start() {
    const { eventSource, eventTypes } = this.getContext();
    for (const name of ['APP_READY', 'CHAT_CHANGED', 'CHAT_LOADED', 'CHARACTER_MESSAGE_RENDERED',
      'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED',
      'GENERATION_ENDED', 'GENERATION_STOPPED']) {
      const event = eventTypes[name];
      if (!event) continue;
      const listener = () => this.ready.then(() => this.schedule()).catch(this.onError);
      eventSource.on(event, listener);
      this.listeners.push(() => eventSource.removeListener(event, listener));
    }
    if (!this.managed) {
      this.observer = new this.document.defaultView.MutationObserver(records => {
        for (const record of records) {
          const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (node?.closest('[data-bd-owned]')) continue;
          const message = node?.closest('.mes[mesid]');
          if (message) this.dirty.add(Number(message.getAttribute('mesid')));
        }
        this.schedule();
      });
      this.observe();
    }
    this.ready.then(() => this.schedule()).catch(this.onError);
  }

  observe() {
    const chat = this.document.getElementById('chat');
    if (chat && this.observer && this.settings.enabled && !this.suspended) {
      this.observer.observe(chat, { childList: true, subtree: true, characterData: true });
    }
  }

  mutate(callback) {
    // Our own replacements must never enqueue another formatting pass.
    this.observer?.disconnect();
    try { return callback(); } finally { if (!this.disposed) this.observe(); }
  }

  schedule() {
    if (this.disposed || this.frame !== null || (!this.settings.enabled && this.active.size === 0)) return;
    this.frame = this.document.defaultView.requestAnimationFrame(() => {
      this.frame = null;
      try { this.reconcile(); } catch (error) { this.onError(error); }
    });
  }

  release(id) {
    const entry = this.active.get(id);
    if (!entry) return;
    this.mutate(() => entry.view.dispose());
    this.active.delete(id);
  }

  reconcile() {
    if (this.disposed) return;
    const context = this.getContext();
    const key = JSON.stringify([context.characterId, context.groupId, context.getCurrentChatId?.() ?? context.chatId]);
    if (key !== this.chatKey) {
      for (const id of [...this.active.keys()]) this.release(id);
      this.assets.cache.clear();
      this.chatKey = key;
    }
    const selected = this.settings.enabled && !this.suspended
      ? recentAiMessageIds(context.chat || [], this.settings.recentAiCount) : new Set();
    for (const [id, entry] of this.active) {
      if (!selected.has(id) || !entry.content.isConnected || this.dirty.has(id)) this.release(id);
    }
    this.dirty.clear();
    for (const id of selected) {
      if (this.active.has(id)) continue;
      const lease = this.managed ? this.mounted.get(id) : null;
      const content = this.managed ? lease?.content
        : this.document.querySelector(`#chat > .mes[mesid="${id}"] .mes_text`);
      if (!content?.isConnected || lease?.signal.aborted) continue;
      // Avoid styling unrelated messages, tool output and third-party HTML frontends.
      const raw = String(context.chat[id]?.mes || '');
      if (!raw.includes('@bubble:') && !/<(?:content|now_plot|TXT|正文|response|gametext|geme|maincontent)>/i.test(raw)) continue;
      if (content.querySelector('[data-bd-owned]')) continue;
      const view = this.mutate(() => decorateMessage(content, this.assets, { signal: lease?.signal }));
      this.active.set(id, { content, view });
    }
  }

  setSettings(settings) {
    this.settings = readSettings(settings);
    this.observer?.disconnect();
    this.reconcile();
    this.observe();
  }

  suspend(value) {
    this.suspended = Boolean(value);
    this.observer?.disconnect();
    this.reconcile();
    this.observe();
  }

  refresh() {
    for (const id of [...this.active.keys()]) this.release(id);
    this.schedule();
  }

  previewStyles(settings) {
    this.assets.settings = { ...this.assets.settings, ...settings };
    for (const entry of this.active.values()) entry.view.updateStyles(this.assets.settings);
  }

  dispose() {
    this.disposed = true;
    if (this.frame !== null) this.document.defaultView.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer?.disconnect();
    for (const off of this.listeners) off();
    this.listeners = [];
    for (const id of [...this.active.keys()]) this.release(id);
    this.mounted.clear();
  }
}
