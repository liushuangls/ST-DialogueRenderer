import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'es-module-lexer/minimal/js';

export const root = fileURLToPath(new URL('../', import.meta.url));

export function filesIn(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

/** One release version owns every local ESM/CSS URL, including dynamic panel imports. */
export function syncVersion({ check = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid package version: ' + version);
  const update = (file, next) => {
    const filename = path.join(root, file);
    if (fs.readFileSync(filename, 'utf8') === next) return;
    if (check) throw new Error(`${file}: release version URLs are out of date; run npm run version`);
    fs.writeFileSync(filename, next);
  };
  const asset = (specifier, importer) => {
    const target = new URL(specifier, pathToFileURL(path.join(root, importer)));
    const filename = fileURLToPath(target);
    if (!filename.startsWith(root)) return specifier;
    if (!fs.existsSync(filename)) throw new Error(`${importer}: missing asset ${specifier}`);
    target.searchParams.set('v', version);
    return specifier.split(/[?#]/)[0] + target.search + target.hash;
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  manifest.version = version;
  manifest.js = asset(manifest.js, 'manifest.json');
  manifest.css = asset(manifest.css, 'manifest.json');
  update('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  for (const file of ['index.js', 'style.css', ...filesIn('src'), ...filesIn('tests')]) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (/\.m?js$/.test(file)) {
      // Parse real imports so examples inside test strings/comments stay untouched.
      for (const item of parse(source)[0].reverse()) {
        if (item.d >= 0 && item.n === undefined && file.startsWith('src/')) {
          throw new Error(`${file}: dynamic imports must use a literal module URL`);
        }
        if (!item.n?.startsWith('.')) continue;
        const url = asset(item.n, file);
        if (url === item.n) continue;
        const start = item.d < 0 ? item.s - 1 : item.s;
        const end = item.d < 0 ? item.e + 1 : item.e;
        source = source.slice(0, start) + JSON.stringify(url) + source.slice(end);
      }
    } else if (file.endsWith('.css')) {
      source = source.replace(/(@import\s+url\(['"])(\.[^'"\r\n]+)(['"]\))/g,
        (_, before, url, after) => before + asset(url, file) + after);
    }
    update(file, source);
  }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncVersion({ check: process.argv.includes('--check') });
  console.log('Release versions synchronized.');
}
