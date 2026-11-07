import { DEFAULT_MOOD_GROUPS, normalizeMoodConfig } from './config.js?v=2.0.0';

export const PROTOCOL_VERSION = 2;
export const DIALOGUE_TYPES = Object.freeze({ say: '角色直接说出口的话', think: '角色未说出口的想法' });
export const PROMPT_SUPPLEMENT_KEY = 'prompt_supplement';

export function isDialogueCandidate(text) {
  return /^\s*@(say|think)(?=[:：\s|]|$)/.test(text);
}

/** Offsets refer to the host-formatted line; Markdown affects presentation only. */
export function parseDialogueLine(line, { incomplete = false } = {}) {
  if (!isDialogueCandidate(line)) return { kind: 'text' };
  const invalid = reason => ({ kind: incomplete ? 'incomplete' : 'invalid', reason });
  const header = /^\s*@(say|think):/.exec(line);
  if (!header) return invalid('类型后需要英文冒号，例如 @say:');
  if (/[\r\n]/.test(line)) return invalid('每条台词或想法必须独占一行');
  const first = line.indexOf('|', header[0].length);
  const second = line.indexOf('|', first + 1);
  if (first < 0 || second < 0) return invalid('需要 姓名|情绪|正文 三个字段');
  const name = line.slice(header[0].length, first).trim();
  const mood = line.slice(first + 1, second).trim();
  const payload = line.slice(second + 1);
  const text = payload.trim();
  if (!name) return invalid('角色姓名不能为空');
  if (/^(旁白|narrator)$/i.test(name)) return invalid('叙述应写成普通段落，不使用角色行');
  if (!mood) return invalid('情绪不能为空');
  if (!text) return invalid('正文不能为空');
  const start = second + 1 + payload.indexOf(text);
  return { kind: 'dialogue', type: header[1], name, mood, text, start, end: start + text.length };
}

export function validateSupplement(value) {
  if (typeof value !== 'string') throw new Error('补充提示词必须是文本');
  return value.trim();
}

export function buildPrompt({ supplement = '', groups = DEFAULT_MOOD_GROUPS } = {}) {
  const references = normalizeMoodConfig({ groups }).groups.map(group => group.words[0]).join('、');
  const examples = Object.entries(DIALOGUE_TYPES).map(([type, label]) => `${label}：@${type}:姓名|情绪|正文`).join('\n');
  const rules = `[对话显示格式]
本规则只负责展示形式，不改变叙事视角、人物设定、剧情或用户角色控制权；不要为了套格式额外编造台词和心理活动。
叙述、动作和环境直接写普通段落。
${examples}
每条独占一行，行头和前两个 | 是固定分隔符，后面全部是正文。不加外层方括号，不用星号区分类型。
姓名使用稳定一致的称呼；只有用户角色的名字填 {{user}}，其他角色填各自姓名。未知人物用能稳定区分的称呼。
情绪不能为空，按语境使用简短自然的描述。可参考：${references}，也可使用更合适的描述。
Markdown 只负责排版。不要解释协议，不要把叙事正文放入代码围栏或生成完整 HTML 网页。
示例：
她放下杯子，轻轻点头。
@say:林雪|温和|先坐一会儿吧。
@think:林雪|担忧|他的脸色还是不太好。`;
  const extra = validateSupplement(supplement);
  return extra ? `[补充要求]\n${extra}\n\n${rules}` : rules;
}

export async function loadPromptSettings(db) {
  const config = await db.getAllConfig();
  const moodConfig = config.mood_config === undefined ? { groups: DEFAULT_MOOD_GROUPS }
    : normalizeMoodConfig(JSON.parse(config.mood_config));
  return { supplement: validateSupplement(config[PROMPT_SUPPLEMENT_KEY] ?? ''), groups: moodConfig.groups };
}

export async function buildInjectionPrompt(db) {
  return buildPrompt(await loadPromptSettings(db));
}
