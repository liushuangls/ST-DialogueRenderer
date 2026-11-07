import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { AvatarDB } from '../src/avatar-manager.js?v=1.0.3';
import { createExtension } from '../src/extension.js?v=1.0.3';

test('extension toggles prompt and rendering together, rejects legacy duplicates, retains avatar data', async () => {
  const dom = new JSDOM('<div id="extensions_settings2"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_text"><p>@bubble:A|平静|[已经经过显示正则的内容]</p></div></div></div>',
    { pretendToBeVisual: true, url: 'https://test.example/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage; globalThis.indexedDB = new IDBFactory();
  const events = new Map(); const prompts = new Map(); let saves = 0;
  const context = {
    chat: [{ mes: '<content>@bubble:A|平静|[原始内容]</content>' }], characterId: 0,
    characters: [{ avatar: 'card.png' }], name2: '测试卡', chatId: 'test', extensionSettings: {},
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
  let legacy = [];
  const app = createExtension({ getContext: () => context, getRegexScripts: () => legacy,
    document: dom.window.document, db, syncEnabled: false });
  try {
    app.start();
    for (const callback of events.get('ready')) await callback();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(prompts.get('bubble-dialogue-format-v8').position, 1);
    assert.match(prompts.get('bubble-dialogue-format-v8').text, /没有合适的词时允许使用简短的自由描述/);
    assert.equal(dom.window.document.querySelector('.dc-msg-text-content').textContent, '已经经过显示正则的内容');
    assert.equal(context.chat[0].mes, '<content>@bubble:A|平静|[原始内容]</content>');
    await db.add('_global_', 'A', new Blob(['image-bytes']));
    assert.match(await dom.window.BubbleAvatarV8.getAvatar('A', '_global_'), /^blob:/);
    await app.setSettings({ enabled: false });
    assert.equal(prompts.get('bubble-dialogue-format-v8').text, '');
    assert.equal(dom.window.document.querySelectorAll('.dc-msg').length, 0);
    assert.equal(await (await db.get('_global_', 'A')).imageBlob.text(), 'image-bytes');
    assert.equal(saves, 1);
    legacy = [{ scriptName: '旧正则', markdownOnly: true, disabled: false, replaceString: '<div id="dcRoot"></div>' }];
    await app.setSettings({ enabled: true });
    assert.equal(prompts.get('bubble-dialogue-format-v8').text, '');
    assert.equal(dom.window.document.querySelectorAll('.dc-msg').length, 0);
    assert.match(dom.window.document.querySelector('.bd-status').textContent, /旧正则/);
    legacy = [];
    await app.setSettings({ recentAiCount: 1 });
    assert.equal(dom.window.document.querySelectorAll('.dc-msg').length, 1);
    assert.match(prompts.get('bubble-dialogue-format-v8').text, /@bubble/);
  } finally {
    await app.dispose();
    assert.equal(dom.window.BubbleAvatarV8, undefined);
    assert.equal(prompts.get('bubble-dialogue-format-v8').text, '');
    assert.equal([...events.values()].reduce((count, callbacks) => count + callbacks.size, 0), 0);
    dom.window.close();
  }
});
