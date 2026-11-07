const DEFAULT_MOOD_GROUPS = Object.freeze([
  { id: 'mood-joy',     label: '喜悦', color: '#f59e0b', words: ['开心','欢喜','欣喜','愉悦','满足','幸福','甜蜜','狂喜','兴奋','雀跃','畅快','陶醉'] },
  { id: 'mood-anger',   label: '愤怒', color: '#ef4444', words: ['愤怒','暴怒','气愤','愤慨','暴躁','怨恨','敌意','恼火','窝火','生气','烦躁','烦闷'] },
  { id: 'mood-sad',     label: '悲伤', color: '#3b82f6', words: ['难过','伤心','心酸','忧伤','惆怅','失落','低落','沮丧','悲伤','心痛','悲痛','痛苦','委屈','不甘','失望','受伤','孤独','寂寞','落寞'] },
  { id: 'mood-anxious', label: '紧张', color: '#eab308', words: ['焦虑','紧张','不安','忐忑','担忧','慌张','焦躁','心慌','警惕','戒备'] },
  { id: 'mood-calm',    label: '平和', color: '#22c55e', words: ['平静','淡然','冷静','沉稳','从容','坦然','淡定','温馨','舒畅','惬意','温暖','欣慰','释然','感动','感恩'] },
  { id: 'mood-shy',     label: '害羞', color: '#06b6d4', words: ['害羞','尴尬','窘迫','难堪','羞涩','羞怯'] },
  { id: 'mood-disgust', label: '嫌弃', color: '#8b5cf6', words: ['厌恶','嫌弃','鄙视','反感','排斥','抗拒','不屑','冷淡','冷漠','疏离','麻木'] },
  { id: 'mood-love',    label: '爱恋', color: '#ec4899', words: ['喜欢','爱慕','迷恋','倾慕','宠溺','依恋','心动'] },
  { id: 'mood-surprise', label: '惊讶', color: '#f97316', words: ['惊讶','吃惊','震惊','错愕','诧异','惊愕'] },
  { id: 'mood-confused', label: '疑惑', color: '#14b8a6', words: ['疑惑','困惑','迷茫','犹豫','纠结','不解','纳闷','无奈','无语'] },
  { id: 'mood-fear',     label: '恐惧', color: '#a855f7', words: ['害怕','恐惧','惊恐','畏惧','胆怯','恐慌','惊惧'] },
  { id: 'mood-serious',  label: '严肃', color: '#64748b', words: ['认真','严肃','专注','坚定','凝重','郑重','坚决'] },
  { id: 'mood-tired',    label: '疲惫', color: '#a3a3a3', words: ['疲惫','疲倦','困倦','乏力','倦怠','疲乏','憔悴'] },
  { id: 'mood-proud',    label: '得意', color: '#d97706', words: ['得意','骄傲','自豪','自信','自满','傲然','得瑟'] },
]);

const STYLE_DEFAULTS = {
  style_dialogueFontSize: 14.5,
  style_narrationFontSize: 14,
  style_dialogueSpacing: 10,
  style_textColorMode: 'global',
  style_globalTextColor: '#d9d9d9',
  style_dialogueFontWeight: 400,
  style_narrationFontWeight: 400,
  style_nameFontWeight: 800,
  style_narrationBgColor: '#ffffff',
  style_narrationBgOpacity: 0,
  style_avatarSize: 52,
  style_narrationIndent: 16,
  style_narrationFontFamily: 'Noto Sans SC',
  style_dialogueFontFamily: 'Noto Serif SC',
  style_nameFontFamily: 'Noto Serif SC',
  style_fontConfigUrl: '',
  style_narrationBorderRadius: 0,
  style_avatarShape: 'rounded',
  style_globalAvatarFallback: true,
  style_narrationTextIndent: 2,
  style_narrationLineHeight: 1.75,
  style_narrationPaddingRight: 16,
  style_imageCompressEnabled: true,
  style_imageCompressQuality: 0.82,
};
const STYLE_CONFIG_KEYS = Object.freeze(Object.keys(STYLE_DEFAULTS));

const MOOD_GROUPS = DEFAULT_MOOD_GROUPS.map(({id,label,color}) => ({id,label,color}));

export function normalizeMoodConfig(config) {
  if (!config || !Array.isArray(config.groups) || !config.groups.length) {
    throw new Error('情绪配置必须包含非空 groups 数组');
  }
  const ids = new Set();
  const words = new Set();
  const groups = config.groups.map(group => {
    if (!group || !MOOD_GROUPS.some(item => item.id === group.id) || ids.has(group.id)
        || typeof group.label !== 'string' || !group.label.trim()
        || !/^#[\da-f]{6}$/i.test(group.color) || !Array.isArray(group.words) || !group.words.length) {
      throw new Error('情绪分组的标识、名称、颜色或词表无效');
    }
    ids.add(group.id);
    const normalized = group.words.map(word => {
      if (typeof word !== 'string' || !word.trim() || /[|\r\n]/.test(word)) {
        throw new Error('情绪词不能为空，也不能包含分隔符或换行');
      }
      const text = word.trim();
      if (words.has(text)) throw new Error(`情绪词「${text}」重复归属多个分组`);
      words.add(text);
      return text;
    });
    return { id: group.id, label: group.label.trim(), color: group.color, words: normalized };
  });
  return { groups };
}

const STYLE_CACHE_KEY = 'bubbleDialogueStyleSnapshotV8';
function readStyleSnapshot() {
  try {
    const raw = localStorage.getItem(STYLE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStyleSnapshot(settings, { replace = false } = {}) {
  try {
    const next = replace ? {} : readStyleSnapshot();
    STYLE_CONFIG_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(settings, key)) next[key] = settings[key];
    });
    localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify(next));
  } catch (_) {
    // ignore local cache errors
  }
}

function clearStyleSnapshot() {
  try {
    localStorage.removeItem(STYLE_CACHE_KEY);
  } catch (_) {
    // ignore local cache errors
  }
}

export { DEFAULT_MOOD_GROUPS, MOOD_GROUPS, STYLE_DEFAULTS, STYLE_CONFIG_KEYS, writeStyleSnapshot, clearStyleSnapshot };
