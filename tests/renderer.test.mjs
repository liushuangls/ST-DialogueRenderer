import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import showdown from 'showdown';
import { decorateMessage } from "../src/dom-renderer.js?v=2.1.1";
import { STYLE_DEFAULTS } from "../src/config.js?v=2.1.1";
import { DialogueController } from "../src/controller.js?v=2.1.1";
import { recentAiMessageIds, readSettings } from "../src/settings.js?v=2.1.1";

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
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const raw = '@say:测试用户|平静|**说出口的话**\n@think:测试用户|欲言又止|未说出口的话';
const contextFor = chat => ({ chat, characterId: 0, chatId: 'one', extensionSettings: {}, eventTypes: {}, eventSource: { on() {}, removeListener() {} } });

test('counting is by AI replies even with consecutive replies and tool/system/user messages', () => {
  const chat = [{}, { is_user: true }, {}, {}, { is_system: true }, { role: 'tool' }, {}, { extra: { type: 'narrator' } }];
  assert.deepEqual([...recentAiMessageIds(chat, 3)], [6, 3, 2]);
  assert.deepEqual(readSettings(), { enabled: true, recentAiCount: 3 });
  assert.throws(() => readSettings({ recentAiCount: 0 }), /1–100/);
  assert.throws(() => readSettings({ recentAiCount: 2.5 }), /1–100/);
});

test('explicit speech/thought types preserve rich text, avatars and exact DOM restoration', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, '# 标题\n\n开头\n' + raw + '\n结尾');
  const before = content.innerHTML; const paragraph = content.querySelector('p');
  const view = decorateMessage(content, f.assets); await tick();
  assert.equal(content.querySelectorAll('.dc-msg').length, 2);
  assert.equal(content.querySelector('[data-thought="0"] strong').textContent, '说出口的话');
  assert.equal(content.querySelector('[data-thought="1"] .dc-msg-text-content').textContent, '未说出口的话');
  assert.equal(content.querySelector('[data-mood-group="mood-calm"] img').src, 'https://example.test/calm.png');
  assert.equal(content.querySelector('[data-mood-group=""] img').src, 'https://example.test/base.png');
  assert.equal(content.querySelector('[data-mood-group=""] .dc-msg-mood').textContent, '欲言又止');
  assert.ok(content.querySelector('h1').classList.contains('bd-narration'));
  assert.equal(content.querySelectorAll('iframe').length, 0);
  view.dispose();
  assert.equal(content.innerHTML, before); assert.equal(content.querySelector('p'), paragraph);
  assert.equal(content.hasAttribute('style'), false); assert.equal(content.hasAttribute('data-bd-color-mode'), false);
  f.dom.window.close();
});

test('Markdown italics do not change speech type and body punctuation remains literal', () => {
  const f = fixture();
  const content = addMessage(f.document, 0, '@say:Alice|平静|_这句话说出来了_\n@think:Alice|疑惑|请按 [Enter]，也可以选 A | B。');
  const view = decorateMessage(content, f.assets);
  assert.equal(content.querySelectorAll('[data-thought="0"]').length, 1);
  assert.equal(content.querySelector('[data-thought="0"] em').textContent, '这句话说出来了');
  assert.equal(content.querySelector('[data-thought="1"] .dc-msg-text-content').textContent, '请按 [Enter]，也可以选 A | B。');
  view.dispose(); f.dom.window.close();
});

test('code examples and embedded frontend nodes are not claimed or restyled', () => {
  const f = fixture(); const content = addMessage(f.document, 0, '```text\n@say:A|平静|代码示例\n```\n\n' + raw);
  const iframe = f.document.createElement('iframe'); content.append(iframe);
  const details = f.document.createElement('details'); details.innerHTML = '<p>@say:A|平静|总结</p>'; content.append(details);
  const pre = content.querySelector('pre');
  const view = decorateMessage(content, f.assets);
  assert.equal(view.count, 2); assert.deepEqual(view.diagnostics, []);
  assert.equal(content.querySelector('iframe'), iframe); assert.equal(content.querySelector('pre'), pre);
  assert.equal(content.querySelector('details'), details);
  view.dispose();
  content.innerHTML = converter.makeHtml('```text\n@say:A|平静|代码示例\n```');
  const before = content.outerHTML;
  const codeOnly = decorateMessage(content, f.assets);
  assert.equal(content.outerHTML, before); assert.equal(codeOnly.count, 0);
  f.dom.window.close();
});

test('malformed completed markers report reasons without losing text; streaming tails defer errors', () => {
  const f = fixture(); const content = addMessage(f.document, 0, '@say:Alice||这句缺少情绪');
  const before = content.outerHTML;
  assert.match(decorateMessage(content, f.assets).diagnostics[0].reason, /情绪不能为空/);
  assert.equal(content.outerHTML, before);
  content.innerHTML = converter.makeHtml('@say:Alice|');
  assert.deepEqual(decorateMessage(content, f.assets, { streaming: true }).diagnostics, []);
  assert.equal(decorateMessage(content, f.assets).diagnostics.length, 1);
  content.innerHTML = converter.makeHtml('@say:Alice|\n@say:Alice|');
  assert.equal(decorateMessage(content, f.assets, { streaming: true }).diagnostics.length, 1, 'only the final occurrence is incomplete');
  f.dom.window.close();
});

test('character colors are scoped variables so changing modes never leaves inline text colors', async () => {
  const f = fixture(); f.assets.settings.style_textColorMode = 'character';
  f.assets.resolve = async () => ({ color: '#ff0000' });
  const content = addMessage(f.document, 0, raw); const view = decorateMessage(content, f.assets); await tick();
  assert.equal(content.dataset.bdColorMode, 'character');
  assert.equal(content.querySelector('.dc-msg').style.getPropertyValue('--bd-character-color'), '#ff0000');
  view.updateStyles({ ...STYLE_DEFAULTS, style_textColorMode: 'global', style_globalTextColor: '#000000' });
  assert.equal(content.dataset.bdColorMode, 'global');
  assert.equal(content.style.getPropertyValue('--bd-color'), '#000000');
  assert.equal(content.querySelector('.dc-msg-text').style.color, '');
  view.updateStyles({ ...STYLE_DEFAULTS, style_textColorMode: 'character' });
  assert.equal(content.dataset.bdColorMode, 'character');
  view.dispose(); f.dom.window.close();
});

test('late avatar completion and pre-aborted render cannot mutate a released message', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, raw);
  let resolve; const pending = new Promise(done => { resolve = done; }); f.assets.resolve = () => pending;
  const before = content.innerHTML; const view = decorateMessage(content, f.assets); view.dispose();
  resolve({ avatar: 'https://example.test/late.png' }); await tick();
  assert.equal(content.innerHTML, before);
  const abort = new f.dom.window.AbortController(); abort.abort();
  decorateMessage(content, f.assets, { signal: abort.signal });
  assert.equal(content.innerHTML, before); assert.equal(content.className, 'mes_text');
  f.dom.window.close();
});

test('a decoration failure restores earlier patches before propagating the error', () => {
  const f = fixture(); const content = addMessage(f.document, 0, '@say:A|平静|第一句\n\n@think:A|疑惑|第二句');
  const before = content.outerHTML;
  f.assets.getMood = mood => { if (mood === '疑惑') throw new Error('资源状态错误'); return null; };
  assert.throws(() => decorateMessage(content, f.assets), /资源状态错误/);
  assert.equal(content.outerHTML, before);
  f.dom.window.close();
});

test('ordinary Markdown needs no container protocol and cleanup preserves other style changes', () => {
  const f = fixture();
  const content = addMessage(f.document, 0, '@say:A|平静|台词\n\n正文 `代码`\n\n| 表头 |\n| --- |\n| 内容 |');
  const before = content.innerHTML; const view = decorateMessage(content, f.assets);
  assert.equal(view.count, 1); assert.ok(content.querySelector('table').classList.contains('bd-narration'));
  assert.ok(content.querySelector('p code').parentElement.classList.contains('bd-narration'));
  content.style.setProperty('background-color', 'red'); view.dispose();
  assert.equal(content.innerHTML, before); assert.equal(content.style.backgroundColor, 'red');
  f.dom.window.close();
});

test('static lifecycle restores expired messages and handles edits without observing metadata', async () => {
  const f = fixture(); const chat = Array.from({ length: 6 }, (_, i) => ({ mes: '@say:A|平静|回复' + i }));
  const original = chat.map((message, id) => addMessage(f.document, id, message.mes).innerHTML);
  const newestRow = f.document.querySelector('.mes[mesid="5"]');
  const counter = f.document.createElement('span'); counter.className = 'mes_timer'; counter.textContent = '0s'; newestRow.prepend(counter);
  let resolves = 0; f.assets.resolve = async () => { resolves++; return {}; };
  const context = contextFor(chat); const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document });
  controller.start(); await tick();
  assert.deepEqual([...controller.active.keys()], [5, 4, 3]);
  const first = resolves; const bubble = newestRow.querySelector('.dc-msg');
  counter.textContent = '1s'; await tick();
  assert.equal(resolves, first); assert.equal(newestRow.querySelector('.dc-msg'), bubble);
  chat.push({ mes: '@say:A|平静|新回复' }); addMessage(f.document, 6, chat[6].mes); await tick();
  assert.deepEqual(new Set(controller.active.keys()), new Set([6, 5, 4]));
  assert.equal(f.document.querySelector('.mes[mesid="3"] .mes_text').innerHTML, original[3]);
  const newest = f.document.querySelector('.mes[mesid="6"] .mes_text');
  chat[6].mes = '@think:A|强作镇定|编辑后的内容'; newest.innerHTML = converter.makeHtml(chat[6].mes); await tick();
  assert.equal(newest.querySelector('.dc-msg-text-content').textContent, '编辑后的内容');
  controller.setSettings({ enabled: false, recentAiCount: 3 });
  assert.equal(f.document.querySelectorAll('.dc-msg').length, 0); assert.equal(newest.innerHTML, converter.makeHtml(chat[6].mes));
  controller.setSettings({ enabled: true, recentAiCount: 1 }); assert.deepEqual([...controller.active.keys()], [6]);
  controller.dispose(); assert.equal(f.document.querySelectorAll('.bd-content').length, 0);
  f.dom.window.close();
});

test('finishing a stream validates the pending tail even without a final DOM mutation', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, '@say:A|');
  const context = contextFor([{ mes: '@say:A|' }]); context.streamingProcessor = { messageId: 0, isFinished: false };
  let issues = [];
  const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document, onDiagnostics: value => { issues = value; } });
  controller.start(); await tick(); assert.deepEqual(issues, []);
  context.streamingProcessor.isFinished = true; controller.schedule(); await tick();
  assert.equal(issues.length, 1); assert.equal(issues[0].mesid, 0); assert.equal(content.textContent, '@say:A|');
  controller.dispose(); f.dom.window.close();
});

test('rewriting message HTML preserves dialogue styling and can still restore copied projections', async () => {
  const f = fixture();
  const source = '# 标题\n\n' + raw + '\n\n普通正文\n\n```html\n<div>独立前端</div>\n```';
  const content = addMessage(f.document, 0, source);
  const context = contextFor([{ mes: source }]);
  const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document });
  try {
    controller.start(); await tick();
    // HTML frontends may replace a code block by rewriting the complete message HTML.
    content.innerHTML = content.innerHTML.replace(/<pre>[\s\S]*?<\/pre>/, '<div class="external-view"><iframe title="独立前端"></iframe></div>');
    const external = content.querySelector('.external-view');
    const iframe = external.querySelector('iframe');
    await tick();
    assert.equal(content.classList.contains('bd-content'), true);
    assert.equal(content.querySelectorAll('.dc-msg').length, 2);
    assert.equal(content.querySelectorAll('.dc-msg .dc-msg').length, 0);
    assert.equal(content.style.getPropertyValue('--bd-avatar-size'), '52px');
    assert.equal(content.querySelector('strong').textContent, '说出口的话');
    assert.equal(content.querySelector('iframe'), iframe);
    const rendered = content.innerHTML; await tick();
    assert.equal(content.innerHTML, rendered, 'a rewrite must settle without repeated rendering');
    controller.setSettings({ enabled: false });
    assert.equal(content.querySelectorAll('.dc-msg,.bd-narration,[data-bd-owned],[data-bd-narration]').length, 0);
    assert.match(content.textContent, /@say:测试用户/);
    assert.equal(content.querySelector('.external-view'), external);
    assert.equal(content.querySelector('iframe'), iframe);
    assert.equal(context.chat[0].mes, source);
    assert.equal(content.hasAttribute('style'), false);
  } finally { controller.dispose(); f.dom.window.close(); }
});

test('a copied message root is restored before being decorated again', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, '# 标题\n\n' + raw);
  const before = content.outerHTML;
  const context = contextFor([{ mes: raw }]);
  const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document });
  try {
    controller.start(); await tick();
    const replacement = content.cloneNode(true); content.replaceWith(replacement); await tick();
    assert.equal(controller.active.get(0)?.content, replacement);
    assert.equal(replacement.querySelectorAll('.dc-msg').length, 2);
    controller.setSettings({ enabled: false });
    assert.equal(replacement.outerHTML, before);
  } finally { controller.dispose(); f.dom.window.close(); }
});

test('ChatSurface content abort and unmount release all owned views', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, raw); const before = content.innerHTML;
  const context = contextFor([{ mes: raw }]); let participant;
  const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document,
    chatSurface: { isManagedOwnershipRequired: () => true, protocolVersion: 1,
      registerParticipant(value) { participant = value; return { fault(error) { throw error; } }; } } });
  controller.start(); assert.equal(controller.observer, undefined);
  const abort = new f.dom.window.AbortController();
  const cleanup = participant.didCommitContent({ mesid: 0, content, signal: abort.signal });
  assert.equal(typeof cleanup, 'function'); await tick(); assert.equal(content.querySelectorAll('.dc-msg').length, 2);
  abort.abort(); cleanup(); assert.equal(content.innerHTML, before); assert.equal(controller.mounted.size, 0);
  controller.dispose(); f.dom.window.close();
});

test('managed asynchronous decoration failures notify the ChatSurface owner', async () => {
  const f = fixture(); const content = addMessage(f.document, 0, raw); const before = content.outerHTML;
  const context = contextFor([{ mes: raw }]); let participant; let fault; let reported;
  f.assets.getMood = () => { throw new Error('资源状态错误'); };
  const controller = new DialogueController({ getContext: () => context, assets: f.assets, document: f.document,
    onError: error => { reported = error; },
    chatSurface: { isManagedOwnershipRequired: () => true, protocolVersion: 1,
      registerParticipant(value) { participant = value; return { fault(error) { fault = error; } }; } } });
  controller.start();
  const abort = new f.dom.window.AbortController();
  const cleanup = participant.didCommitContent({ mesid: 0, content, signal: abort.signal });
  await tick();
  assert.match(reported.message, /资源状态错误/); assert.equal(fault, reported); assert.equal(content.outerHTML, before);
  abort.abort(); cleanup(); controller.dispose(); f.dom.window.close();
});
