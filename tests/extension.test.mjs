import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { AvatarDB } from "../src/storage.js?v=2.1.2";
import { STYLE_DEFAULTS } from "../src/config.js?v=2.1.2";
import { createExtension } from "../src/extension.js?v=2.1.2";
import { AvatarSync, GlobalStyleSync } from "../src/sync.js?v=2.1.2";

const PROMPT_ID = 'dialogue-renderer/protocol';
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
async function fixture({ syncEnabled = false } = {}) {
  const dom = new JSDOM('<div id="extensions_settings2"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"><p>@say:A|平静|已经经过显示正则的内容</p></div></div></div>',
    { pretendToBeVisual: true, url: 'https://test.example/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, indexedDB: new IDBFactory(), IDBKeyRange });
  const events = new Map(); const prompts = new Map(); let saves = 0;
  const context = {
    chat: [{ mes: '@say:A|平静|原始内容' }], characterId: 0,
    characters: [{ avatar: 'card.png' }], name1: '测试用户', name2: '测试卡', chatId: 'test', extensionSettings: {},
    eventTypes: { APP_READY: 'ready', CHAT_CHANGED: 'chat' },
    eventSource: {
      on(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
      removeListener(name, callback) { events.get(name)?.delete(callback); },
    },
    saveSettingsDebounced() { saves++; },
    setExtensionPrompt(key, text, position) { prompts.set(key, { text, position }); },
  };
  dom.window.SillyTavern = { getContext: () => context };
  const db = new AvatarDB();
  const app = createExtension({ getContext: () => context, document: dom.window.document, db, syncEnabled });
  app.start(); for (const callback of events.get('ready')) await callback(); await tick();
  return { dom, db, app, context, events, prompts, get saves() { return saves; },
    async close() { await app.dispose(); dom.window.close(); } };
}

test('extension toggles generated prompt and rendering together while preserving host data', async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.panel, undefined, 'manager must stay lazy until opened');
    assert.equal(f.prompts.get(PROMPT_ID).position, 1);
    assert.match(f.prompts.get(PROMPT_ID).text, /@think:/);
    assert.ok(f.prompts.get(PROMPT_ID).text.length < 600);
    assert.equal(f.dom.window.document.querySelector('.dc-msg-text-content').textContent, '已经经过显示正则的内容');
    assert.equal(f.context.chat[0].mes, '@say:A|平静|原始内容');
    await f.db.add('_global_', 'A', new Blob(['image-bytes']));
    await f.app.setSettings({ enabled: false });
    assert.equal(f.prompts.get(PROMPT_ID).text, '');
    assert.equal(f.dom.window.document.querySelectorAll('.dc-msg').length, 0);
    assert.equal(await (await f.db.get('_global_', 'A')).imageBlob.text(), 'image-bytes');
    assert.equal(f.saves, 1);
    await f.app.setSettings({ enabled: true, recentAiCount: 1 });
    assert.equal(f.dom.window.document.querySelectorAll('.dc-msg').length, 1);
    assert.match(f.prompts.get(PROMPT_ID).text, /@say:/);
  } finally {
    await f.app.dispose();
    assert.equal(f.prompts.get(PROMPT_ID).text, '');
    assert.equal([...f.events.values()].reduce((sum, callbacks) => sum + callbacks.size, 0), 0);
    f.dom.window.close();
  }
});

test('returning to the foreground or reconnecting syncs resources without rebuilding messages', async t => {
  let syncs = 0;
  t.mock.method(AvatarSync.prototype, 'refreshCurrentScope', async () => { syncs++; });
  t.mock.method(GlobalStyleSync.prototype, 'refresh', async () => {});
  const f = await fixture({ syncEnabled: true });
  try {
    const doc = f.dom.window.document;
    const content = doc.querySelector('.mes_text');
    const bubble = content.querySelector('.dc-msg');
    const body = content.querySelector('.dc-msg-text-content');
    const changes = [];
    const observer = new f.dom.window.MutationObserver(records => changes.push(...records));
    observer.observe(content, { childList: true, attributes: true, subtree: true });
    const initialSyncs = syncs;
    for (let i = 0; i < 3; i++) {
      Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'hidden' });
      doc.dispatchEvent(new f.dom.window.Event('visibilitychange')); await tick();
      assert.equal(syncs, initialSyncs + i);
      Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' });
      doc.dispatchEvent(new f.dom.window.Event('visibilitychange')); await tick();
      assert.equal(content.querySelector('.dc-msg'), bubble);
      assert.equal(content.querySelector('.dc-msg-text-content'), body);
      assert.equal(content.classList.contains('bd-content'), true);
    }
    f.dom.window.dispatchEvent(new f.dom.window.Event('online')); await tick();
    assert.equal(syncs, initialSyncs + 4);
    assert.equal(content.querySelector('.dc-msg'), bubble);
    assert.equal(changes.length, 0, 'unchanged resources must not mutate the chat DOM');
    observer.disconnect();
  } finally { await f.close(); }
});

test('closing unsaved preview restores saved styles without refreshing fonts for size changes', async () => {
  const f = await fixture();
  try {
    const manager = await f.app.openManager(); await manager._switchTab('style');
    const doc = f.dom.window.document;
    const initialBubble = doc.querySelector('.dc-msg');
    let fontSyncs = 0; const syncFonts = f.app.assets.syncFonts.bind(f.app.assets);
    f.app.assets.syncFonts = (...args) => { fontSyncs++; return syncFonts(...args); };
    const input = doc.getElementById('bam-range-dialogue-font');
    input.value = '20'; input.dispatchEvent(new f.dom.window.Event('input')); await tick();
    input.value = '21'; input.dispatchEvent(new f.dom.window.Event('input')); await tick();
    assert.equal(doc.querySelector('.mes_text').style.getPropertyValue('--bd-dialogue-size'), '21px');
    assert.equal(doc.querySelector('.dc-msg'), initialBubble);
    assert.equal(fontSyncs, 0);
    manager.close(); await tick();
    assert.equal(f.app.assets.settings.style_dialogueFontSize, STYLE_DEFAULTS.style_dialogueFontSize);
    assert.equal(doc.querySelector('.mes_text').style.getPropertyValue('--bd-dialogue-size'), '14.5px');
    assert.equal(await f.db.getConfig('style_dialogueFontSize'), null);
    assert.equal(doc.querySelector('.dc-msg'), initialBubble);
    assert.equal(fontSyncs, 0);
  } finally { await f.close(); }
});

test('saving styles commits the draft and closing restores the new saved baseline', async () => {
  const f = await fixture();
  try {
    const manager = await f.app.openManager(); await manager._switchTab('style');
    const input = f.dom.window.document.getElementById('bam-range-dialogue-font');
    input.value = '20'; input.dispatchEvent(new f.dom.window.Event('input')); await tick();
    await manager._saveCurrentStyleSettings(); manager.close(); await tick();
    assert.equal(await f.db.getConfig('style_dialogueFontSize'), 20);
    assert.equal(f.app.assets.settings.style_dialogueFontSize, 20);
    assert.equal(f.dom.window.document.querySelector('.mes_text').style.getPropertyValue('--bd-dialogue-size'), '20px');
  } finally { await f.close(); }
});

test('single prompt editor saves the exact template and preserves edits when mood words change', async () => {
  const f = await fixture();
  try {
    const manager = await f.app.openManager(); await manager._switchTab('mood');
    const doc = f.dom.window.document;
    const editor = doc.getElementById('bam-prompt-template');
    const initial = f.prompts.get(PROMPT_ID).text;
    assert.equal(editor.readOnly, false);
    assert.equal(editor.value, initial);
    assert.equal(doc.querySelectorAll('#bam-tab-mood textarea').length, 1);
    assert.equal(doc.getElementById('bam-btn-export').style.display, '');
    const custom = '  @say:姓名|情绪|正文\n用户角色用 {{user}}。多用简洁自然的对话。\n';
    editor.value = custom; editor.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    assert.equal(doc.getElementById('bam-prompt-length').textContent, custom.length + ' 字符');
    await manager._switchTab('style'); await manager._switchTab('mood');
    assert.equal(doc.getElementById('bam-prompt-template').value, custom);
    doc.querySelector('.bam-mood-word-delete').click();
    assert.equal(doc.getElementById('bam-prompt-template').value, custom, 'mood changes must preserve the edited template');
    assert.equal(await f.db.getConfig('prompt_template'), null, 'draft must not save');
    assert.equal(f.prompts.get(PROMPT_ID).text, initial, 'draft must not change injection');
    await manager._saveMoodConfig();
    assert.equal(await f.db.getConfig('prompt_template'), custom);
    assert.equal(f.prompts.get(PROMPT_ID).text, custom);
  } finally { await f.close(); }
});

test('closing discards unsaved prompt edits and restoring defaults takes effect only after saving', async () => {
  const f = await fixture();
  const previousConfirm = globalThis.confirm;
  try {
    const manager = await f.app.openManager(); await manager._switchTab('mood');
    const doc = f.dom.window.document;
    const initial = doc.getElementById('bam-prompt-template').value;
    const edit = text => {
      const input = doc.getElementById('bam-prompt-template');
      input.value = text; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    };
    const custom = '\n@say:姓名|情绪|正文\n简洁自然。\n';
    edit(custom); await manager._saveMoodConfig();
    edit('尚未保存的改动'); manager.close(); await tick();
    await f.app.openManager(); await manager._switchTab('mood');
    assert.equal(doc.getElementById('bam-prompt-template').value, custom);
    assert.equal(f.prompts.get(PROMPT_ID).text, custom);
    globalThis.confirm = () => true;
    doc.getElementById('bam-btn-reset-mood').click();
    assert.equal(doc.getElementById('bam-prompt-template').value, initial);
    assert.equal(f.prompts.get(PROMPT_ID).text, custom);
    await manager._saveMoodConfig();
    assert.equal(f.prompts.get(PROMPT_ID).text, initial);
  } finally {
    globalThis.confirm = previousConfirm;
    await f.close();
  }
});
