import { AVATAR_POOL_SCOPE } from "./context.js?v=2.3.0";

const groups = [
  ['男性像素', 'm', ['墨发剑士', '银发长者', '棕发学者', '赤发旅人', '青发游侠']],
  ['女性像素', 'f', ['栗色短发', '红簪长发', '金色双辫', '棕色卷发', '淡紫短发', '青色卷发', '银发骑士', '金色发带', '绿衣旅人', '高髻编发', '栗色侧辫', '齐刘海短发', '金色马尾', '蔷薇长发', '银发游侠']],
  ['多色小人', 's', ['灰紫', '青绿', '陶红', '草绿', '藤紫', '琥珀', '赭石', '玫瑰', '靛蓝', '湖蓝']],
];

export const BUILTIN_PORTRAITS = groups.flatMap(([group, prefix, names]) => names.map((label, index) => {
  const file = prefix + String(index + 1).padStart(2, '0') + (prefix === 's' ? '.png' : '.webp');
  return { id: file, group, label, file };
}));

export async function listAvatarPool(db) {
  const uploads = await db.list(AVATAR_POOL_SCOPE);
  return [...BUILTIN_PORTRAITS, ...uploads.map(row => ({
    id: 'upload:' + row.displayName, group: '我上传的', label: row.fileName || row.displayName,
    uploadKey: row.displayName, mimeType: row.mimeType,
  }))];
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
