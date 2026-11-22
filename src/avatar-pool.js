import { AVATAR_POOL_SCOPE } from "./context.js?v=2.4.0";

import { poolGroups, POOL_LAYOUT_KEY, UNGROUPED } from "./pool-groups.js?v=2.4.0";

const series = [
  ['simple', 's', ['灰紫', '青绿', '陶红', '草绿', '藤紫', '琥珀', '赭石', '玫瑰', '靛蓝', '湖蓝']],
  ['anime', 'anime', ['五条新菜', '姬野天音', '喜多川海梦', '乾纱寿叶', '乾心寿', '菅谷乃羽', '绪方旭', '本多都', '伊藤凉香', '八寻大空'], '更衣人偶坠入爱河'],
  ['anime', 'oshi', ['星野阿库亚', '鸣岛梅尔特', '星野爱', '星野露比', '有马加奈', '黑川茜', 'MEM啾', '不知火芙莉露', '寿美奈美', '齐藤美弥子'], '我推的孩子'],
  ['anime', 'dandan', ['高仓健', '圆城寺仁', '绫濑桃', '白鸟爱罗', '绫濑星子', 'Miko', 'Muko', '巴莫拉', '佐脇凛', '女王老师'], '胆大党'],
  ['anime', 'bokuyaba', ['市川京太郎', '足立翔', '山田杏奈', '关根萌子', '小林千寻', '吉田芹那', '市川香菜', '原穗乃香', '半泽百合音', '安堂环奈'], '我心里危险的东西'],
  ['anime', 'urusei', ['诸星当', '面堂终太郎', '拉姆', '三宅忍', '小兰', '阿雪', '弁天', '樱花老师', '藤波龙之介', '面堂了子'], '新版福星小子'],
  ['ghibli', 'ghibli', ['哈尔', '巴鲁', '荻野千寻', '草壁皋月', '菲奥', '辉夜姬', '玛妮', '佐佐木杏奈', '松崎海', '里见菜穗子'], '电影主角'],
  ['ghibli', 'ghero', ['白龙', '阿席达卡', '小桑', '年轻的苏菲', '琪琪', '娜乌西卡', '希达', '阿莉埃蒂', '月岛雯', '吉冈春'], '电影主角'],
  ['jrpg', 'jrpg', ['赛拉斯', '光', '欧菲莉亚', '普里姆萝洁', '特蕾莎', '海茵特', '爱格妮娅', '卡斯蒂', '斯洛妮', '欧修缇'], '八方旅人 Ⅰ・Ⅱ'],
];

export const BUILTIN_PORTRAITS = series.flatMap(([group, prefix, names, seriesName]) => names.map((label, index) => {
  const file = prefix + String(index + 1).padStart(2, '0') + (group === 'simple' ? '.png' : '.webp');
  return { id: file, group, label, file, series: seriesName };
}));

export async function listAvatarPool(db) {
  const uploads = await db.list(AVATAR_POOL_SCOPE);
  return [...BUILTIN_PORTRAITS, ...uploads.map(row => ({
    id: 'upload:' + row.displayName, group: row.poolGroup || UNGROUPED, label: row.fileName || row.displayName,
    uploadKey: row.displayName, mimeType: row.mimeType,
  }))];
}

export async function groupedAvatarPool(db) {
  const [items, settings] = await Promise.all([listAvatarPool(db), db.getConfig(POOL_LAYOUT_KEY, {})]);
  const groups = poolGroups(settings).map(group => ({ ...group, items: [] }));
  const byId = new Map(groups.map(group => [group.id, group]));
  const ungrouped = { id: UNGROUPED, name: '未分组', items: [] };
  for (const item of items) {
    const groupId = settings['item:' + item.id]?.value ?? item.group;
    (byId.get(groupId) || ungrouped).items.push(item);
  }
  if (ungrouped.items.length || !groups.length) groups.push(ungrouped);
  return groups;
}

// Rendezvous hashing is independent of list order. An added portrait competes
// only with the previous winner, instead of reshuffling every character.
export function pickPoolAvatar(pool, card, name) {
  const seed = JSON.stringify([card, name.normalize('NFKC').trim().toLowerCase()]);
  let best;
  let high = -1;
  for (const item of pool) {
    let hash = 2166136261;
    for (const ch of seed + '\0' + item.id) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    const score = (hash ^ (hash >>> 13)) >>> 0;
    if (score > high || (score === high && item.id < best.id)) {
      best = item;
      high = score;
    }
  }
  if (!best) throw new Error('头像池为空');
  return best;
}

export function builtinPortraitUrl(item) {
  const url = new URL('../assets/portraits/' + item.file, import.meta.url);
  url.search = new URL(import.meta.url).search;
  return url.href;
}

export async function poolPortraitUrl(db, item) {
  if (item.file) return builtinPortraitUrl(item);
  const url = await db.getBlobUrl(AVATAR_POOL_SCOPE, item.uploadKey);
  if (!url) throw new Error('头像池中已找不到「' + item.label + '」');
  return url;
}
