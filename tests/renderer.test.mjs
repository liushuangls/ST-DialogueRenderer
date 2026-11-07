import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import showdown from 'showdown';
import { decorateMessage } from '../src/dom-renderer.js';
import { STYLE_DEFAULTS } from '../src/avatar-manager.js';
import { DialogueController } from '../src/controller.js';
import { recentAiMessageIds, readSettings, parseBubbleLine } from '../src/settings.js';

const converter = new showdown.Converter({ simpleLineBreaks: true, tables: true });
function fixture() {
  const dom = new JSDOM('<!doctype html><div id="chat"></div>', { pretendToBeVisual: true, url: 'https://example.test/' });
  const assets = { settings: { ...STYLE_DEFAULTS }, cache: new Map(),
    getMood: value => value === '平静' ? { id: 'mood-calm', color: '#22c55e' } : null,
    resolve: async (_, mood) => ({ avatar: mood === '平静' ? 'https://example.test/calm.png' : 'https://example.test/base.png' }),
    onError: error => { throw error; } };
  return { dom, document: dom.window.document, assets };
}
function addMessage(document, id, text) {
  const mes = document.createElement('div'); mes.className = 'mes'; mes.setAttribute('mesid', id);
  const content = document.createElement('div'); content.className = 'mes_text';
  content.innerHTML = converter.makeHtml(text); mes.append(content); document.getElementById('chat').append(mes);
  return content;
}
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 45)); };
const raw = '@bubble:测试用户|平静|[**说出口的话**]\n@bubble:测试用户|欲言又止|[*未说出口的话*]';

test('counting is by AI replies even with consecutive replies and tool/system/user messages', () => {
  const chat = [{}, { is_user: true }, {}, {}, { is_system: true }, { role: 'tool' }, {}, { extra: { type: 'narrator' } }];
  assert.deepEqual([...recentAiMessageIds(chat, 3)], [6, 3, 2]);
  assert.deepEqual(readSettings(), { enabled: true, recentAiCount: 3 });
  assert.throws(() => readSettings({ recentAiCount: 0 }), /1–100/);
  assert.throws(() => readSettings({ recentAiCount: 2.5 }), /1–100/);
  assert.equal(parseBubbleLine('@bubble:A|强作镇定|[台词]').mood, '强作镇定');
  assert.equal(parseBubbleLine('@bubble:A||[台词]'), null);
});

test('host-formatted bold and thought markers survive; free moods use base avatar and teardown restores exact DOM', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, '# 标题\n\n开头\n' + raw + '\n结尾');
  const before = content.innerHTML;
  const originalParagraph = content.querySelector('p');
  const view = decorateMessage(content, f.assets);
  await tick();
  assert.equal(content.querySelectorAll('.dc-msg').length, 2);
  assert.equal(content.querySelector('.dc-msg-text-content strong').textContent, '说出口的话');
  assert.equal(content.querySelector('[data-thought="1"] .dc-msg-text-content').textContent, '未说出口的话');
  assert.equal(content.querySelector('[data-mood-group="mood-calm"] img').src, 'https://example.test/calm.png');
  assert.equal(content.querySelector('[data-mood-group=""] img').src, 'https://example.test/base.png');
  assert.equal(content.querySelector('[data-mood-group=""] .dc-msg-mood').textContent, '欲言又止');
  assert.ok(content.querySelector('h1').classList.contains('bd-narration'));
  assert.equal(content.querySelectorAll('iframe').length, 0);
  view.dispose();
  assert.equal(content.innerHTML, before);
  assert.equal(content.querySelector('p'), originalParagraph);
  assert.equal(content.hasAttribute('style'), false);
  f.dom.window.close();
});

test('code examples and embedded frontend nodes are not claimed, moved or replaced', () => {
  const f = fixture(); const content = addMessage(f.document, 0, '```text\n@bubble:A|平静|[代码示例]\n```\n\n' + raw);
  const iframe = f.document.createElement('iframe'); content.append(iframe);
  const details = f.document.createElement('details'); details.innerHTML = '<p>@bubble:A|平静|[总结]</p>'; content.append(details);
  const pre = content.querySelector('pre');
  const view = decorateMessage(content, f.assets);
  assert.equal(content.querySelectorAll('.dc-msg').length, 2);
  assert.equal(content.querySelector('iframe'), iframe);
  assert.equal(content.querySelector('pre'), pre);
  assert.equal(content.querySelector('details'), details);
  view.dispose(); f.dom.window.close();
});

test('late avatar completion and pre-aborted render cannot mutate a released message', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, raw);
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  f.assets.resolve = () => pending;
  const before = content.innerHTML;
  const view = decorateMessage(content, f.assets); view.dispose();
  resolve({ avatar: 'https://example.test/late.png' }); await tick();
  assert.equal(content.innerHTML, before);
  const abort = new f.dom.window.AbortController(); abort.abort();
  decorateMessage(content, f.assets, { signal: abort.signal });
  assert.equal(content.innerHTML, before);
  assert.equal(content.className, 'mes_text');
  f.dom.window.close();
});

test('encoded content delimiters are hidden only in the view; code and table narration survive restoration', () => {
  const f = fixture();
  const content = addMessage(f.document, 0, '&lt;content&gt;\n@bubble:A|平静|[台词]\n&lt;/content&gt;\n\n正文 `代码`\n\n| 表头 |\n| --- |\n| 内容 |');
  const before = content.innerHTML;
  const view = decorateMessage(content, f.assets);
  assert.equal(content.querySelectorAll('.dc-msg').length, 1);
  assert.equal(content.textContent.includes('<content>'), false);
  assert.ok(content.querySelector('table').classList.contains('bd-narration'));
  assert.ok(content.querySelector('p code').parentElement.classList.contains('bd-narration'));
  content.style.setProperty('background-color', 'red');
  view.dispose();
  assert.equal(content.innerHTML, before);
  assert.equal(content.style.backgroundColor, 'red', 'another extension’s style change must survive cleanup');
  f.dom.window.close();
});

test('native static lifecycle restores expired messages, handles edits, and avoids self-triggered renders', async () => {
  const f = fixture();
  const chat = Array.from({ length: 6 }, (_, i) => ({ mes: '@bubble:A|平静|[回复' + i + ']' }));
  const original = chat.map((message, id) => addMessage(f.document, id, message.mes).innerHTML);
  const context = { chat, characterId: 0, chatId: 'one', extensionSettings: {}, eventTypes: {}, eventSource: { on() {}, removeListener() {} } };
  let resolves = 0;
  f.assets.resolve = async () => { resolves++; return {}; };
  const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document });
  controller.start(); await tick();
  assert.deepEqual([...controller.active.keys()], [5, 4, 3]);
  const first = resolves; await tick(); assert.equal(resolves, first);
  chat.push({ mes: '@bubble:A|平静|[新回复]' }); addMessage(f.document, 6, chat[6].mes); await tick();
  assert.deepEqual(new Set(controller.active.keys()), new Set([6, 5, 4]));
  assert.equal(f.document.querySelector('.mes[mesid="3"] .mes_text').innerHTML, original[3]);
  const newest = f.document.querySelector('.mes[mesid="6"] .mes_text');
  chat[6].mes = '@bubble:A|强作镇定|[编辑后的内容]'; newest.innerHTML = converter.makeHtml(chat[6].mes); await tick();
  assert.match(newest.querySelector('.dc-msg-text-content').textContent, /编辑后的内容/);
  controller.setSettings({ enabled: false, recentAiCount: 3 });
  assert.equal(f.document.querySelectorAll('.dc-msg').length, 0);
  assert.equal(newest.innerHTML, converter.makeHtml(chat[6].mes));
  controller.setSettings({ enabled: true, recentAiCount: 1 });
  assert.deepEqual([...controller.active.keys()], [6]);
  controller.dispose(); assert.equal(f.document.querySelectorAll('.bd-content').length, 0);
  assert.equal(chat[6].mes, '@bubble:A|强作镇定|[编辑后的内容]');
  f.dom.window.close();
});

test('ChatSurface lifecycle has one owner and cleans up on content abort and unmount', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, raw); const before = content.innerHTML;
  const context = { chat: [{ mes: raw }], extensionSettings: {}, eventTypes: {}, eventSource: { on() {}, removeListener() {} } };
  let participant;
  const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document,
    chatSurface: { isManagedOwnershipRequired: () => true, protocolVersion: 1,
      registerParticipant(value) { participant = value; return { fault(error) { throw error; } }; } } });
  controller.start();
  assert.equal(controller.observer, undefined);
  const abort = new f.dom.window.AbortController();
  const cleanup = participant.didCommitContent({ mesid: 0, content, signal: abort.signal });
  assert.equal(typeof cleanup, 'function'); await tick();
  assert.equal(content.querySelectorAll('.dc-msg').length, 2);
  abort.abort(); cleanup();
  assert.equal(content.innerHTML, before);
  assert.equal(controller.mounted.size, 0);
  controller.dispose(); f.dom.window.close();
});
