import { createExtension } from "../src/extension.js?v=2.1.0";
import { AvatarDB } from "../src/storage.js?v=2.1.0";
import { buildColorConfigKey } from "../src/context.js?v=2.1.0";

const output = document.getElementById('result');
const passes = [];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const events = new Map(); const prompts = new Map();
const context = {
  chat: [], characters: [{ avatar: 'demo.png' }], characterId: 0, name2: '测试卡', chatId: 'preview', extensionSettings: {},
  eventTypes: { APP_READY: 'ready', CHAT_CHANGED: 'chat', CHARACTER_MESSAGE_RENDERED: 'rendered' },
  eventSource: {
    on(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
    removeListener(name, callback) { events.get(name)?.delete(callback); },
  },
  saveSettingsDebounced() {},
  setExtensionPrompt(key, text) { prompts.set(key, text); },
};
window.SillyTavern = { getContext: () => context };
const db = new AvatarDB({ dbName: 'DialogueRenderer-browser-' + crypto.randomUUID() });
const app = createExtension({ getContext: () => context, document, db, syncEnabled: false });
const converter = new window.showdown.Converter({ tables: true, simpleLineBreaks: true });
const raw = '# 第一章\n\n普通正文\n@say:测试用户|平静|**这里显示的是替换前内容**\n@think:测试用户|欲言又止|我还没想好怎么说\n\n> 场景引用\n\n@say:测试用户|强作镇定|_我没事。_ 请选择 [Enter] 或 A | B。';
const tick = () => new Promise(resolve => setTimeout(resolve, 70));
function addMessage(text, isUser = false) {
  const id = context.chat.length;
  context.chat.push({ mes: text, is_user: isUser });
  const row = document.createElement('div'); row.className = 'mes'; row.setAttribute('mesid', id);
  const content = document.createElement('div'); content.className = 'mes_text';
  content.innerHTML = converter.makeHtml(text.replaceAll('替换前内容', '显示正则已生效'));
  row.append(content); document.getElementById('chat').append(row);
  return content;
}
try {
  const old = addMessage(raw); const oldHtml = old.innerHTML;
  addMessage('用户消息', true); addMessage(raw); addMessage(raw); addMessage(raw);
  await app.ready;
  const picture = color => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><circle cx="32" cy="26" r="12" fill="white"/><path d="M12 62Q32 30 52 62" fill="white"/></svg>`], { type: 'image/svg+xml' });
  await db.add('_global_', '测试用户', picture('#526bab'));
  await db.addMoodAvatar('_global_', '测试用户', 'mood-calm', picture('#409867'));
  await db.setConfig('style_globalTextColor', '#292724');
  await db.setConfig(buildColorConfigKey('_global_', '测试用户'), '#bc3344');
  await db.setConfig('style_narrationBgColor', '#fffdf5');
  await db.setConfig('style_narrationBgOpacity', 1);
  await app.assets.refresh();
  app.start();
  for (const callback of events.get('ready')) await callback();
  await tick();
  check(app.controller.active.size === 3, 'default must select exactly 3 AI replies');
  check(old.innerHTML === oldHtml, 'old history changed');
  check(document.querySelectorAll('.dc-msg').length === 9, 'bubble count');
  check(document.querySelectorAll('iframe').length === 0, 'bubble renderer should not create iframes');
  check(document.querySelector('.dc-msg-text-content strong').textContent.includes('显示正则已生效'), 'renderer ignored the display regex result');
  const thought = document.querySelector('[data-thought="1"]');
  check(thought.querySelector('.dc-msg-mood').textContent === '欲言又止', 'free thought mood lost');
  check(thought.querySelector('img'), 'base avatar missing');
  check(thought.querySelector('img').src !== document.querySelector('[data-mood-group="mood-calm"] img').src, 'mood avatar not distinguished');
  for (const node of document.querySelectorAll('h1.bd-narration,blockquote.bd-narration,.dc-msg-text')) {
    check(getComputedStyle(node).color === 'rgb(41, 39, 36)', 'global color mismatch: ' + node.tagName);
  }
  check(document.querySelectorAll('[data-thought="1"]').length === 3, 'italic speech misclassified');
  check(document.querySelector('[data-thought="0"] em')?.textContent === '我没事。', 'italic speech lost');
  passes.push('PASS 最近 3 条 AI；保留历史与显示正则；显式类型、Markdown、自由情绪与基础头像');
  await app.setSettings({ enabled: false });
  check(document.querySelectorAll('.dc-msg').length === 0, 'disable did not restore host messages');
  check(!prompts.get('dialogue-renderer/protocol'), 'disable did not clear prompt');
  await app.setSettings({ enabled: true, recentAiCount: 1 }); await tick();
  check(app.controller.active.size === 1, 'count change');
  check(document.querySelectorAll('.dc-msg').length === 3, 'count limits rendering');
  passes.push('PASS 一键开关同步撤销提示词；改为最近 1 条立即生效');
  const newest = addMessage(raw); await tick();
  check(app.controller.active.size === 1, 'new message window');
  newest.innerHTML = converter.makeHtml('@say:测试用户|强作镇定|修改回复后重新渲染'); await tick();
  check(newest.querySelector('.dc-msg-text-content').textContent === '修改回复后重新渲染', 'edited message not rendered');
  passes.push('PASS 新回复移出旧窗口；修改消息不残留旧渲染');
  await app.setSettings({ enabled: false });
  document.getElementById('chat').replaceChildren(); context.chat.length = 0;
  addMessage(raw);
  await app.setSettings({ enabled: true, recentAiCount: 3 }); await tick();
  check(!app.panel, 'manager loaded before opening');
  const manager = await app.openManager();
  check(document.getElementById('bam-panel'), 'avatar settings panel did not open');
  await manager._switchTab('style');
  const text = document.querySelector('.dc-msg-text');
  const bubbleNode = document.querySelector('.dc-msg');
  for (const [mode, color] of [['character','rgb(188, 51, 68)'], ['global','rgb(41, 39, 36)']]) {
    const radio = document.querySelector(`input[name="bam-color-mode"][value="${mode}"]`);
    radio.checked = true; radio.dispatchEvent(new Event('change')); await tick();
    check(getComputedStyle(text).color === color, 'preview color mode failed: ' + mode);
    check(document.querySelector('.dc-msg') === bubbleNode, 'color change rebuilt bubbles');
  }
  const size = document.getElementById('bam-range-dialogue-font');
  size.value = '20'; size.dispatchEvent(new Event('input')); await tick();
  check(getComputedStyle(text).fontSize === '20px', 'font size preview');
  manager.close(); await tick();
  check(getComputedStyle(text).fontSize === '14.5px', 'closing did not roll back unsaved size');
  passes.push('PASS 切换角色色/全局色即时生效；未保存关闭恢复；样式预览保留气泡节点');
  await app.openManager(); await manager._switchTab('mood');
  const promptEditor = document.getElementById('bam-prompt-template');
  check(!promptEditor.readOnly && promptEditor.value.includes('@say:'), 'editable prompt unavailable');
  check(promptEditor.value.length < 600, 'default prompt is too long');
  check(document.getElementById('bam-btn-export').style.display !== 'none', 'template export inaccessible');
  const customPrompt = promptEditor.value + '\n对话保持简短自然。';
  promptEditor.value = customPrompt; promptEditor.dispatchEvent(new Event('input', { bubbles: true }));
  await manager._saveMoodConfig();
  check(prompts.get('dialogue-renderer/protocol') === customPrompt, 'edited prompt was not injected verbatim');
  manager.close();
  passes.push('PASS 管理面板按需打开；单一提示词编辑保存；原样注入和模板导出入口');
  output.textContent = passes.join('\n'); output.dataset.status = 'passed';
} catch (error) {
  output.textContent = passes.join('\n') + '\nFAIL ' + (error.stack || error.message);
  output.dataset.status = 'failed';
}
window.addEventListener('pagehide', () => app.dispose(), { once: true });
