import { decorateMessage } from "./dom-renderer.js?v=2.1.2";
import { readSettings, recentAiMessageIds, SETTINGS_KEY } from "./settings.js?v=2.1.2";
import { isDialogueCandidate } from "./protocol.js?v=2.1.2";

export class DialogueController {
  constructor({ getContext, assets, document, ready = Promise.resolve(), onError = console.error, onDiagnostics = () => {}, chatSurface }) {
    this.getContext = getContext;
    this.assets = assets;
    this.document = document;
    this.ready = ready;
    this.onError = onError;
    this.onDiagnostics = onDiagnostics;
    this.diagnosticSignature = '';
    this.active = new Map();
    this.mounted = new Map();
    this.dirty = new Set();
    this.listeners = [];
    this.frame = null;
    this.chatKey = null;
    this.disposed = false;
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
        let relevant = false;
        for (const record of records) {
          const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (node?.closest('[data-bd-owned],pre,code,iframe,details,.mes_reasoning')) continue;
          const content = node?.closest('.mes_text');
          if (content) {
            const message = content.closest('.mes[mesid]');
            if (message) { this.dirty.add(Number(message.getAttribute('mesid'))); relevant = true; }
          } else if (record.type === 'childList') {
            const changedContent = [...record.addedNodes, ...record.removedNodes].some(child => child.nodeType === 1
              && (child.matches('.mes[mesid],.mes_text') || child.querySelector('.mes[mesid],.mes_text')));
            if (changedContent) {
              const message = node?.closest('.mes[mesid]');
              if (message) this.dirty.add(Number(message.getAttribute('mesid')));
              relevant = true;
            }
          }
        }
        if (relevant) this.schedule();
      });
      this.observe();
    }
    this.ready.then(() => this.schedule()).catch(this.onError);
  }

  observe() {
    const chat = this.document.getElementById('chat');
    if (chat && this.observer && this.settings.enabled) {
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
      try { this.reconcile(); } catch (error) {
        this.onError(error);
        this.registration?.fault(error);
      }
    });
  }

  release(id) {
    const entry = this.active.get(id);
    if (!entry) return;
    this.mutate(() => entry.view.dispose({ replacementRoot: this.contentFor(id) }));
    this.active.delete(id);
  }

  contentFor(id) {
    return this.managed ? this.mounted.get(id)?.content
      : this.document.querySelector(`#chat > .mes[mesid="${id}"] .mes_text`);
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
    const selected = this.settings.enabled
      ? recentAiMessageIds(context.chat || [], this.settings.recentAiCount) : new Set();
    const stream = context.streamingProcessor;
    const streamingId = stream && !stream.isFinished && !stream.isStopped ? stream.messageId : null;
    for (const [id, entry] of this.active) {
      const moved = !this.managed && Number(entry.content.closest('.mes[mesid]')?.getAttribute('mesid')) !== id;
      if (!selected.has(id) || !entry.content.isConnected || moved || this.dirty.has(id) || entry.streaming !== (id === streamingId)) this.release(id);
    }
    this.dirty.clear();
    for (const id of selected) {
      if (this.active.has(id)) continue;
      const lease = this.managed ? this.mounted.get(id) : null;
      const content = this.contentFor(id);
      if (!content?.isConnected || lease?.signal.aborted) continue;
      // Avoid styling unrelated messages, tool output and third-party HTML frontends.
      const raw = String(context.chat[id]?.mes || '');
      if (!raw.split('\n').some(isDialogueCandidate)) continue;
      if (content.querySelector('[data-bd-owned]')) continue;
      const streaming = id === streamingId;
      const view = this.mutate(() => decorateMessage(content, this.assets, { signal: lease?.signal, streaming }));
      this.active.set(id, { content, view, streaming });
    }
    const diagnostics = [...this.active].flatMap(([mesid, entry]) => entry.view.diagnostics.map(issue => ({ mesid, ...issue })));
    const signature = JSON.stringify(diagnostics);
    if (signature !== this.diagnosticSignature) {
      this.diagnosticSignature = signature;
      this.onDiagnostics(diagnostics);
    }
  }

  setSettings(settings) {
    this.settings = readSettings(settings);
    this.observer?.disconnect();
    this.reconcile();
    this.observe();
  }

  refresh() {
    // Resource sync must not collapse the message between frames and lose the
    // host's reading position. Content changes are handled separately by reconcile.
    for (const entry of this.active.values()) entry.view.updateAssets();
    this.schedule();
  }

  previewStyles(changes) {
    this.assets.setPreview(changes);
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
