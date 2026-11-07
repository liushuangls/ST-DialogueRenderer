import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('release command versions static and lazy modules while preserving host imports', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'st-dialogue-release-'));
  try {
    for (const name of ['scripts', 'src', 'tests']) await fs.mkdir(path.join(directory, name));
    await fs.symlink(new URL('../node_modules', import.meta.url), path.join(directory, 'node_modules'), 'dir');
    await fs.copyFile(new URL('../scripts/version.mjs', import.meta.url), path.join(directory, 'scripts/version.mjs'));
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type:'module', version:'9.8.7' }));
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version:'1.0.0', js:'index.js?v=1.0.0', css:'style.css?v=1.0.0' }));
    await fs.writeFile(path.join(directory, 'index.js'), "import { host } from '../../../extensions.js';\nimport { start } from './src/start.js?v=1.0.0';\n");
    await fs.writeFile(path.join(directory, 'src/start.js'), "export const start = () => import('./panel.js?v=1.0.0');\n");
    await fs.writeFile(path.join(directory, 'src/panel.js'), 'export const panel = true;\n');
    await fs.writeFile(path.join(directory, 'style.css'), "@import url('./src/panel.css?v=1.0.0');\n");
    await fs.writeFile(path.join(directory, 'src/panel.css'), 'body {}\n');
    const example = `const example = "import './not-a-module.js'";\n`;
    await fs.writeFile(path.join(directory, 'tests/example.mjs'), example);
    const run = (...args) => spawnSync(process.execPath, [path.join(directory, 'scripts/version.mjs'), ...args], { encoding:'utf8' });
    assert.notEqual(run('--check').status, 0);
    const release = run(); assert.equal(release.status, 0, release.stderr);
    assert.equal(run('--check').status, 0);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '9.8.7'); assert.equal(manifest.js, 'index.js?v=9.8.7');
    const entry = await fs.readFile(path.join(directory, 'index.js'), 'utf8');
    assert.match(entry, /from '\.\.\/\.\.\/\.\.\/extensions\.js'/);
    assert.match(entry, /start\.js\?v=9\.8\.7/);
    assert.match(await fs.readFile(path.join(directory, 'src/start.js'), 'utf8'), /panel\.js\?v=9\.8\.7/);
    assert.match(await fs.readFile(path.join(directory, 'style.css'), 'utf8'), /panel\.css\?v=9\.8\.7/);
    assert.equal(await fs.readFile(path.join(directory, 'tests/example.mjs'), 'utf8'), example);
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});
