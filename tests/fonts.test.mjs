import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FontCatalog } from "../src/fonts.js?v=2.0.1";
import { RenderAssets } from "../src/assets.js?v=2.0.1";

test('remote font catalogue coalesces requests, caches successes and supports explicit refresh', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ fonts: [{ family:'Review Font', url:'https://example.test/font.woff2', type:'file' }] }));
  };
  const fonts = new FontCatalog({ listLocalFonts: async () => [], getCssFontSources: async () => [] });
  try {
    const [a, b] = await Promise.all([fonts.getOptions('https://example.test/fonts.json'), fonts.getOptions('https://example.test/fonts.json')]);
    assert.equal(calls, 1); assert.deepEqual(a, b);
    await fonts.getOptions('https://example.test/fonts.json'); assert.equal(calls, 1);
    await fonts.getOptions('https://example.test/fonts.json', { forceRefresh: true }); assert.equal(calls, 2);
    globalThis.fetch = async () => new Response('bad response', { status: 503 });
    await assert.rejects(fonts.getRemote('https://example.test/failing.json'), /503/);
    globalThis.fetch = async () => new Response(JSON.stringify({ fonts: [] }));
    assert.deepEqual(await fonts.getRemote('https://example.test/failing.json'), []);
  } finally { fonts.destroy(); globalThis.fetch = original; }
});

test('unchanged font resources retain DOM nodes and Blob URLs across ordinary refreshes', async () => {
  const dom = new JSDOM('<!doctype html><head></head><body></body>');
  const local = [{ id:'review', family:'Review Font', createdAt:1, fontBlob:new Blob(['font-a']), mimeType:'font/woff2' }];
  const db = { getAllConfig: async () => ({}), listLocalFonts: async () => local, getCssFontSources: async () => [] };
  const assets = new RenderAssets(db);
  try {
    await assets.syncFonts(dom.window.document);
    const node = dom.window.document.head.querySelector('style'); const url = assets.fontUrls.get('review');
    await assets.refresh(); await assets.syncFonts(dom.window.document);
    assert.equal(dom.window.document.head.querySelector('style'), node); assert.equal(assets.fontUrls.get('review'), url);
    local[0] = { ...local[0], createdAt:2, fontBlob:new Blob(['font-bb']) };
    await assets.syncFonts(dom.window.document);
    assert.notEqual(assets.fontUrls.get('review'), url); assert.notEqual(dom.window.document.head.querySelector('style'), node);
  } finally { assets.destroy(); assert.equal(dom.window.document.head.children.length, 0); dom.window.close(); }
});

test('a late font response cannot replace a newer preview font set', async () => {
  const dom = new JSDOM('<!doctype html><head></head><body></body>');
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  const fonts = { getRemote: url => url === 'old' ? old : Promise.resolve([{ type:'css', url:'https://example.test/new.css' }]), destroy() {} };
  const db = { listLocalFonts: async () => [], getCssFontSources: async () => [] };
  const assets = new RenderAssets(db, { fonts });
  try {
    assets.setPreview({ style_fontConfigUrl:'old' }); const pending = assets.syncFonts(dom.window.document);
    assets.setPreview({ style_fontConfigUrl:'new' }); await assets.syncFonts(dom.window.document);
    finishOld([{ type:'css', url:'https://example.test/old.css' }]); await pending;
    assert.deepEqual([...dom.window.document.querySelectorAll('link')].map(node => node.href), ['https://example.test/new.css']);
  } finally { assets.destroy(); dom.window.close(); }
});
