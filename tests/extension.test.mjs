import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { AvatarDB } from '../src/storage.js?v=2.0.0';
import { STYLE_DEFAULTS } from '../src/config.js?v=2.0.0';
import { createExtension } from '../src/extension.js?v=2.0.0';

const PROMPT_ID = 'dialogue-renderer/protocol';
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
async function fixture() {
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
  const app = createExtension({ getContext: () => context, document: dom.window.document, db, syncEnabled: false });
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

test('prompt panel exposes a read-only complete protocol and saves supplemental text without changing it', async () => {
  const f = await fixture();
  try {
    const manager = await f.app.openManager(); await manager._switchTab('mood');
    const doc = f.dom.window.document;
    assert.equal(doc.getElementById('bam-protocol-preview').readOnly, true);
    assert.equal(doc.getElementById('bam-btn-export').style.display, '');
    const supplement = doc.getElementById('bam-prompt-supplement');
    supplement.value = '多用简洁自然的对话。'; supplement.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    const preview = doc.getElementById('bam-protocol-preview').value;
    assert.match(preview, /多用简洁自然的对话/); assert.match(preview, /@think:/);
    assert.equal(await f.db.getConfig('prompt_supplement'), null, 'preview must not save');
    await manager._saveMoodConfig();
    assert.equal(await f.db.getConfig('prompt_supplement'), '多用简洁自然的对话。');
    assert.equal(f.prompts.get(PROMPT_ID).text, preview);
  } finally { await f.close(); }
});
