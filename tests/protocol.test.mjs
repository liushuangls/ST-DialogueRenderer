import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDialogueLine, buildPrompt, buildInjectionPrompt } from "../src/protocol.js?v=2.0.3";
import { DEFAULT_MOOD_GROUPS, normalizeMoodConfig } from "../src/config.js?v=2.0.3";

test('explicit types use only two separators and preserve body offsets, punctuation and Markdown', () => {
  const line = '  @say: Alice | 平静 |  _请按 [Enter]_ 或选择 A | B。  ';
  const parsed = parseDialogueLine(line);
  assert.equal(parsed.kind, 'dialogue'); assert.equal(parsed.type, 'say');
  assert.equal(parsed.name, 'Alice'); assert.equal(parsed.mood, '平静');
  assert.equal(parsed.text, '_请按 [Enter]_ 或选择 A | B。');
  assert.equal(line.slice(parsed.start, parsed.end), parsed.text);
  assert.equal(parseDialogueLine('@think:Alice|欲言又止|没有星号也明确是心理活动').type, 'think');
  assert.equal(parseDialogueLine('@say:Alice|平静|*这仍是台词*').type, 'say');
  assert.equal(parseDialogueLine('普通正文').kind, 'text');
  assert.equal(parseDialogueLine('@bubble:Alice|平静|[旧协议]').kind, 'text');
});

test('malformed protocol fields fail with specific reasons and unfinished tails remain pending', () => {
  for (const [line, reason] of [
    ['@say：Alice|平静|内容', /英文冒号/], ['@say:Alice|平静', /三个字段/],
    ['@say:|平静|内容', /姓名不能为空/], ['@say:Alice||内容', /情绪不能为空/],
    ['@think:Alice|平静| ', /正文不能为空/], ['@say:旁白|平静|环境', /普通段落/],
    ['@say:A|平静|第一行\n第二行', /独占一行/],
  ]) {
    const result = parseDialogueLine(line);
    assert.equal(result.kind, 'invalid'); assert.match(result.reason, reason);
  }
  assert.equal(parseDialogueLine('@think:Alice|', { incomplete: true }).kind, 'incomplete');
});

test('generated prompt is concise and carries one reference per mood without dictating the story', () => {
  const prompt = buildPrompt();
  assert.ok(prompt.length < 600);
  assert.match(prompt, /不改变叙事视角/);
  assert.match(prompt, /只有用户角色的名字填 \{\{user\}\}/);
  assert.match(prompt, /也可使用更合适的描述/);
  assert.doesNotMatch(prompt, /now_plot|<content>|@bubble|最高优先级/);
  for (const group of DEFAULT_MOOD_GROUPS) assert.ok(prompt.includes(group.words[0]));
  assert.equal(prompt.includes('心花怒放'), false);
  const custom = buildPrompt({ supplement: '自然简短。' });
  assert.ok(custom.startsWith('[补充要求]\n自然简短。\n\n'));
  assert.ok(custom.endsWith(prompt));
  for (const line of prompt.split('\n').filter(line => line.startsWith('@'))) assert.equal(parseDialogueLine(line).kind, 'dialogue');
});

test('local mood dictionaries reject ambiguous mappings and malformed saved configuration', async () => {
  const groups = DEFAULT_MOOD_GROUPS.map(group => ({ ...group, words: [...group.words] }));
  groups[1].words.push(groups[0].words[0]);
  assert.throws(() => normalizeMoodConfig({ groups }), /重复归属/);
  await assert.rejects(buildInjectionPrompt({ getAllConfig: async () => ({ mood_config: '{invalid' }) }));
  await assert.rejects(buildInjectionPrompt({ getAllConfig: async () => ({ prompt_supplement: 17 }) }), /必须是文本/);
});
