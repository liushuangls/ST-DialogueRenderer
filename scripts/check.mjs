import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
for (const name of [manifest.js, manifest.css]) assert.ok(fs.existsSync(path.join(root, name.split('?')[0])));
for (const file of ['index.js', ...fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).map(name => 'src/' + name)]) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
console.log('Manifest and JavaScript syntax checks passed.');
