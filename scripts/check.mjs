import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { root, filesIn, syncVersion } from './version.mjs';

syncVersion({ check: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
for (const file of ['index.js', ...filesIn('src'), ...filesIn('tests'), ...filesIn('scripts')].filter(file => /\.m?js$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
}
console.log('Manifest, release dependencies and JavaScript syntax checks passed.');
