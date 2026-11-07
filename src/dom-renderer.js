import { parseDialogueLine, isDialogueCandidate } from "./protocol.js?v=2.0.1";

const BLOCKS = new Set(['P', 'DIV', 'BLOCKQUOTE', 'LI']);
const PROTECTED = 'pre,code,iframe,script,style,custom-style,details,table,textarea,button,audio,video,[data-bd-owned],.mes_reasoning';
const PROTECTED_BLOCKS = PROTECTED.replace('code,', '');
const STYLE_PROTECTED = PROTECTED_BLOCKS.replace('table,', '');
const COLORS = ['#f47b67', '#45ddc0', '#e78bff', '#f0b232', '#58a6ff', '#ff9a76', '#7ee787', '#d2a8ff'];

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Record text-node positions so rich text survives splitting a paragraph at <br>.
function linesOf(node) {
  const lines = [{ text: '', spans: [] }];
  const newline = () => lines.push({ text: '', spans: [] });
  function visit(child) {
    if (child.nodeType === 3) {
      let offset = 0;
      const parts = child.data.split('\n');
      parts.forEach((part, index) => {
        const line = lines.at(-1);
        if (part.length) line.spans.push({ node: child, from: offset, start: line.text.length, end: line.text.length + part.length });
        line.text += part;
        offset += part.length + 1;
        if (index < parts.length - 1) newline();
      });
    } else if (child.nodeType === 1) {
      if (child.tagName === 'BR') newline();
      else for (const nested of child.childNodes) visit(nested);
    }
  }
  visit(node);
  return lines;
}

function rangeFor(doc, line, start = 0, end = line.text.length) {
  const first = line.spans.find(span => start < span.end);
  const last = line.spans.findLast(span => end > span.start);
  if (!first || !last || end <= start) return null;
  const range = doc.createRange();
  range.setStart(first.node, first.from + Math.max(0, start - first.start));
  range.setEnd(last.node, last.from + Math.min(last.end - last.start, end - last.start));
  return range;
}

function cloneInline(range) {
  let fragment = range.cloneContents();
  let parent = range.commonAncestorContainer;
  if (parent.nodeType === 3) parent = parent.parentElement;
  while (parent && !BLOCKS.has(parent.tagName) && !parent.classList.contains('mes_text')) {
    const wrapper = parent.cloneNode(false);
    wrapper.append(fragment);
    fragment = range.startContainer.ownerDocument.createDocumentFragment();
    fragment.append(wrapper);
    parent = parent.parentElement;
  }
  return fragment;
}

function candidates(root) {
  const result = [];
  function visit(node) {
    if (node.nodeType === 3) {
      if (/(?:@say|@think)/.test(node.textContent)) result.push(node);
      return;
    }
    if (node.nodeType !== 1 || node.matches(PROTECTED)) return;
    if (node.querySelector(PROTECTED_BLOCKS)) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    const nestedBlocks = node.querySelector('p,div,blockquote,li');
    if (BLOCKS.has(node.tagName) && !nestedBlocks) result.push(node);
    else for (const child of node.childNodes) visit(child);
  }
  for (const node of root.childNodes) visit(node);
  return result;
}

function renderName(doc, name) {
  const holder = element(doc, 'span', 'dc-msg-name');
  [...name].forEach((letter, index) => {
    const span = element(doc, 'span', index === 0 ? 'dc-ch' : index === 2 ? 'dc-cs' : 'dc-cn', letter);
    if (index === 0 || index === 2) span.style.color = 'var(--bd-accent-color)';
    holder.append(span);
  });
  return holder;
}

function bubble(doc, parsed, line, assets, isAlive) {
  const nameKey = parsed.name.toLowerCase();
  const hash = [...nameKey].reduce((sum, char) => ((sum * 31) + char.codePointAt(0)) >>> 0, 0);
  const color = COLORS[hash % COLORS.length];
  const group = assets.getMood(parsed.mood);
  const range = rangeFor(doc, line, parsed.start, parsed.end);
  const thought = parsed.type === 'think';
  const msg = element(doc, 'div', 'dc-msg');
  msg.style.setProperty('--bd-accent-color', color);
  msg.dataset.name = nameKey;
  msg.dataset.thought = thought ? '1' : '0';
  msg.dataset.moodGroup = group?.id || '';
  const avatar = element(doc, 'div', 'dc-msg-avatar');
  const placeholder = element(doc, 'div', 'dc-msg-avatar-ph', [...parsed.name][0]);
  placeholder.style.background = 'var(--bd-accent-color)';
  avatar.append(placeholder);
  const heading = element(doc, 'div', 'dc-msg-header');
  const name = renderName(doc, parsed.name);
  const mood = element(doc, 'span', 'dc-msg-mood', parsed.mood);
  mood.dataset.moodMapped = group ? '1' : '0';
  mood.style.color = group?.color || 'var(--bd-accent-color)';
  mood.style.background = 'color-mix(in srgb, currentColor 15%, transparent)';
  heading.append(name, mood);
  const text = element(doc, 'div', 'dc-msg-text');
  const body = element(doc, 'span', 'dc-msg-text-content' + (thought ? ' dc-msg-text-content-thought' : ''));
  body.append(range ? cloneInline(range) : doc.createTextNode(parsed.text));
  const quote = element(doc, 'span', 'dc-msg-quote' + (thought ? ' dc-msg-quote-thought' : ''), thought ? '＊' : '”');
  quote.style.color = 'var(--bd-accent-color)';
  text.append(body, quote);
  msg.append(avatar, heading, text);
  assets.resolve(parsed.name, parsed.mood).then(resolved => {
    if (!isAlive()) return;
    if (resolved.avatar) {
      const image = element(doc, 'img');
      image.alt = parsed.name; image.src = resolved.avatar;
      avatar.replaceChildren(image);
    }
    if (resolved.color) {
      msg.style.setProperty('--bd-accent-color', resolved.color);
      msg.style.setProperty('--bd-character-color', resolved.color);
    }
  }).catch(error => { if (isAlive()) assets.onError(error); });
  return msg;
}

export function applyStyles(root, settings) {
  root.dataset.bdColorMode = settings.style_textColorMode;
  const px = (key, fallback) => Number.isFinite(Number(settings[key])) ? Number(settings[key]) + 'px' : fallback;
  const fonts = key => JSON.stringify(settings[key]) + ',system-ui,sans-serif';
  const size = Math.min(120, Math.max(36, Number(settings.style_avatarSize)));
  const radius = settings.style_avatarShape === 'circle' ? '50%' : settings.style_avatarShape === 'square' ? '0px' : '8px';
  const css = {
    '--bd-color': settings.style_globalTextColor,
    '--bd-narration-size': px('style_narrationFontSize', '14px'),
    '--bd-dialogue-size': px('style_dialogueFontSize', '14.5px'),
    '--bd-narration-weight': settings.style_narrationFontWeight,
    '--bd-dialogue-weight': settings.style_dialogueFontWeight,
    '--bd-name-weight': settings.style_nameFontWeight,
    '--bd-narration-font': fonts('style_narrationFontFamily'),
    '--bd-dialogue-font': fonts('style_dialogueFontFamily'),
    '--bd-name-font': fonts('style_nameFontFamily'),
    '--bd-narration-line-height': settings.style_narrationLineHeight,
    '--bd-dialogue-line-height': Math.max(Number(settings.style_dialogueFontSize) * 1.35,
      Number(settings.style_dialogueFontSize) + Number(settings.style_dialogueSpacing)) + 'px',
    '--bd-narration-left': px('style_narrationIndent', '16px'),
    '--bd-narration-right': px('style_narrationPaddingRight', '16px'),
    '--bd-narration-radius': px('style_narrationBorderRadius', '0px'),
    '--bd-indent': Number(settings.style_narrationTextIndent) + 'em',
    '--bd-background': `color-mix(in srgb, ${settings.style_narrationBgColor} ${Number(settings.style_narrationBgOpacity) * 100}%, transparent)`,
    '--bd-avatar-size': size + 'px', '--bd-avatar-radius': radius,
    '--bd-message-left': (size + 24) + 'px', '--bd-message-min-height': Math.max(56, size + 4) + 'px',
    '--bd-placeholder-size': Math.max(16, Math.round(size * 0.38)) + 'px',
  };
  for (const [key, value] of Object.entries(css)) root.style.setProperty(key, String(value));
}

/** Decorate host-formatted DOM; no raw-message regex pass and no code-block iframe. */
export function decorateMessage(root, assets, { signal, streaming = false } = {}) {
  if (signal?.aborted) return { dispose() {}, updateStyles() {}, diagnostics: [], count: 0 };
  if (root.classList.contains('bd-content')) throw new Error('该消息已经由对话渲染系统接管');
  const doc = root.ownerDocument;
  const diagnostics = [];
  let markerIndex = 0;
  let count = 0;
  let lastTextNode = null;
  if (streaming) {
    const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (walker.currentNode.data.trim()) lastTextNode = walker.currentNode;
  }
  const isTail = line => {
    const end = line.text.trimEnd().length;
    const span = line.spans.findLast(item => end > item.start);
    return span?.node === lastTextNode && span.from + end - span.start === lastTextNode.data.trimEnd().length;
  };
  const blocks = candidates(root).map(original => {
    const lines = linesOf(original);
    const parsed = lines.map(line => {
      if (!isDialogueCandidate(line.text)) return { kind: 'text' };
      const start = line.text.indexOf('@');
      const span = line.spans.find(item => item.start <= start && start < item.end);
      if (span?.node.parentElement?.closest('code,pre')) return { kind: 'text' };
      markerIndex++;
      const result = parseDialogueLine(line.text, { incomplete: streaming && isTail(line) });
      if (result.kind === 'invalid') diagnostics.push({ marker: markerIndex, reason: result.reason });
      if (result.kind === 'dialogue') count++;
      return result;
    });
    return { original, lines, parsed };
  });
  if (!count) return { dispose() {}, updateStyles() {}, diagnostics, count };
  const patches = [];
  const marked = [];
  let alive = !signal?.aborted;
  const hadStyle = root.hasAttribute('style');
  const oldColorMode = root.getAttribute('data-bd-color-mode');
  const oldProperties = new Map(Array.from(root.style).filter(key => key.startsWith('--bd-'))
    .map(key => [key, [root.style.getPropertyValue(key), root.style.getPropertyPriority(key)]]));
  let ownedProperties = [];
  try {
    root.classList.add('bd-content');
    applyStyles(root, assets.settings);
    ownedProperties = Array.from(root.style).filter(key => key.startsWith('--bd-'));

    for (const { original, lines, parsed } of blocks) {
      if (!parsed.some(line => line.kind === 'dialogue')) continue;
      const segment = element(doc, 'div', 'bd-segment');
      segment.dataset.bdOwned = '';
      let narration;
      lines.forEach((line, index) => {
        if (parsed[index].kind === 'dialogue') {
          narration = null;
          segment.append(bubble(doc, parsed[index], line, assets, () => alive));
        } else if (line.text.trim()) {
          if (!narration) { narration = element(doc, 'div', 'dc-narration-block'); segment.append(narration); }
          const p = element(doc, 'p');
          const range = rangeFor(doc, line);
          if (range) p.append(cloneInline(range));
          narration.append(p);
        }
      });
      original.replaceWith(segment);
      patches.push({ original, segment });
    }
    // Decorate only plain narrative blocks. Dedicated HTML/code runtimes keep ownership.
    for (const node of root.children) {
      if (!node.matches('p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,hr,table') || node.matches(STYLE_PROTECTED) || node.querySelector(STYLE_PROTECTED)) continue;
      if (!node.classList.contains('bd-narration')) {
        const hadClass = node.hasAttribute('class');
        node.classList.add('bd-narration'); marked.push({ node, hadClass });
      }
    }
  } catch (error) {
    ownedProperties = Array.from(root.style).filter(key => key.startsWith('--bd-'));
    dispose();
    throw error;
  }
  function dispose() {
    if (!alive) return;
    alive = false;
    for (const { original, segment } of patches) if (segment.parentNode) segment.replaceWith(original);
    for (const { node, hadClass } of marked) {
      node.classList.remove('bd-narration');
      if (!hadClass && !node.className) node.removeAttribute('class');
    }
    root.classList.remove('bd-content');
    if (oldColorMode === null) root.removeAttribute('data-bd-color-mode');
    else root.setAttribute('data-bd-color-mode', oldColorMode);
    for (const key of ownedProperties) {
      const old = oldProperties.get(key);
      if (old) root.style.setProperty(key, ...old); else root.style.removeProperty(key);
    }
    if (!hadStyle && root.style.length === 0) root.removeAttribute('style');
    signal?.removeEventListener('abort', dispose);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  return { dispose, updateStyles: settings => { if (alive) applyStyles(root, settings); }, diagnostics, count };
}
