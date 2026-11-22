import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { AvatarDB } from "../src/storage.js?v=2.6.1";
import { STYLE_DEFAULTS } from "../src/config.js?v=2.6.1";
import { createExtension } from "../src/extension.js?v=2.6.1";
import { AvatarSync, GlobalStyleSync } from "../src/sync.js?v=2.6.1";

import { AVATAR_POOL_SCOPE, getCurrentCharId } from "../src/context.js?v=2.6.1";
import { BUILTIN_PORTRAITS, groupedAvatarPool, pickPoolAvatar } from "../src/avatar-pool.js?v=2.6.1";

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

test('the avatar pool is keyed by card and speaker; explicit and mood images take priority', async () => {
  const f = await fixture();
  try {
    const { assets } = f.app;
    const card = getCurrentCharId();
    const file = new Blob(['uploaded portrait'], { type: 'image/png' });
    await f.db.add(AVATAR_POOL_SCOPE, 'custom', file, { fileName: '自选.png', poolGroup: 'simple' });
    await f.app.refresh();
    const otherCard = card + 'b';
    const pool = (await groupedAvatarPool(f.db)).find(group => group.id === 'simple').items;
    assert.deepEqual(['simple','anime','ghibli','jrpg','real'].map(group => BUILTIN_PORTRAITS.filter(item => item.group === group).length), [10,50,20,10,0]);
    const names = Array.from({length:300}, (_,i) => '人物' + i);
    assert.ok(names.some(name => pickPoolAvatar(pool, card, name).id !== pickPoolAvatar(pool, otherCard, name).id));
    const name = names.find(name => pickPoolAvatar(pool, card, name).uploadKey === 'custom');
    assert.ok(name, 'uploaded entries participate in automatic allocation');
    const auto = await assets.resolve(name, '平静');
    assert.equal(auto.avatar, await f.db.getBlobUrl(AVATAR_POOL_SCOPE, 'custom'));
    assert.equal(pickPoolAvatar([...pool].reverse(), card, name).id, auto.poolId);
    assert.equal((await assets.resolve(name, '开心')).avatar, auto.avatar);
    await f.db.add('_global_', name, file);
    await f.app.refresh();
    assert.equal((await assets.resolve(name, '平静')).avatar, await f.db.getBlobUrl('_global_', name));
    await f.db.add(card, name, file);
    await f.db.addMoodAvatar(card, name, 'mood-calm', file);
    await f.app.refresh();
    assert.equal((await assets.resolve(name, '平静')).avatar, await f.db.getMoodAvatarBlobUrl(card, name, 'mood-calm'));
    assert.equal((await assets.resolve(name, '开心')).avatar, await f.db.getBlobUrl(card, name));
  } finally { await f.close(); }
});

test('automatic portraits follow current simple-group membership, including moves, renames and empty groups', async () => {
  const f = await fixture();
  try {
    const moveSimpleToAnime = Object.fromEntries(BUILTIN_PORTRAITS.filter(item => item.group === 'simple')
      .map(item => ['item:' + item.id, 'anime']));
    await f.db.editPoolLayout(() => ({...moveSimpleToAnime, 'item:anime01.webp':'simple', 'group:simple':{name:'默认', order:3}}));
    await f.app.refresh();
    assert.equal((await f.app.assets.resolve('甲', '平静')).poolId, 'anime01.webp');
    await f.db.editPoolLayout(() => ({'item:anime01.webp':'anime'}));
    await f.app.refresh();
    assert.equal((await f.app.assets.resolve('甲', '平静')).avatar, null);
    await f.db.editPoolLayout(() => ({'item:s01.png':'simple', 'group:simple':false}));
    await f.app.refresh();
    assert.equal((await f.app.assets.resolve('甲', '平静')).avatar, null);
  } finally { await f.close(); }
});

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

test('history cache restores the open settings and draft, and a later permanent unload still disposes', async () => {
  const f = await fixture();
  try {
    const win = f.dom.window;
    const doc = win.document;
    const manager = await f.app.openManager();
    await manager._switchTab('mood');
    const editor = doc.getElementById('bam-prompt-template');
    const prompt = f.prompts.get(PROMPT_ID).text;
    editor.value = '尚未保存的提示词';
    editor.dispatchEvent(new win.Event('input', { bubbles: true }));
    for (let visit = 0; visit < 2; visit++) {
      win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: true }));
      win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
      await tick();
      assert.equal(doc.querySelectorAll('.bd-settings').length, 1);
      assert.equal(doc.getElementById('bam-prompt-template'), editor);
      assert.equal(editor.value, '尚未保存的提示词');
      assert.equal(f.prompts.get(PROMPT_ID).text, prompt);
    }
    await manager._saveMoodConfig();
    assert.equal(f.prompts.get(PROMPT_ID).text, editor.value);
    win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: false }));
    await tick();
    assert.equal(doc.querySelector('.bd-settings'), null);
    assert.equal(doc.getElementById('bam-panel'), null);
    assert.equal(f.prompts.get(PROMPT_ID).text, '');
  } finally { await f.close(); }
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
    input.value = '20'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles:true })); await tick();
    input.value = '21'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles:true })); await tick();
    assert.equal(doc.querySelector('.mes_text').style.getPropertyValue('--bd-dialogue-size'), '19px');
    assert.equal(doc.querySelector('.dc-msg'), initialBubble);
    assert.equal(fontSyncs, 0);
    manager.close(); await tick();
    assert.equal(f.app.assets.settings.style_dialogueFontSize, STYLE_DEFAULTS.style_dialogueFontSize);
    assert.equal(doc.querySelector('.mes_text').style.getPropertyValue('--bd-dialogue-size'), '15px');
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
    input.value = '20'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles:true })); await tick();
    await manager._saveCurrentStyleSettings(); manager.close(); await tick();
    assert.equal(await f.db.getConfig('style_narrationFontSize'), 20);
    assert.equal(await f.db.getConfig('style_dialogueFontSize'), 18);
    assert.equal(f.dom.window.document.querySelector('.mes_text').style.getPropertyValue('--bd-dialogue-size'), '18px');
  } finally { await f.close(); }
});

test('legacy size settings use the same reading size in chat, preview and exported styles', async () => {
  const f = await fixture();
  try {
    await f.db.setConfig('style_dialogueFontSize', 16);
    await f.app.refresh();
    assert.equal(f.app.assets.settings.style_narrationFontSize, 18);
    await f.db.setConfig('style_narrationFontSize', 17);
    await f.db.setConfig('style_dialogueFontSize', 17);
    await f.app.refresh();
    const manager = await f.app.openManager(); await manager._switchTab('style');
    const doc = f.dom.window.document;
    for (const root of [doc.querySelector('.mes_text'), doc.getElementById('bam-reading-sample')]) {
      assert.equal(root.style.getPropertyValue('--bd-dialogue-size'), '15px');
    }
    assert.equal((await f.db.exportStyleSettings()).settings.style_dialogueFontSize, 15);
  } finally { await f.close(); }
});

test('palette and font choices preserve saved geometry, preview in place and round-trip through style backup', async () => {
  const f = await fixture();
  try {
    await f.db.setConfig('style_avatarSize', 100);
    await f.db.setConfig('style_narrationLineHeight', 2.15);
    await f.db.setConfig('style_narrationFontSize', 17);
    await f.app.refresh();
    const manager = await f.app.openManager(); await manager._switchTab('style');
    const doc = f.dom.window.document;
    const root = doc.querySelector('.mes_text');
    const bubble = root.querySelector('.dc-msg');
    doc.querySelector('input[name="bam-palette"][value="parchment"]').click();
    doc.querySelector('input[name="bam-reading-font"][value="BD LXGW WenKai"]').click();
    assert.equal(root.style.getPropertyValue('--bd-paper'), '#EFE2C4');
    assert.match(root.style.getPropertyValue('--bd-dialogue-font'), /BD LXGW WenKai/);
    assert.equal(root.style.getPropertyValue('--bd-narration-size'), '17px');
    assert.equal(root.style.getPropertyValue('--bd-avatar-size'), '100px');
    assert.equal(root.querySelector('.dc-msg'), bubble);
    manager.close(); await tick();
    assert.equal(root.style.getPropertyValue('--bd-paper'), '#2C2C2C');
    await f.app.openManager(); await manager._switchTab('style');
    doc.querySelector('input[name="bam-palette"][value="light"]').click();
    doc.querySelector('input[name="bam-reading-font"][value="BD Noto Serif SC"]').click();
    await manager._saveCurrentStyleSettings();
    const backup = await f.db.exportStyleSettings();
    assert.equal(backup.settings.style_textColorMode, 'light');
    assert.equal(backup.settings.style_nameFontFamily, 'BD Noto Serif SC');
    await f.db.setConfig('style_textColorMode', 'dark');
    await f.db.importFromFile(new Blob([JSON.stringify(backup)]), '_global_');
    assert.equal(await f.db.getConfig('style_textColorMode'), 'light');
    assert.equal(await f.db.getConfig('style_narrationLineHeight'), 2.15);
    assert.equal(await f.db.getConfig('style_avatarSize'), 100);
    await manager._loadStyleSettings();
    await manager._resetStyleDefaults();
    assert.equal(root.style.getPropertyValue('--bd-narration-line-height'), '1.85');
    assert.equal(root.style.getPropertyValue('--bd-narration-font'), '"SimHei", "Heiti SC", "STHeiti", "WenQuanYi Zen Hei", "Microsoft YaHei", sans-serif');
    assert.equal(await f.db.getConfig('style_narrationLineHeight'), 2.15, 'reset is a preview until saved');
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
