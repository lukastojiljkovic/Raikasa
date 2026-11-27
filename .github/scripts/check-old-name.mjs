// Fails when the product's previous name appears in a tracked file, in any case, outside the allow-list next to this
// script. The list names the previous name once (`name: ...`), so this script never spells it. Every other entry is
// `path: literal`: on a line of that file, that exact text may appear. A path spells the current name as
// {ProductName}, the value in Directory.Build.props, so the list doesn't change with it. An entry that matches nothing
// fails too, so the list stays exactly what the repository needs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const listPath = relative(root, fileURLToPath(new URL('old-name-allow-list.txt', import.meta.url))).replaceAll('\\', '/');
const productName = readFileSync(join(root, 'Directory.Build.props'), 'utf8').match(/<ProductName>([^<]+)<\/ProductName>/)?.[1];
if (!productName) {
  console.error('Directory.Build.props has no <ProductName>.');
  process.exit(1);
}

let name;
const allowed = new Map();
const failures = [];
for (const [index, raw] of readFileSync(join(root, listPath), 'utf8').split(/\r?\n/).entries()) {
  const line = raw.trim();
  if (line === '' || line.startsWith('#')) continue;
  const separator = line.indexOf(': ');
  if (separator < 1) {
    failures.push(`${listPath}:${index + 1}: not a "path: literal" entry`);
    continue;
  }
  const [path, literal] = [line.slice(0, separator).replaceAll('{ProductName}', productName), line.slice(separator + 2)];
  if (path === 'name') {
    name = literal.toLowerCase();
    continue;
  }
  if (!allowed.has(path)) allowed.set(path, []);
  allowed.get(path).push({ literal, line: index + 1, used: false });
}
if (!name) {
  console.error(`${listPath} has no "name: ..." line.`);
  process.exit(1);
}
for (const [path, entries] of allowed) {
  for (const entry of entries) {
    if (!entry.literal.toLowerCase().includes(name)) failures.push(`${listPath}:${entry.line}: the literal for ${path} doesn't contain the name`);
  }
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);
for (const path of tracked) {
  if (path === listPath) continue;
  if (path.toLowerCase().includes(name)) failures.push(`${path}: the path contains the previous name`);
  const entries = allowed.get(path) ?? [];
  // Binary files decode with replacement characters, but their ASCII bytes stay, so the name is still found.
  for (const [index, line] of readFileSync(join(root, path), 'utf8').split('\n').entries()) {
    let rest = line;
    for (const entry of entries) {
      if (!rest.includes(entry.literal)) continue;
      entry.used = true;
      rest = rest.replaceAll(entry.literal, '');
    }
    if (rest.toLowerCase().includes(name)) failures.push(`${path}:${index + 1}: ${line.trim()}`);
  }
}
for (const [path, entries] of allowed) {
  for (const entry of entries) {
    if (!entry.used) failures.push(`${listPath}:${entry.line}: "${entry.literal}" is not in ${path}`);
  }
}

if (failures.length > 0) {
  console.error(`The previous name appears outside ${listPath}:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`The previous name appears only where ${listPath} allows it (${tracked.length} tracked files checked).`);
