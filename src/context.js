const CHAR_ID_SEPARATOR = '__';
const GLOBAL_CHAR_ID = '_global_';
const STABLE_CHAR_ID_PREFIX = 'card_';

let contextProvider = null;

export function configureContext(provider) {
  if (provider !== null && typeof provider !== 'function') throw new Error('酒馆上下文提供者必须是函数');
  contextProvider = provider;
}

export function getCurrentContext() {
  if (!contextProvider) throw new Error('对话渲染系统尚未初始化酒馆上下文');
  return contextProvider();
}

export function getCurrentCharacterSyncScope() {
  const context = getCurrentContext();
  if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '') return null;
  const avatar = context.characters?.[context.characterId]?.avatar;
  return typeof avatar === 'string' && avatar.length ? 'character-avatar:' + avatar : null;
}

export function getAvatarSyncScopeForCharId(charId) {
  if (charId === GLOBAL_CHAR_ID) return 'global';
  if (!charId) return null;
  const scope = getCurrentCharacterSyncScope();
  return scope && charId === storageCharIdFromSyncScope(scope) ? scope : null;
}

function encodeStableStorageIdentity(value) {
  const text = String(value == null ? '' : value);
  let encoded = '';
  for (let i = 0; i < text.length; i++) {
    encoded += text.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return encoded;
}

function storageCharIdFromSyncScope(scope) {
  if (scope === 'global') return GLOBAL_CHAR_ID;
  if (typeof scope !== 'string' || !scope.startsWith('character-avatar:')) return '';
  return STABLE_CHAR_ID_PREFIX + encodeStableStorageIdentity(scope);
}

function getCurrentCharId() {
  return storageCharIdFromSyncScope(getCurrentCharacterSyncScope());
}

function getCurrentCharName() {
  return getCurrentContext().name2 || '未选择角色卡';
}

function requireAvatarStorageId(charId) {
  const value = String(charId == null ? '' : charId);
  if (!value) throw new Error('缺少角色卡稳定身份，已拒绝访问头像分区');
  return value;
}

function buildAvatarKey(charId, name) {
  const safeCharId = requireAvatarStorageId(charId);
  const safeName = name.trim().toLowerCase();
  return safeCharId + CHAR_ID_SEPARATOR + safeName;
}

function buildMoodAvatarKey(charId, name, moodId) {
  const safeCharId = requireAvatarStorageId(charId);
  const safeName = name.trim().toLowerCase();
  return safeCharId + CHAR_ID_SEPARATOR + safeName + CHAR_ID_SEPARATOR + moodId;
}

function buildColorConfigKey(charId, name) {
  const safeCharId = requireAvatarStorageId(charId);
  const safeName = name.trim().toLowerCase();
  return 'color_' + safeCharId + CHAR_ID_SEPARATOR + safeName;
}

function extractDisplayName(storedKey, charId) {
  // 有 charId 时精确切割
  if (charId != null) {
    const prefix = String(charId) + CHAR_ID_SEPARATOR;
    if (storedKey.startsWith(prefix)) return storedKey.slice(prefix.length);
  }
  // 尝试 _global_ 前缀
  const globalPrefix = GLOBAL_CHAR_ID + CHAR_ID_SEPARATOR;
  if (storedKey.startsWith(globalPrefix)) return storedKey.slice(globalPrefix.length);
  const sepIndex = storedKey.indexOf(CHAR_ID_SEPARATOR);
  if (sepIndex < 0) throw new Error('头像存储标识无效：' + storedKey);
  return storedKey.slice(sepIndex + CHAR_ID_SEPARATOR.length);
}

export { GLOBAL_CHAR_ID, CHAR_ID_SEPARATOR, storageCharIdFromSyncScope, getCurrentCharId, getCurrentCharName,
  requireAvatarStorageId, buildAvatarKey, buildMoodAvatarKey, buildColorConfigKey, extractDisplayName };
