import { READING_PALETTES, READING_FONTS, readingPaletteId } from "./config.js?v=2.6.3";
import { parseDialogueLine, isDialogueCandidate } from "./protocol.js?v=2.6.3";

const BLOCKS = new Set(['P', 'DIV', 'BLOCKQUOTE', 'LI']);
export const PROTECTED_VIEWS = 'pre,iframe,details,[data-bd-owned],.mes_reasoning,.TH-render,.xiaobaix-iframe-wrapper';
const STYLE_PROTECTED = PROTECTED_VIEWS + ',script,style,custom-style,textarea,button,audio,video';
const PROTECTED_BLOCKS = STYLE_PROTECTED + ',table';
const PROTECTED = PROTECTED_BLOCKS + ',code';
let nextViewId = 0;
const AVATAR_COLORS = ['#92718f', '#528884', '#ac735c', '#409867', '#7b709c', '#ac8055', '#977047', '#a76477', '#526bab', '#547f9c'];

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

// Leading BRs left by host formatting would otherwise consume the first-line indent.
function markLeadingBreaks(paragraph, token) {
  if (paragraph.firstElementChild?.tagName !== 'BR' || !paragraph.textContent.trim()) return;
  for (const child of paragraph.childNodes) {
    if (child.nodeType === 8 || (child.nodeType === 3 && /^[\t\n\r\f ]*$/.test(child.data))) continue;
    if (child.nodeName !== 'BR') break;
    child.dataset.bdLeadingBreak = token;
  }
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

export function createDialogueRow(doc, name, type, content) {
  const thought = type === 'think';
  const msg = element(doc, 'div', 'dc-msg');
  msg.dataset.name = name.toLowerCase();
  msg.dataset.thought = thought ? '1' : '0';
  const speaker = element(doc, 'div', 'dc-msg-speaker');
  const avatar = element(doc, 'div', 'dc-msg-avatar');
  avatar.setAttribute('aria-hidden', 'true');
  const placeholder = element(doc, 'span', 'dc-msg-avatar-ph');
  let hash = 0;
  for (const letter of msg.dataset.name) hash = (Math.imul(hash, 31) + letter.codePointAt(0)) >>> 0;
  placeholder.style.backgroundColor = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  avatar.append(placeholder);
  speaker.append(element(doc, 'span', 'dc-msg-name', name), avatar);
  const text = element(doc, 'div', 'dc-msg-text');
  const body = element(doc, 'span', 'dc-msg-text-content' + (thought ? ' dc-msg-text-content-thought' : ''));
  body.append(content);
  text.append(body);
  msg.append(speaker, text);
  return { node: msg, avatar, placeholder };
}

export function setDialogueAvatar({ avatar, placeholder }, url) {
  if (!url) {
    if (avatar.firstElementChild !== placeholder) avatar.replaceChildren(placeholder);
    return;
  }
  let image = avatar.querySelector('img');
  if (!image) {
    image = avatar.ownerDocument.createElement('img');
    image.alt = '';
    image.addEventListener('error', () => {
      if (image.parentNode === avatar) avatar.replaceChildren(placeholder);
    }, { once: true });
    image.src = url;
    avatar.replaceChildren(image);
  } else if (image.getAttribute('src') !== url) image.src = url;
}

function bubble(doc, parsed, line, assets, isAlive) {
  const range = rangeFor(doc, line, parsed.start, parsed.end);
  const row = createDialogueRow(doc, parsed.name, parsed.type, range ? cloneInline(range) : parsed.text);
  const msg = row.node;
  let assetRevision = 0;
  function updateAssets() {
    const revision = ++assetRevision;
    const group = assets.getMood(parsed.mood);
    const groupId = group?.id || '';
    if (msg.dataset.moodGroup !== groupId) msg.dataset.moodGroup = groupId;
    assets.resolve(parsed.name, parsed.mood).then(resolved => {
      if (!isAlive() || revision !== assetRevision) return;
      setDialogueAvatar(row, resolved.avatar);
    }).catch(error => { if (isAlive() && revision === assetRevision) assets.onError(error); });
  }
  updateAssets();
  return { node: msg, updateAssets };
}

export function applyStyles(root, settings) {
  const mode = readingPaletteId(settings);
  if (root.dataset.bdColorMode !== mode) root.dataset.bdColorMode = mode;
  const px = (key, fallback) => Number.isFinite(Number(settings[key])) ? Number(settings[key]) + 'px' : fallback;
  const palette = READING_PALETTES[mode];
  const fonts = key => READING_FONTS[settings[key]]?.stack ?? (JSON.stringify(settings[key]) + ',system-ui,sans-serif');
  const size = settings.style_avatarSize < 0 ? 'var(--bd-auto-avatar)' : Math.min(120, Math.max(36, Number(settings.style_avatarSize))) + 'px';
  const radius = settings.style_avatarShape === 'circle' ? '50%' : settings.style_avatarShape === 'square' ? '0px' : '8px';
  const css = {
    '--bd-color': palette.ink,
    '--bd-paper': palette.paper,
    '--bd-narration-color': palette.narration,
    '--bd-speech-color': palette.speech,
    '--bd-bubble-border': palette.bubbleBorder,
    '--bd-name-color': palette.name,
    '--bd-narration-size': px('style_narrationFontSize', '17px'),
    '--bd-dialogue-size': px('style_dialogueFontSize', '15px'),
    '--bd-narration-weight': settings.style_narrationFontWeight,
    '--bd-dialogue-weight': settings.style_dialogueFontWeight,
    '--bd-name-weight': settings.style_nameFontWeight,
    '--bd-narration-font': fonts('style_narrationFontFamily'),
    '--bd-dialogue-font': fonts('style_dialogueFontFamily'),
    '--bd-name-font': fonts('style_nameFontFamily'),
    '--bd-narration-line-height': settings.style_narrationLineHeight,
    '--bd-dialogue-line-height': settings.style_dialogueSpacing < 0 ? '1.85' : Math.max(Number(settings.style_dialogueFontSize) * 1.35,
      Number(settings.style_dialogueFontSize) + Number(settings.style_dialogueSpacing)) + 'px',
    '--bd-narration-left': settings.style_narrationIndent < 0 ? 'var(--bd-page-inset)' : px('style_narrationIndent', '0px'),
    '--bd-narration-right': settings.style_narrationPaddingRight < 0 ? 'var(--bd-page-inset)' : px('style_narrationPaddingRight', '0px'),
    '--bd-narration-radius': px('style_narrationBorderRadius', '0px'),
    '--bd-indent': Number(settings.style_narrationTextIndent) + 'em',

    '--bd-avatar-size': size, '--bd-avatar-radius': radius,
  };
  for (const [key, value] of Object.entries(css)) {
    const next = String(value);
    if (root.style.getPropertyValue(key) !== next) root.style.setProperty(key, next);
  }
}

/** Decorate host-formatted DOM; no raw-message regex pass and no code-block iframe. */
export function decorateMessage(root, assets, { signal, streaming = false } = {}) {
  if (signal?.aborted) return { dispose() {}, updateStyles() {}, updateAssets() {}, diagnostics: [], count: 0 };
  if (root.classList.contains('bd-content') || root.hasAttribute('data-bd-view')) throw new Error('该消息已经由对话渲染系统接管');
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
  if (!count) return { dispose() {}, updateStyles() {}, updateAssets() {}, diagnostics, count };
  const viewId = 'bd-' + (++nextViewId);
  const patches = [];
  const marked = [];
  const assetUpdates = [];
  let alive = !signal?.aborted;
  const hadStyle = root.hasAttribute('style');
  const oldColorMode = root.getAttribute('data-bd-color-mode');
  const oldProperties = new Map(Array.from(root.style).filter(key => key.startsWith('--bd-'))
    .map(key => [key, [root.style.getPropertyValue(key), root.style.getPropertyPriority(key)]]));
  let ownedProperties = [];
  try {
    root.classList.add('bd-content');
    root.dataset.bdView = viewId;
    applyStyles(root, assets.settings);
    ownedProperties = Array.from(root.style).filter(key => key.startsWith('--bd-'));

    for (const { original, lines, parsed } of blocks) {
      if (!parsed.some(line => line.kind === 'dialogue')) continue;
      const segment = element(doc, 'div', 'bd-segment');
      const token = viewId + ':' + patches.length;
      segment.dataset.bdOwned = token;
      let narration;
      lines.forEach((line, index) => {
        if (parsed[index].kind === 'dialogue') {
          narration = null;
          const rendered = bubble(doc, parsed[index], line, assets, () => alive);
          segment.append(rendered.node);
          assetUpdates.push(rendered.updateAssets);
        } else if (line.text.trim()) {
          if (!narration) { narration = element(doc, 'div', 'dc-narration-block'); segment.append(narration); }
          const p = element(doc, 'p');
          const range = rangeFor(doc, line);
          if (range) p.append(cloneInline(range));
          narration.append(p);
        }
      });
      original.replaceWith(segment);
      patches.push({ original, segment, token });
    }
    // Decorate only plain narrative blocks. Dedicated HTML/code runtimes keep ownership.
    for (const node of root.children) {
      if (!node.matches('p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,hr,table') || node.matches(STYLE_PROTECTED) || node.querySelector(STYLE_PROTECTED)) continue;
      if (!node.classList.contains('bd-narration')) {
        const hadClass = node.hasAttribute('class');
        const token = viewId + ':' + marked.length;
        node.classList.add('bd-narration');
        node.dataset.bdNarration = token;
        marked.push({ node, hadClass, token });
        if (node.tagName === 'P') markLeadingBreaks(node, token);
      }
    }
  } catch (error) {
    ownedProperties = Array.from(root.style).filter(key => key.startsWith('--bd-'));
    dispose();
    throw error;
  }
  function dispose({ replacementRoot } = {}) {
    if (!alive) return;
    alive = false;
    const roots = [root];
    // Other renderers may rewrite innerHTML or copy the message root. Tokens survive
    // those copies, so restore our projections while preserving their HTML/iframes.
    if (replacementRoot && replacementRoot !== root && (replacementRoot.dataset.bdView === viewId
      || replacementRoot.querySelector(`[data-bd-owned^="${viewId}:"]`))) roots.unshift(replacementRoot);
    for (const { original, segment, token } of patches) {
      const copies = roots.flatMap(target => [...target.querySelectorAll(`[data-bd-owned="${token}"]`)]);
      if (!copies.length && segment.parentNode) copies.push(segment);
      copies.forEach((copy, index) => copy.replaceWith(index === 0 ? original : original.cloneNode(true)));
    }
    for (const { node, hadClass, token } of marked) {
      const copies = new Set([node, ...roots.flatMap(target => [...target.querySelectorAll(`[data-bd-narration="${token}"]`)])]);
      for (const copy of copies) {
        for (const br of copy.querySelectorAll(`br[data-bd-leading-break="${token}"]`)) br.removeAttribute('data-bd-leading-break');
        copy.classList.remove('bd-narration');
        copy.removeAttribute('data-bd-narration');
        if (!hadClass && !copy.className) copy.removeAttribute('class');
      }
    }
    for (const target of roots) {
      target.classList.remove('bd-content');
      target.removeAttribute('data-bd-view');
      if (oldColorMode === null) target.removeAttribute('data-bd-color-mode');
      else target.setAttribute('data-bd-color-mode', oldColorMode);
      for (const key of ownedProperties) {
        const old = oldProperties.get(key);
        if (old) target.style.setProperty(key, ...old); else target.style.removeProperty(key);
      }
      if (!hadStyle && target.style.length === 0) target.removeAttribute('style');
    }
    signal?.removeEventListener('abort', dispose);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  return {
    dispose,
    updateStyles: settings => { if (alive) applyStyles(root, settings); },
    updateAssets() {
      if (!alive) return;
      applyStyles(root, assets.settings);
      for (const update of assetUpdates) update();
    },
    diagnostics, count,
  };
}
