import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const main = { content: fs.readFileSync(new URL('../src/avatar-manager.js', import.meta.url), 'utf8') };
const prefix = main.content.slice(0, main.content.lastIndexOf('\nexport {'));

async function device(writer, files = new Map(), options = {}) {
  const storage = new Map();
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    console, Blob, URL, TextEncoder, TextDecoder, IDBKeyRange, crypto: webcrypto, AbortController, atob,
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(buffer => {
          this.result = 'data:' + blob.type + ';base64,' + Buffer.from(buffer).toString('base64');
          this.onload?.(); this.onloadend?.();
        }, error => { this.error = error; this.onerror?.(); });
      }
    },
    indexedDB: options.indexedDB || new IDBFactory(),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, val) => storage.set(key, val), removeItem: key => storage.delete(key) },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    window: {}, document: {},
  });
  vm.runInContext(prefix + '\nglobalThis.testAPI={AvatarDB,AvatarSyncV8,GlobalStyleSyncV8,AvatarManagerPanel,DEFAULT_FORMAT_RULE,DEFAULT_MOOD_GROUPS,MOOD_GROUPS,normalizeMoodConfig,upgradeMoodConfig,upgradePromptText,upgradePromptConfig,buildInjectionPrompt,zipExtract,zipCreate,buildColorConfigKey};', context);
  const api = context.testAPI;
  const db = new api.AvatarDB();
  await db.init();
  if (options.seed) for (const [key, value] of Object.entries(options.seed)) await db.setConfig(key, value);
  const transport = new api.AvatarSyncV8(db);
  transport.writerId = writer;
  const uploads = [];
  const downloads = [];
  let offline = false;
  transport._fetchWithTimeout = async url => {
    if (offline) throw new Error('offline');
    if (options.onFetch) await options.onFetch(url);
    const path = url.split('?')[0];
    downloads.push(path);
    const blob = files.get(path);
    return blob ? new Response(blob) : new Response('', { status: 404 });
  };
  transport._uploadBlob = async (name, blob) => {
    if (offline) throw new Error('offline');
    if (options.onUpload) await options.onUpload(name);
    uploads.push(name);
    const path = '/user/files/' + name;
    files.set(path, blob);
    return path;
  };
  let applied = 0;
  const sync = new api.GlobalStyleSyncV8(db, transport, async () => { applied++; });
  return { db, transport, sync, api, context, files, storage, uploads, downloads, timers,
    get applied() { return applied; }, setOffline(value) { offline = value; },
    stop() { sync.destroy(); transport.destroy(); db.db.close(); },
  };
}

test('8-group migration moves misplaced words, preserves custom colors and is idempotent', async () => {
  const d = await device('A');
  const old = { groups: [{ id:'mood-love',label:'爱恋',color:'#123456',words:['心动','认真','自定义'] },
    { id:'mood-shy',label:'害羞',color:'#abcdef',words:['害羞','困惑','无语'] },
    { id:'mood-joy',label:'喜悦',color:'#f59e0b',words:['开心','得意'] }] };
  const upgraded = d.api.normalizeMoodConfig(old);
  assert.equal(upgraded.groups.length,14);
  assert.equal(upgraded.groups.find(g=>g.id==='mood-love').color,'#123456');
  assert.deepEqual([...upgraded.groups.find(g=>g.id==='mood-love').words],['心动','自定义']);
  assert.ok(upgraded.groups.find(g=>g.id==='mood-confused').words.includes('困惑'));
  assert.ok(upgraded.groups.find(g=>g.id==='mood-proud').words.includes('得意'));
  assert.deepEqual(d.api.normalizeMoodConfig(upgraded),upgraded);
  await d.db.setConfig('mood_config',JSON.stringify(old));
  const prompt=await d.api.buildInjectionPrompt(d.db);
  assert.ok(prompt.includes('疲惫组'));
  assert.ok(prompt.includes('用户（{{user}}）与其他角色采用完全相同的头像规则'));
  assert.ok(prompt.includes('角色完整姓名固定填写 {{user}}'));
  assert.doesNotMatch(prompt, /用户（\{\{user\}\}）的发言和心理活动保持普通正文/);
  d.stop();
});

test('saved and imported v8 rules migrate only the former user-without-avatar sentence', async () => {
  const d = await device('user-rule');
  try {
    const legacy = '用户（{{user}}）的发言和心理活动保持普通正文，不加角色头像标记。';
    const custom = '自定义前缀\n8. ' + legacy + '\n自定义后缀';
    await d.db.setConfig('format_rule', custom);
    assert.equal(await d.api.upgradePromptConfig(d.db), true);
    const upgraded = await d.db.getConfig('format_rule');
    assert.ok(upgraded.startsWith('自定义前缀\n8. '));
    assert.ok(upgraded.endsWith('\n自定义后缀'));
    assert.ok(upgraded.includes('与其他角色采用完全相同的头像规则'));
    assert.equal(upgraded.includes(legacy), false);
    assert.equal(await d.api.upgradePromptConfig(d.db), false);
    const untouched = '我的自定义规则：只有特定场景使用 @bubble。';
    assert.equal(d.api.upgradePromptText(untouched), untouched);

    const oldTemplate = new Blob([JSON.stringify({
      type: 'bubble-template', version: '8.0', formatRule: custom,
      moodConfig: { version: '8.0', taxonomyVersion: 2, groups: d.api.DEFAULT_MOOD_GROUPS },
    })]);
    const imported = await d.db.importFromFile(oldTemplate, '_global_');
    assert.equal(imported.imported, 1);
    const importedRule = await d.db.getConfig('format_rule');
    assert.equal(importedRule.includes(legacy), false);
    assert.ok(importedRule.includes('自定义前缀'));
    const exported = await d.db.exportTemplate();
    assert.equal(exported.formatRule, importedRule);
  } finally { d.stop(); }
});

test('default injected mood guidance allows free descriptions with base avatars', async () => {
  const d = await device('mood-defaults');
  try {
    assert.equal(await d.api.upgradePromptConfig(d.db), false);
    assert.deepEqual(Object.keys(await d.db.getAllConfig()), []);
    const prompt = await d.api.buildInjectionPrompt(d.db);
    assert.match(prompt, /优先参考词池/);
    assert.match(prompt, /没有合适的词时允许使用简短的自由描述/);
    assert.match(prompt, /池外词使用基础头像/);
    assert.match(prompt, /不要为了匹配头像硬凑情绪/);
    assert.match(prompt, /情绪字段不能为空/);
    assert.match(prompt, /平和组：平静、/);
    assert.doesNotMatch(prompt, /必须从情绪词池|必须从以下固定池|禁止自造新词|2-3字词/);
  } finally { d.stop(); }
});

test('legacy mood rules upgrade in saved settings, injection, panel and template import without losing custom text', async () => {
  const d = await device('mood-migration');
  try {
    const oldRule = '自定义格式前缀\n3. 角色台词和心理活动的情绪都不能为空，且必须从情绪词池中选取。\n自定义格式后缀';
    const oldMoodTemplate = '自定义情绪前缀\n[情绪词约束]\n对话格式中情绪字段必须从以下固定池中选取（2-3字词），禁止自造新词：\n{{mood_groups}}\n自定义情绪后缀';
    const moodConfig = JSON.stringify({ version: '8.0', taxonomyVersion: 2,
      groups: [{ id: 'mood-calm', label: '我的分组', color: '#123456', words: ['自定义词'] }] });
    await d.db.setConfig('format_rule', oldRule);
    await d.db.setConfig('mood_prompt_template', oldMoodTemplate);
    await d.db.setConfig('mood_config', moodConfig);

    // Reads must use upgraded text even before the startup persistence step runs.
    const prompt = await d.api.buildInjectionPrompt(d.db);
    assert.doesNotMatch(prompt, /必须从情绪词池|必须从以下固定池|禁止自造新词/);
    for (const text of ['自定义格式前缀', '自定义格式后缀', '自定义情绪前缀', '自定义情绪后缀', '我的分组组：自定义词']) {
      assert.ok(prompt.includes(text), 'missing custom text: ' + text);
    }
    const panel = new d.api.AvatarManagerPanel(d.db);
    panel._renderMoodConfigContent = () => {};
    panel._bindMoodConfigEvents = () => {};
    await panel._loadMoodConfigTab();
    assert.match(panel._formatRuleDraft, /允许使用简短的自由描述/);
    assert.match(panel._moodPromptTemplateDraft, /池外词使用基础头像/);
    assert.ok(panel._moodPromptTemplateDraft.includes('{{mood_groups}}'));

    let writes = 0;
    const setConfig = d.db.setConfig.bind(d.db);
    d.db.setConfig = async (...args) => { writes++; return setConfig(...args); };
    vm.runInContext('_injectionCache = "stale prompt";', d.context);
    assert.equal(await d.api.upgradePromptConfig(d.db), true);
    assert.equal(writes, 2);
    assert.equal(await d.api.buildInjectionPrompt(d.db), prompt);
    assert.equal(await d.api.upgradePromptConfig(d.db), false);
    assert.equal(writes, 2);
    assert.equal(await d.db.getConfig('mood_config'), moodConfig);

    const oldTemplate = new Blob([JSON.stringify({ type: 'bubble-template', version: '8.0', formatRule: oldRule })]);
    const imported = await d.db.importFromFile(oldTemplate, '_global_');
    assert.equal(imported.imported, 1);
    const exported = await d.db.exportTemplate();
    assert.match(exported.formatRule, /允许使用简短的自由描述/);
    assert.ok(exported.formatRule.startsWith('自定义格式前缀\n3. '));
    assert.ok(exported.formatRule.endsWith('\n自定义格式后缀'));
    assert.equal(JSON.stringify(exported.moodConfig), moodConfig);

    const untouched = '我的规则：优先选择符合语境的情绪；保留 {{mood_groups}}。';
    assert.equal(d.api.upgradePromptText(untouched), untouched);
    assert.equal(d.api.upgradePromptText(null), null);
    assert.equal(d.api.upgradePromptText(''), '');
  } finally { d.stop(); }
});

test('new device receives global styles and cache; no-change refresh does not upload', async () => {
  const a=await device('A');
  await a.db.setConfig('style_avatarSize',120);
  await a.db.setConfig('style_narrationFontSize',21);
  await a.db.setConfig('style_globalTextColor','#abcdef');
  await a.sync.refresh();
  assert.equal(a.uploads.length,1);
  const b=await device('B',a.files);
  await b.sync.refresh();
  assert.equal(await b.db.getConfig('style_avatarSize'),120);
  assert.equal(await b.db.getConfig('style_narrationFontSize'),21);
  assert.equal(JSON.parse(b.storage.get('bubbleDialogueStyleSnapshotV8')).style_globalTextColor,'#abcdef');
  assert.equal(b.applied,1);
  let commits=0;
  const originalCommit=b.sync._commit.bind(b.sync);
  b.sync._commit=(...args)=>{commits++;return originalCommit(...args);};
  await b.sync.refresh();
  assert.equal(b.uploads.length,0);
  assert.equal(commits,0);
  assert.equal(b.applied,1);
  await a.db.setConfig('style_avatarSize',120);
  await a.sync.refresh();
  assert.equal(a.uploads.length,1);
  a.stop();b.stop();
});

test('old saved values seed once; an incoming configuration wins over unversioned local values', async () => {
  const a=await device('A',new Map(),{seed:{style_avatarSize:100}});
  await a.sync.refresh();
  const b=await device('B',a.files,{seed:{style_avatarSize:52,style_narrationTextIndent:3}});
  await b.sync.refresh();
  assert.equal(await b.db.getConfig('style_avatarSize'),100);
  await a.sync.refresh();
  assert.equal(await a.db.getConfig('style_narrationTextIndent'),3);
  const count=a.uploads.length+b.uploads.length;
  await b.sync.refresh();await a.sync.refresh();
  assert.equal(a.uploads.length+b.uploads.length,count);
  a.stop();b.stop();
});

test('separate field changes merge, and resets/false values propagate', async () => {
  const a=await device('A');const b=await device('B',a.files);
  await a.db.setConfig('style_narrationFontSize',20);await a.sync.refresh();await b.sync.refresh();
  await a.db.setConfig('style_globalTextColor','#112233');
  await b.db.setConfig('style_narrationFontSize',24);
  await a.sync.refresh();await b.sync.refresh();await a.sync.refresh();
  assert.equal(await a.db.getConfig('style_narrationFontSize'),24);
  assert.equal(await b.db.getConfig('style_globalTextColor'),'#112233');
  await a.db.setConfig('style_globalAvatarFallback',false);
  await a.db.setConfig('style_narrationTextIndent',0);
  await a.db.setConfig('style_fontConfigUrl','');
  await a.sync.refresh();await b.sync.refresh();
  assert.equal(await b.db.getConfig('style_globalAvatarFallback'),false);
  assert.equal(await b.db.getConfig('style_narrationTextIndent'),0);
  assert.equal(await b.db.getConfig('style_fontConfigUrl'),'');
  a.stop();b.stop();
});

test('offline edits survive script restart in IndexedDB and synchronize later', async () => {
  const indexedDB=new IDBFactory();
  const a=await device('A',new Map(),{indexedDB});
  a.setOffline(true);
  await a.db.setConfig('style_avatarSize',117);
  await assert.rejects(a.sync.refresh(),/offline/);
  assert.equal(a.sync.getStatus().state,'error');
  a.stop();
  const resumed=await device('A',a.files,{indexedDB});
  await resumed.sync.refresh();
  const b=await device('B',a.files);await b.sync.refresh();
  assert.equal(await b.db.getConfig('style_avatarSize'),117);
  resumed.stop();b.stop();
});

test('local font bytes, CSS sources and font deletion sync; unrelated prompt/color keys stay local', async () => {
  const a=await device('A');
  const font=new Blob(['test-font-bytes'],{type:'font/woff2'});
  await a.db.addLocalFont('测试字体',font,{fileName:'test.woff2'});
  await a.db.setConfig('style_narrationFontFamily','测试字体');
  await a.db.setConfig('style_cssFontUrls',JSON.stringify([{url:'https://example.com/fonts.css',families:['Remote']} ]));
  await a.db.setConfig('format_rule','private format');
  await a.db.setConfig('color_card_example__alice','#aabbcc');
  await a.sync.refresh();
  assert.equal(a.uploads.filter(x=>x.startsWith('bdv8_font_')).length,1);
  const b=await device('B',a.files);await b.sync.refresh();
  assert.equal(await (await b.db.getLocalFont('测试字体')).fontBlob.text(),'test-font-bytes');
  assert.equal(await b.db.getConfig('style_narrationFontFamily'),'测试字体');
  assert.ok((await b.db.getConfig('style_cssFontUrls')).includes('fonts.css'));
  assert.equal(await b.db.getConfig('format_rule'),null);
  assert.equal(await b.db.getConfig('color_card_example__alice'),null);
  await b.db.deleteLocalFont('测试字体');await b.sync.refresh();await a.sync.refresh();
  assert.equal(await a.db.getLocalFont('测试字体'),null);
  await a.sync.refresh();await b.sync.refresh();
  assert.equal(await b.db.getLocalFont('测试字体'),null);
  assert.equal(a.uploads.filter(x=>x.startsWith('bdv8_font_')).length,1);
  a.stop();b.stop();
});

test('clear-all creates reset entries and font tombstones', async () => {
  const a=await device('A');const b=await device('B',a.files);
  await a.db.setConfig('style_avatarSize',120);
  await a.db.addLocalFont('Test',new Blob(['font']),{fileName:'test.woff2'});
  await a.sync.refresh();await b.sync.refresh();
  await a.db.clearAll();await a.sync.refresh();await b.sync.refresh();
  assert.equal(await b.db.getConfig('style_avatarSize'),52);
  assert.equal(await b.db.getLocalFont('Test'),null);
  a.stop();b.stop();
});

test('malformed remote documents fail visibly and do not overwrite local state', async () => {
  const a=await device('A');
  await a.db.setConfig('style_avatarSize',80);
  a.files.set('/user/files/bdv8_global_style_v1.json',new Blob(['{"schema":"bad","entries":{}}']));
  await assert.rejects(a.sync.refresh(),/格式不匹配/);
  assert.equal(await a.db.getConfig('style_avatarSize'),80);
  assert.equal(a.uploads.length,0);
  assert.equal(a.sync.getStatus().state,'error');
  a.stop();
});

test('font corruption aborts before any remote styles are applied', async () => {
  const a=await device('A');
  await a.db.addLocalFont('Test',new Blob(['font']),{fileName:'test.woff2'});
  await a.db.setConfig('style_avatarSize',120);await a.sync.refresh();
  const fontPath=[...a.files.keys()].find(x=>x.includes('bdv8_font_'));
  a.files.set(fontPath,new Blob(['evil']));
  const b=await device('B',a.files);
  await assert.rejects(b.sync.refresh(),/校验失败/);
  assert.equal(await b.db.getConfig('style_avatarSize'),null);
  assert.equal(await b.db.getLocalFont('Test'),null);
  a.stop();b.stop();
});

test('late upload completion cannot erase a newer local edit', async () => {
  let release, started;
  const blocked=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{started=resolve;});
  let once=true;
  const a=await device('A',new Map(),{onUpload:async name=>{
    if(once&&name==='bdv8_global_style_v1.json'){once=false;started();await blocked;}
  }});
  await a.db.setConfig('style_avatarSize',80);
  const running=a.sync.refresh();await entered;
  await a.db.setConfig('style_avatarSize',120);
  release();await running;await a.sync.refresh();
  const b=await device('B',a.files);await b.sync.refresh();
  assert.equal(await b.db.getConfig('style_avatarSize'),120);
  a.stop();b.stop();
});

test('style and avatar sync status subscriptions are wired to the panel', async () => {
  const a=await device('A');
  const panel=new a.api.AvatarManagerPanel(a.db,a.transport,a.sync);
  a.transport._setStatus('synced','avatar done');
  a.sync._setStatus('synced','style done');
  assert.equal(panel._avatarSyncStatus.text,'avatar done');
  assert.equal(panel._styleSyncStatus.text,'style done');
  panel._avatarSyncUnsubscribe();panel._styleSyncUnsubscribe();a.stop();
});

test('editing one field in an open panel preserves a different field received from another device', async () => {
  const a=await device('A');
  await a.db.setConfig('style_avatarSize',52);
  const panel=new a.api.AvatarManagerPanel(a.db,a.transport,a.sync);
  panel._styleSavedBaseline={style_avatarSize:52,style_globalTextColor:'#ffffff'};
  panel._getLiveStyleSettings=()=>({style_avatarSize:120,style_globalTextColor:'#ffffff'});
  panel._loadStyleSettings=async()=>{};
  await a.db.setConfig('style_globalTextColor','#112233');
  await panel._saveCurrentStyleSettings();
  assert.equal(await a.db.getConfig('style_avatarSize'),120);
  assert.equal(await a.db.getConfig('style_globalTextColor'),'#112233');
  panel._avatarSyncUnsubscribe();panel._styleSyncUnsubscribe();a.stop();
});

test('opening an existing v8 database preserves avatar/style/font records and leaves old CG bytes untouched', async () => {
  const indexedDB = new IDBFactory();
  const records = {
    avatars: { alias: '_global___alice', imageBlob: new Blob(['avatar-bytes']) },
    config: { key: 'style_avatarSize', value: 120 },
    local_fonts: { id: 'local__Test', family: 'Test', fontBlob: new Blob(['font-bytes']) },
    mood_avatars: { id: 'existing-mood', alias: 'alice', moodId: 'mood-proud', imageBlob: new Blob(['mood-bytes']) },
    cg_groups: { id: 'cg_group__old', group: 'old', count: 1 },
    cg_images: { id: 'cg__old__1', group: 'old', imageBlob: new Blob(['old-cg-bytes']) },
  };
  const connection = await new Promise((resolve, reject) => {
    const req = indexedDB.open('BubbleDialogueAvatarsV8', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, record] of Object.entries(records)) {
        const keyPath = name === 'avatars' ? 'alias' : name === 'config' ? 'key' : 'id';
        const store = db.createObjectStore(name, { keyPath });
        if (name === 'avatars') store.createIndex('createdAt', 'createdAt');
        if (name === 'mood_avatars') for (const key of ['charId', 'alias', 'moodId']) store.createIndex(key, key);
        if (name === 'cg_images') store.createIndex('group', 'group');
        store.put(record);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  connection.close();
  const d = await device('A', new Map(), { indexedDB });
  try {
    assert.equal(d.db.db.version, 1);
    assert.deepEqual([...d.db.db.objectStoreNames], Object.keys(records).sort());
    for (const [name, expected] of Object.entries(records)) {
      const actual = await d.db._getByKey(name, expected.alias && name === 'avatars' ? expected.alias : expected.key || expected.id);
      for (const [key, value] of Object.entries(expected)) {
        if (value instanceof Blob) assert.equal(await actual[key].text(), await value.text());
        else assert.deepEqual(actual[key], value);
      }
    }
    assert.equal(await d.db.getConfig('style_avatarSize'), 120);
  } finally { d.stop(); }
});

test('avatar and mood JSON/ZIP round trips work without CG stores', async () => {
  const a = await device('A');
  const b = await device('B');
  const c = await device('C');
  try {
    const scope = '_global_';
    await a.db.add(scope, 'Alice', new Blob(['base-avatar'], { type: 'image/png' }), {
      fileName: 'alice.png', sourceUrl: 'https://example.invalid/alice.png',
    });
    await a.db.addMoodAvatar(scope, 'Alice', 'mood-proud', new Blob(['proud-avatar'], { type: 'image/png' }), {
      fileName: 'proud.png', sourceUrl: 'https://example.invalid/proud.png',
    });
    const colorKey = a.api.buildColorConfigKey(scope, 'Alice');
    await a.db.setConfig(colorKey, '#123456');
    const payload = await a.db.exportCharacterData(scope, { urlOnly: true });
    assert.equal('cgGroups' in payload, false);
    assert.equal(payload.avatars.length, 1);
    assert.equal(payload.moodAvatars.length, 1);
    const importedJson = await b.db.importFromFile(new Blob([JSON.stringify(payload)]), scope);
    assert.equal(importedJson.imported, 2);
    assert.equal(importedJson.errors.length, 0);
    assert.equal((await b.db.get(scope, 'Alice')).sourceUrl, 'https://example.invalid/alice.png');
    assert.equal((await b.db.getMoodAvatar(scope, 'Alice', 'mood-proud')).sourceUrl, 'https://example.invalid/proud.png');
    assert.equal(await b.db.getConfig(colorKey), '#123456');

    let archive;
    a.db._downloadZipFile = blob => { archive = blob; };
    await a.db.exportCharacterDataToFile(scope);
    const entries = a.api.zipExtract(await archive.arrayBuffer());
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
    assert.equal('cgGroups' in manifest, false);
    assert.equal(entries.size, 3);
    assert.equal([...entries.keys()].some(path => path.startsWith('cg/')), false);
    const importedZip = await c.db.importFromFile(archive, scope);
    assert.equal(importedZip.imported, 2);
    assert.equal(importedZip.errors.length, 0);
    assert.equal(await (await c.db.get(scope, 'Alice')).imageBlob.text(), 'base-avatar');
    assert.equal(await (await c.db.getMoodAvatar(scope, 'Alice', 'mood-proud')).imageBlob.text(), 'proud-avatar');
    assert.equal(await c.db.getConfig(colorKey), '#123456');
  } finally { a.stop(); b.stop(); c.stop(); }
});

test('synced URL-only records export real ZIP bytes and restore on an offline device without mutating the source', async () => {
  const a = await device('source');
  const b = await device('synced', a.files);
  const c = await device('offline');
  try {
    const png = new Blob(['shared-png-bytes'], { type: 'image/png' });
    await a.db.add('_global_', 'Alice', png);
    await a.db.addMoodAvatar('_global_', 'Alice', 'mood-proud', png);
    await a.transport.flushNow();
    await b.transport.refreshCurrentScope({ publishLocal: false });
    const before = await b.db.get('_global_', 'Alice');
    assert.equal(before.imageBlob, null);
    assert.match(before.syncedUrl, /^\/user\/files\/bdv8_/);
    const requests = [];
    b.context.fetch = async (url, options) => {
      requests.push(url); assert.equal(options.credentials, 'same-origin');
      assert.ok(options.signal); assert.ok(a.files.has(url));
      return new Response(a.files.get(url));
    };
    c.context.fetch = () => { throw new Error('Offline import must not fetch'); };
    let archive;
    b.db._downloadZipFile = blob => { archive = blob; };
    await b.db.exportCharacterDataToFile('_global_');
    assert.deepEqual(requests, [before.syncedUrl], 'same asset downloaded once for avatar and mood');
    const entries = b.api.zipExtract(await archive.arrayBuffer());
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
    assert.equal(entries.size, 3);
    for (const item of [...manifest.avatars, ...manifest.moodAvatars]) {
      assert.ok(item.zipPath.endsWith('.png'));
      assert.equal(item.mimeType, 'image/png'); assert.equal(item.fileSize, png.size);
      assert.equal(new TextDecoder().decode(entries.get(item.zipPath)), 'shared-png-bytes');
    }
    assert.deepEqual(await b.db.get('_global_', 'Alice'), before);
    assert.equal(b.transport.pendingByScope.size, 0);
    assert.equal([...b.timers.values()].some(timer => timer.ms === 30000), false);
    const imported = await c.db.importFromFile(archive, '_global_');
    assert.equal(imported.imported, 2); assert.equal(imported.linked, 0); assert.equal(imported.errors.length, 0);
    assert.equal(await (await c.db.get('_global_', 'Alice')).imageBlob.text(), 'shared-png-bytes');
    assert.equal(await (await c.db.getMoodAvatar('_global_', 'Alice', 'mood-proud')).imageBlob.text(), 'shared-png-bytes');
  } finally { a.stop(); b.stop(); c.stop(); }
});

test('complete JSON resolves remote bytes; explicit URL-only export remains offline and local-only images stay embedded', async () => {
  const a = await device('json'); const b = await device('json-offline');
  try {
    await a.db.add('_global_', 'Remote', null, { sourceUrl: 'https://images.invalid/shared.png', mimeType: 'image/webp' });
    await a.db.addMoodAvatar('_global_', 'Remote', 'mood-tired', null, { syncedUrl: '/user/files/bdv8_12345678.png', mimeType: 'image/png' });
    await a.db.add('_global_', 'Local', new Blob(['cached'], { type: 'image/png' }));
    a.context.fetch = () => { throw new Error('URL-only export must not fetch'); };
    const links = await a.db.exportCharacterData('_global_', { urlOnly: true });
    assert.equal(links.avatars.find(item => item.name === 'remote').imageBase64, null);
    assert.equal(links.moodAvatars[0].imageBase64, null);
    assert.equal(Buffer.from(links.avatars.find(item => item.name === 'local').imageBase64, 'base64').toString(), 'cached');
    a.context.fetch = async url => new Response(new Blob([url.startsWith('https:') ? 'remote' : 'synced'], { type: 'image/png' }));
    const complete = await a.db.exportCharacterData('_global_');
    assert.equal(complete.avatars.find(item => item.name === 'remote').mimeType, 'image/png');
    b.context.fetch = () => { throw new Error('Offline import must not fetch'); };
    const result = await b.db.importFromFile(new Blob([JSON.stringify(complete)]), '_global_');
    assert.equal(result.imported, 3); assert.equal(result.errors.length, 0); assert.equal(result.linked, 0);
    assert.equal(await (await b.db.get('_global_', 'Remote')).imageBlob.text(), 'remote');
    assert.equal(await (await b.db.getMoodAvatar('_global_', 'Remote', 'mood-tired')).imageBlob.text(), 'synced');
  } finally { a.stop(); b.stop(); }
});

test('cached images take priority; generic binary responses use saved MIME and export only the selected scope', async () => {
  const d = await device('precedence');
  try {
    await d.db.add('_global_', 'Cached', new Blob(['cached'], { type: 'image/png' }), { syncedUrl: '/user/files/not-requested.png', sourceUrl: 'https://invalid.test/not-requested.png' });
    await d.db.add('_global_', 'Binary', null, { sourceUrl: 'https://images.invalid/binary', mimeType: 'image/png' });
    await d.db.add('another-scope', 'Other', new Blob(['other'], { type: 'image/png' }));
    const requests = [];
    d.context.fetch = async url => { requests.push(url); return new Response(new Blob(['binary'], { type: 'application/octet-stream' })); };
    let archive; d.db._downloadZipFile = blob => { archive = blob; };
    await d.db.exportCharacterDataToFile('_global_');
    assert.deepEqual(requests, ['https://images.invalid/binary']);
    const entries = d.api.zipExtract(await archive.arrayBuffer());
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
    assert.deepEqual(manifest.avatars.map(item => item.name), ['binary', 'cached']);
    assert.ok(manifest.avatars.every(item => item.mimeType === 'image/png' && item.zipPath.endsWith('.png')));
  } finally { d.stop(); }
});

test('unavailable, empty and non-image export assets abort instead of downloading an incomplete backup', async () => {
  for (const [response, expected] of [
    [() => new Response('', { status: 404 }), /HTTP 404/],
    [() => { throw new Error('offline'); }, /offline/],
    [() => new Response(new Blob([], { type: 'image/png' })), /为空/],
    [() => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }), /不是图片/],
  ]) {
    const d = await device('failure');
    try {
      await d.db.add('_global_', 'Alice', null, { sourceUrl: 'https://images.invalid/a.png' });
      d.context.fetch = async () => response();
      let downloads = 0; d.db._downloadZipFile = () => { downloads++; };
      for (const exporter of [() => d.db.exportCharacterDataToFile('_global_'), () => d.db.exportCharacterData('_global_')]) {
        await assert.rejects(exporter, error => /头像“alice”/.test(error.message) && expected.test(error.message));
      }
      assert.equal(downloads, 0);
      assert.equal((await d.db.get('_global_', 'Alice')).imageBlob, null);
      assert.equal([...d.timers.values()].some(timer => timer.ms === 30000), false);
    } finally { d.stop(); }
  }
});

test('export timeout includes reading the response body and releases its timer', async () => {
  const d = await device('timeout');
  try {
    await d.db.addMoodAvatar('_global_', 'Alice', 'mood-tired', null, { sourceUrl: 'https://images.invalid/hang.png' });
    let bodyStarted;
    const ready = new Promise(resolve => { bodyStarted = resolve; });
    d.context.fetch = async (_url, { signal }) => ({ ok: true, blob: () => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted'))); bodyStarted();
    }) });
    const pending = d.db.exportCharacterDataToFile('_global_');
    const rejected = assert.rejects(pending, /表情头像“alice \/ mood-tired”：读取图片超时/);
    await ready;
    [...d.timers.values()].find(timer => timer.ms === 30000).fn();
    await rejected;
    assert.equal([...d.timers.values()].some(timer => timer.ms === 30000), false);
  } finally { d.stop(); }
});

function characterArchive(d, manifest, images = []) {
  return d.api.zipCreate([{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({
    type: 'bubble-character', version: '8.0-zip', ...manifest,
  })) }, ...images]);
}

test('missing or empty declared ZIP images fail before writes, even when a fallback URL exists', async () => {
  for (const empty of [false, true]) {
    const d = await device('bad-zip');
    try {
      await d.db.add('_global_', 'Existing', new Blob(['original'], { type: 'image/png' }));
      const archive = characterArchive(d, { avatars: [{ name: 'Existing', zipPath: 'valid.png', mimeType: 'image/png' }],
        moodAvatars: [{ name: 'Existing', moodId: 'mood-tired', zipPath: 'missing.png', imageUrl: 'https://images.invalid/fallback.png' }],
        colors: { existing: '#123456' } }, [{ name: 'valid.png', data: new TextEncoder().encode('replacement') },
        ...(empty ? [{ name: 'missing.png', data: new Uint8Array() }] : [])]);
      await assert.rejects(d.db.importFromFile(archive, '_global_'), /备份图片缺失或为空/);
      assert.equal(await (await d.db.get('_global_', 'Existing')).imageBlob.text(), 'original');
      assert.equal(await d.db.getMoodAvatar('_global_', 'Existing', 'mood-tired'), null);
      assert.equal(await d.db.getConfig(d.api.buildColorConfigKey('_global_', 'Existing')), null);
    } finally { d.stop(); }
  }
});

test('ZIP shared image references import both records; CRC corruption is rejected', async () => {
  const d = await device('shared-zip');
  try {
    const manifest = { avatars: [{ name: 'Alice', zipPath: 'shared.png', mimeType: 'image/png' }],
      moodAvatars: [{ name: 'Alice', moodId: 'mood-proud', zipPath: 'shared.png', mimeType: 'image/png' }] };
    const archive = characterArchive(d, manifest, [{ name: 'shared.png', data: new TextEncoder().encode('UNIQUE_PNG_TEST_BYTES') }]);
    const result = await d.db.importFromFile(archive, '_global_');
    assert.equal(result.imported, 2); assert.equal(result.errors.length, 0); assert.equal(result.linked, 0);
    assert.equal(await (await d.db.getMoodAvatar('_global_', 'Alice', 'mood-proud')).imageBlob.text(), 'UNIQUE_PNG_TEST_BYTES');
    const bytes = Buffer.from(await archive.arrayBuffer());
    bytes[bytes.indexOf('UNIQUE_PNG_TEST_BYTES')] ^= 1;
    await assert.rejects(d.db.importFromFile(new Blob([bytes]), '_global_'), /CRC32 校验失败/);
  } finally { d.stop(); }
});

test('JSON and ZIP imports replace stale avatar/mood caches, warn on links, and detach old URLs for embedded images', async () => {
  for (const format of ['json', 'zip']) {
    const d = await device('replace-' + format);
    try {
      const old = new Blob(['old'], { type: 'image/png' });
      await d.db.add('_global_', 'Alice', old, { sourceUrl: 'https://images.invalid/old.png' });
      await d.db.addMoodAvatar('_global_', 'Alice', 'mood-tired', old);
      await d.db.getBlobUrl('_global_', 'Alice'); await d.db.getMoodAvatarBlobUrl('_global_', 'Alice', 'mood-tired');
      const url = 'https://images.invalid/new.png';
      const links = { avatars: [{ name: 'Alice', imageUrl: url, mimeType: 'image/png' }],
        moodAvatars: [{ name: 'Alice', moodId: 'mood-tired', imageUrl: url, mimeType: 'image/png' }] };
      const file = format === 'zip' ? characterArchive(d, links)
        : new Blob([JSON.stringify({ type: 'bubble-character', version: '8.0', ...links })]);
      const linked = await d.db.importFromFile(file, '_global_');
      assert.equal(linked.linked, 2); assert.equal(linked.errors.length, 0);
      assert.equal((await d.db.get('_global_', 'Alice')).imageBlob, null);
      assert.equal(await d.db.getBlobUrl('_global_', 'Alice'), url);
      assert.equal(await d.db.getMoodAvatarBlobUrl('_global_', 'Alice', 'mood-tired'), url);
      const embedded = format === 'zip' ? characterArchive(d, {
        avatars: [{ name: 'Alice', zipPath: 'new.png', mimeType: 'image/png' }],
        moodAvatars: [{ name: 'Alice', moodId: 'mood-tired', zipPath: 'new.png', mimeType: 'image/png' }],
      }, [{ name: 'new.png', data: new TextEncoder().encode('restored') }]) : new Blob([JSON.stringify({
        type: 'bubble-character', version: '8.0', avatars: [{ name: 'Alice', imageBase64: Buffer.from('restored').toString('base64'), mimeType: 'image/png' }],
        moodAvatars: [{ name: 'Alice', moodId: 'mood-tired', imageBase64: Buffer.from('restored').toString('base64'), mimeType: 'image/png' }],
      })]);
      const result = await d.db.importFromFile(embedded, '_global_');
      assert.equal(result.errors.length, 0); assert.equal(result.linked, 0);
      assert.equal((await d.db.get('_global_', 'Alice')).sourceUrl, null);
      assert.equal(await (await d.db.get('_global_', 'Alice')).imageBlob.text(), 'restored');
      assert.equal(await (await d.db.getMoodAvatar('_global_', 'Alice', 'mood-tired')).imageBlob.text(), 'restored');
    } finally { d.stop(); }
  }
});

test('standalone CG imports fail before writing data', async () => {
  const d = await device('A');
  try {
    await assert.rejects(d.db.importFromFile(new Blob([JSON.stringify({ type: 'bubble-cg', version: '8.0', groups: [] })]), '_global_'), /无法识别的文件格式/);
    assert.deepEqual(Object.keys(await d.db.getAllConfig()), []);
    assert.deepEqual([...d.db.db.objectStoreNames], ['avatars', 'config', 'local_fonts', 'mood_avatars']);
  } finally { d.stop(); }
});
