export const SETTINGS_KEY = 'dialogue_renderer';
export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, recentAiCount: 3 });

export function readSettings(value) {
  const enabled = value?.enabled ?? DEFAULT_SETTINGS.enabled;
  const recentAiCount = value?.recentAiCount ?? DEFAULT_SETTINGS.recentAiCount;
  if (typeof enabled !== 'boolean') throw new Error('对话渲染开关必须是布尔值');
  if (!Number.isInteger(recentAiCount) || recentAiCount < 1 || recentAiCount > 100) {
    throw new Error('最近 AI 回复数量必须是 1–100 的整数');
  }
  return { enabled, recentAiCount };
}

export function recentAiMessageIds(chat, count) {
  const ids = new Set();
  for (let i = chat.length - 1; i >= 0 && ids.size < count; i--) {
    const message = chat[i];
    if (!message || message.is_user || message.is_system || message.role === 'tool'
        || message.extra?.type === 'narrator') continue;
    ids.add(i);
  }
  return ids;
}
