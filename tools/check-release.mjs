// Release checks run by .github/workflows/release.yml.
// Usage: node tools/check-release.mjs v1.2.3   (fails unless the code is stamped 1.2.3)
//        node tools/check-release.mjs --files  (prints the files that go in the site bundle)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['index.html', 'app.js', 'strategies.js', 'styles.css', 'levels.js'];
const arg = process.argv[2] || '';
if (arg === '--files') { console.log(FILES.join(' ')); process.exit(0); }

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8'), errors = [];
const version = /^v(\d+\.\d+\.\d+)$/.exec(arg)?.[1];
if (!version) errors.push(`expected a tag like v1.2.3, got "${arg}"`);

for (const f of FILES) if (!fs.existsSync(path.join(ROOT, f))) errors.push(`${f} is missing`);
const scripts = [...FILES.filter(f => f.endsWith('.js')), ...fs.readdirSync(path.join(ROOT, 'tools')).filter(f => f.endsWith('.mjs')).map(f => `tools/${f}`)];
for (const f of scripts) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { errors.push(`${f} has a syntax error: ${String(e.stderr).split('\n')[0]}`); }
}

if (version) { // phones keep old files unless both stamps change with every release
  const build = /const BUILD = '([^']+)'/.exec(read('app.js'))?.[1];
  if (build !== version) errors.push(`app.js BUILD is ${build}, the tag says ${version}`);
  const stamps = [...read('index.html').matchAll(/\?v=([^"']+)/g)].map(m => m[1]);
  if (!stamps.length) errors.push('index.html has no ?v= stamps');
  for (const s of new Set(stamps)) if (s !== version) errors.push(`index.html has ?v=${s}, the tag says ${version}`);
  if (!read('CHANGELOG.md').includes(`## ${version} `)) errors.push(`CHANGELOG.md has no ${version} section`);
}

if (errors.length) { for (const e of errors) console.error('FAIL ' + e); process.exit(1); }
console.log(`OK ${arg}: ${scripts.length} scripts parse, stamps match`);
