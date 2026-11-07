import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
function checkAsset(specifier, importer) {
  const asset = new URL(specifier, pathToFileURL(path.join(root, importer)));
  const filename = fileURLToPath(asset);
  if (!filename.startsWith(root)) return; // Host modules retain the host's module identity.
  assert.ok(fs.existsSync(filename), `${importer}: missing ${specifier}`);
  assert.equal(asset.search, `?v=${manifest.version}`, `${importer}: stale or missing version on ${specifier}`);
}
for (const name of [manifest.js, manifest.css]) checkAsset(name, 'manifest.json');
const files = ['index.js', ...['src', 'tests'].flatMap(dir =>
  fs.readdirSync(path.join(root, dir)).filter(name => /\.m?js$/.test(name)).map(name => `${dir}/${name}`))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"\r\n]+)['"]/g)) checkAsset(match[1], file);
}
for (const file of ['style.css', 'src/bubble-style.css']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/@import\s+url\(['"](\.[^'"\r\n]+)['"]\)/g)) checkAsset(match[1], file);
}
console.log('Manifest, dependency versions and JavaScript syntax checks passed.');
