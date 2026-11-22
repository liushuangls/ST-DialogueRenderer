import { createExtension } from "../src/extension.js?v=2.3.0";
import { AvatarDB } from "../src/storage.js?v=2.3.0";
import { buildColorConfigKey } from "../src/context.js?v=2.3.0";

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
  await db.setConfig('style_narrationFontSize', 17);
  await db.setConfig('style_dialogueFontSize', 17); // Legacy equal-size slider.
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
  check(!thought.textContent.includes('欲言又止') && !thought.querySelector('.dc-msg-mood'), 'mood appeared in the conversation');
  check(thought.querySelector('img'), 'base avatar missing');
  check(thought.querySelector('img').src !== document.querySelector('[data-mood-group="mood-calm"] img').src, 'mood avatar not distinguished');
  for (const node of document.querySelectorAll('h1.bd-narration,blockquote.bd-narration,.dc-msg-text')) {
    const expected = node.matches('.dc-msg-text') ? 'rgb(45, 43, 39)' : 'rgb(83, 80, 75)';
    check(getComputedStyle(node).color === expected, 'legacy palette mismatch: ' + node.tagName);
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
  newest.innerHTML = newest.innerHTML + '<div class="external-view"><iframe title="独立前端"></iframe></div>';
  const externalFrame = newest.querySelector('iframe');
  await tick();
  const avatar = newest.querySelector('.dc-msg-avatar');
  check(newest.classList.contains('bd-content'), 'HTML rewrite lost the style owner');
  const narrow = matchMedia('(max-width:480px)').matches;
  check(avatar.getBoundingClientRect().width === (narrow ? 40 : 48), 'copied avatar lost its default size');
  check(getComputedStyle(newest.querySelector('.dc-msg-speaker')).display === 'flex', 'copied dialogue header lost its layout');
  check(newest.querySelector('iframe') === externalFrame, 'foreign iframe was replaced');
  await app.setSettings({ enabled: false });
  check(newest.querySelectorAll('.dc-msg,.bd-narration,[data-bd-owned],[data-bd-narration]').length === 0, 'copied projection survived disabling');
  check(newest.querySelector('iframe') === externalFrame, 'disabling replaced a foreign iframe');
  passes.push('PASS HTML 整段重写后头像尺寸、姓名布局正常；关闭时恢复原文并保留 iframe');
  const chatElement = document.getElementById('chat');
  const chatStyle = chatElement.getAttribute('style');
  const avatarSize = app.assets.settings.style_avatarSize;
  chatElement.replaceChildren(); context.chat.length = 0;
  chatElement.style.cssText = 'height:320px;overflow-y:auto;scroll-behavior:auto';
  await db.setConfig('style_avatarSize', 100); await app.assets.refresh();
  const longReply = addMessage(Array.from({ length: 20 }, (_, i) => '@say:测试用户|平静|长回复中的第 ' + (i + 1) + ' 段对话。').join('\n'));
  await app.setSettings({ enabled: true }); await tick();
  chatElement.scrollTop = (chatElement.scrollHeight - chatElement.clientHeight) * 0.6;
  await tick();
  const readingTop = chatElement.scrollTop;
  const readingHeight = chatElement.scrollHeight;
  const readingBubble = longReply.querySelectorAll('.dc-msg')[12];
  const readingOffset = readingBubble.getBoundingClientRect().top;
  check(readingTop > 300, 'long reply must provide a real reading position');
  for (let i = 0; i < 3; i++) {
    // Foreground/online handlers call this after synchronizing resources.
    const heights = [];
    const geometryObserver = new MutationObserver(() => heights.push(chatElement.scrollHeight));
    geometryObserver.observe(longReply, { childList: true, attributes: true, subtree: true });
    await app.refresh();
    check(chatElement.scrollHeight === readingHeight, 'resource refresh transiently collapsed the chat');
    await tick();
    geometryObserver.disconnect();
    check(heights.every(height => height === readingHeight), 'a DOM observer saw the chat collapse during refresh');
    check(Math.abs(chatElement.scrollTop - readingTop) <= 1, 'resource refresh moved the reading position');
    check(longReply.querySelectorAll('.dc-msg')[12] === readingBubble, 'resource refresh replaced the reading anchor');
    check(Math.abs(readingBubble.getBoundingClientRect().top - readingOffset) <= 1, 'resource refresh shifted the reading anchor');
  }
  passes.push('PASS 返回前台的资源刷新保持长消息滚动高度、正文节点和阅读位置');
  await app.setSettings({ enabled: false });
  if (chatStyle === null) chatElement.removeAttribute('style'); else chatElement.setAttribute('style', chatStyle);
  await db.setConfig('style_avatarSize', avatarSize); await app.assets.refresh();
  document.getElementById('chat').replaceChildren(); context.chat.length = 0;
  const story = addMessage(raw + '\n\n@say:茶馆老板娘|温和|「' + '天色已经放晴了。'.repeat(18) + '」');
  story.insertAdjacentHTML('afterbegin',
    '<div class="TH-render"><details open><summary>吾乃小猫之神…</summary><p>@think:示例|平静|思考过程</p></details><iframe title="思考栏"></iframe></div>');
  const reasoning = story.querySelector('.TH-render');
  const reasoningFrame = reasoning.querySelector('iframe');
  const hostColor = getComputedStyle(reasoning).color;
  const hostBackground = getComputedStyle(story).backgroundColor;
  await app.setSettings({ enabled: true, recentAiCount: 3 }); await tick();
  check(!app.panel, 'manager loaded before opening');
  const manager = await app.openManager();
  check(document.getElementById('bam-panel'), 'avatar settings panel did not open');
  await manager._switchTab('style');
  const text = story.querySelector('.dc-msg-text');
  const bubbleNode = story.querySelector('.dc-msg');
  const readingRoot = text.closest('.bd-content');
  const paragraph = readingRoot.querySelector('.dc-narration-block p');
  const name = bubbleNode.querySelector('.dc-msg-name');
  for (const [node, fontSize, lineHeight] of [[paragraph,17,31.45],[text,15,27.75]]) {
    const style = getComputedStyle(node);
    check(style.fontFamily.includes('WenQuanYi Zen Hei') && style.fontWeight === '400', 'default reading font');
    check(parseFloat(style.fontSize) === fontSize && Math.abs(parseFloat(style.lineHeight) - lineHeight) < 0.01, 'default reading metrics');
  }
  check(getComputedStyle(paragraph).textIndent === '34px' && getComputedStyle(paragraph).textAlign === 'justify', 'narration alignment');
  check(getComputedStyle(paragraph.parentElement).paddingLeft === (matchMedia('(max-width:480px)').matches ? '12px' : '20px'), 'page inset');
  check(getComputedStyle(name).fontSize === '11px' && getComputedStyle(name).fontWeight === '400' && getComputedStyle(name).lineHeight === '13.75px', 'speaker name metrics');
  check(getComputedStyle(bubbleNode).marginTop === '14px' && getComputedStyle(bubbleNode).marginBottom === '16px', 'dialogue spacing');
  for (const row of story.querySelectorAll('.dc-msg')) {
    const bounds = selector => row.querySelector(selector).getBoundingClientRect();
    const nameRect = bounds('.dc-msg-name');
    const avatarRect = bounds('.dc-msg-avatar');
    const speakerRect = bounds('.dc-msg-speaker');
    const bubbleRect = bounds('.dc-msg-text');
    check(Math.abs(avatarRect.top - nameRect.bottom - 3) < 1, 'name must sit above the avatar');
    check(Math.abs(avatarRect.bottom - bubbleRect.bottom) < 1, 'avatar must align with the bottom of short and wrapped bubbles');
    check(Math.abs(bubbleRect.left - speakerRect.right - (narrow ? 7 : 9)) < 1, 'speaker-to-bubble gap');
    check(bubbleRect.right <= row.getBoundingClientRect().right, 'bubble overflowed the row');
  }
  const longSpeech = story.querySelector('[data-name="茶馆老板娘"] .dc-msg-text');
  check(longSpeech.offsetHeight > (narrow ? 40 : 48) && !longSpeech.textContent.startsWith('「「'), 'long quoted dialogue');
  const originalAvatarSize = getComputedStyle(bubbleNode.querySelector('.dc-msg-avatar')).width;
  for (const [mode, paper, speech, narration, border] of [
    ['light','rgb(250, 249, 245)','rgb(45, 43, 39)','rgb(83, 80, 75)','rgba(83, 80, 75, 0.26)'],
    ['dark','rgb(44, 44, 44)','rgb(239, 237, 232)','rgb(207, 203, 196)','rgba(207, 203, 196, 0.26)'],
    ['parchment','rgb(239, 226, 196)','rgb(66, 50, 31)','rgb(99, 80, 58)','rgba(99, 80, 58, 0.3)'],
  ]) {
    document.querySelector(`input[name="bam-palette"][value="${mode}"]`).click(); await tick();
    check(getComputedStyle(readingRoot).backgroundColor === hostBackground, 'paper leaked onto the host: ' + mode);
    check(reasoning.querySelector('iframe') === reasoningFrame && reasoning.querySelector('p').textContent.startsWith('@think:'), 'reasoning content changed');
    check(getComputedStyle(reasoning).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(reasoning).color === hostColor, 'reasoning palette: ' + mode);
    for (const surface of readingRoot.querySelectorAll('[data-bd-owned],[data-bd-narration]')) {
      check(getComputedStyle(surface).backgroundColor === paper, 'story paper color: ' + mode);
    }
    for (const item of [...readingRoot.querySelectorAll('.dc-msg-text'), document.querySelector('#bam-reading-sample .dc-msg-text')]) {
      const style = getComputedStyle(item);
      check(style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.border === '1px solid ' + border && style.borderRadius === '10px' && style.padding === '6px 11px' && style.boxShadow === 'none', 'dialogue frame: ' + mode);
    }
    for (const body of story.querySelectorAll('.dc-msg-text-content')) {
      const ink = getComputedStyle(body);
      check(ink.color === speech && ink.fontSize === '15px' && ink.lineHeight === '27.75px', 'speech typography: ' + mode);
    }
    const portrait = story.querySelector('[data-name="茶馆老板娘"] .dc-msg-avatar img');
    check(portrait?.naturalWidth > 0 && portrait.src.includes('/assets/portraits/') && getComputedStyle(portrait).width === originalAvatarSize, 'automatic pool portrait: ' + mode);
    const nameColor = mode === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
    check(getComputedStyle(name).color === nameColor, 'name color: ' + mode);
    check(text.textContent.startsWith('「') && text.textContent.endsWith('」'), 'speech punctuation');
    check(getComputedStyle(readingRoot.querySelector('.dc-narration-block')).color === narration, 'narration color: ' + mode);
    check(story.querySelector('.dc-msg') === bubbleNode, 'palette change rebuilt bubbles');
    check(getComputedStyle(bubbleNode.querySelector('.dc-msg-avatar')).width === originalAvatarSize, 'palette resized the avatar');
  }
  document.querySelector('input[name="bam-reading-font"][value="system-ui"]').click(); await tick();
  check(getComputedStyle(text).fontFamily.includes('system-ui'), 'reading font preview');
  const size = document.getElementById('bam-range-dialogue-font');
  size.value = '20'; size.dispatchEvent(new Event('input', { bubbles:true })); await tick();
  check(getComputedStyle(paragraph).fontSize === '20px' && getComputedStyle(text).fontSize === '18px', 'font size preview');
  manager.close(); await tick();
  check(getComputedStyle(text).fontSize === '15px', 'closing did not roll back unsaved size');
  passes.push('PASS 三套配色使用透明轻气泡和淡描边；长短台词左侧署名与头像底部对齐，思考栏沿用原色');
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
  await app.openManager();
  const poolPicker = document.getElementById('bam-pool');
  poolPicker.open = true; await tick();
  const poolGrid = poolPicker.querySelector('.bam-pool-grid');
  const until = async predicate => {
    for (let i = 0; i < 45; i++) { if (predicate()) return; await tick(); }
    throw new Error('avatar picker did not reach the expected state: ' + poolPicker.querySelector('[role=status]').textContent);
  };
  await until(() => poolGrid.children.length === 30);
  await Promise.all([...poolGrid.querySelectorAll('img')].map(image => image.decode()));
  const firstPortrait = poolGrid.querySelector('[data-id="m01.webp"]');
  const originalPortrait = await (await fetch(firstPortrait.querySelector('img').src)).blob();
  firstPortrait.click(); await until(() => manager.pendingFile && !poolPicker.open);
  document.getElementById('bam-alias-input').value = '茶馆老板娘';
  document.getElementById('bam-btn-confirm-upload').click();
  await until(() => document.querySelector('.bam-avatar-item[data-name="茶馆老板娘"]'));
  const input = poolPicker.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([originalPortrait], '池内上传.webp', {type:'image/webp'}));
  input.files = transfer.files; poolPicker.open = true;
  input.dispatchEvent(new Event('change', {bubbles:true}));
  await until(() => poolPicker.querySelector('select').value === '我上传的' && poolGrid.querySelector('[data-id^="upload:"]'));
  poolGrid.querySelector('button').click(); await until(() => manager.pendingFile && !poolPicker.open);
  document.getElementById('bam-alias-input').value = '池内选用';
  document.getElementById('bam-btn-confirm-upload').click();
  await until(() => document.querySelector('.bam-avatar-item[data-name="池内选用"]'));
  const savedPoolAvatar = await db.get(manager._getActiveCharId(), '池内选用');
  check(savedPoolAvatar.imageBlob?.size === originalPortrait.size, 'pool assignment must carry a portable image');
  manager.close(); await app.refresh(); await tick();
  check(story.querySelector('[data-name="茶馆老板娘"] .dc-msg-avatar img')?.src.startsWith('blob:'), 'manual pool assignment did not override automatic selection');
  passes.push('PASS 30 张内置图可解码，池内选图指定、本地上传入池、再选用和手动覆盖均生效');
  output.textContent = passes.join('\n'); output.dataset.status = 'passed';
} catch (error) {
  output.textContent = passes.join('\n') + '\nFAIL ' + (error.stack || error.message);
  output.dataset.status = 'failed';
}
