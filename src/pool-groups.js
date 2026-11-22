// These IDs are storage identities; labels and order can change independently.
export const POOL_LAYOUT_KEY = 'avatar_pool_layout_v1';
export const UNGROUPED = 'ungrouped';
export const DEFAULT_GROUPS = [
  { id: 'simple', name: '简单头像', order: 0 },
  { id: 'anime', name: '动漫组', order: 1 },
  { id: 'ghibli', name: '吉卜力组', order: 2 },
  { id: 'jrpg', name: 'JRPG组', order: 3 },
  { id: 'real', name: '真人组', order: 4 },
];
const groupIdPattern = /^[a-z][a-z0-9-]*$/;

export function poolGroups(settings) {
  const groups = new Map(DEFAULT_GROUPS.map(group => [group.id, group]));
  for (const entry of Object.values(settings)) {
    if (!entry.id.startsWith('group:') || entry.value === null) continue;
    const id = entry.id.slice(6);
    if (entry.value === false) groups.delete(id);
    else groups.set(id, { id, ...entry.value });
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function validatePoolSetting(id, value) {
  if (typeof id !== 'string') throw new Error('头像池分组标识无效');
  if (id.startsWith('group:') && groupIdPattern.test(id.slice(6)) && id.slice(6) !== UNGROUPED) {
    if (value === null || value === false) return;
    if (value && typeof value.name === 'string' && value.name.trim() && value.name === value.name.trim() && Number.isSafeInteger(value.order)) return;
  } else if (id.startsWith('item:') && id.length > 5 && (value === null || (typeof value === 'string' && groupIdPattern.test(value)))) return;
  throw new Error('头像池分组配置无效：' + id);
}

export function groupEdits(settings, action, id, argument) {
  const groups = poolGroups(settings);
  const index = groups.findIndex(group => group.id === id);
  const group = groups[index];
  if (action === 'create' || action === 'rename') {
    const name = String(argument).trim();
    if (!name || groups.some(item => item.name === name && item.id !== id) || name === '未分组') throw new Error('请使用非空且不重复的组名');
    if (action === 'create' && index < 0) return { ['group:' + id]: { name, order: (groups.at(-1)?.order ?? -1) + 1 } };
    if (action === 'rename' && group) return { ['group:' + id]: { name, order: group.order } };
  }
  if (!group) throw new Error('分组已变更，请重新选择');
  if (action === 'delete') return { ['group:' + id]: false };
  if (action === 'up' || action === 'down') {
    const to = index + (action === 'up' ? -1 : 1);
    if (to < 0 || to >= groups.length) return {};
    [groups[index], groups[to]] = [groups[to], groups[index]];
    return Object.fromEntries(groups.flatMap((item, order) => item.order === order ? [] :
      [['group:' + item.id, { name: item.name, order }]]));
  }
  throw new Error('未知的分组操作');
}

export function poolSettingNewer(next, current) {
  return !current || next.updatedAt > current.updatedAt || (next.updatedAt === current.updatedAt && next.writer > current.writer);
}
