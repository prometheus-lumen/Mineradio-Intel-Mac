'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAX_PATCH_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 40;
const ALLOWED_ROOTS = new Set(['public', 'desktop', 'build']);
const ALLOWED_FILES = new Set(['server.js', 'dj-analyzer.js', 'package.json', 'package-lock.json']);

function fail(message) {
  console.error('[update:patch] ' + message);
  process.exit(1);
}

function usage() {
  console.log([
    'Usage:',
    '  npm run update:patch -- --from <git-ref> [--to <git-ref>] [--output <file>]',
    '',
    'Examples:',
    '  npm run update:patch -- --from Mineradio-1.1.1',
    '  npm run update:patch -- --from v1.1.3 --to HEAD',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!['--from', '--to', '--output'].includes(key)) fail('Unknown argument: ' + key);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail('Missing value for ' + key);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function git(args, encoding = 'utf8') {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const detail = String((err.stderr && err.stderr.toString()) || err.message || err).trim();
    fail('Git command failed: git ' + args.join(' ') + (detail ? '\n' + detail : ''));
  }
}

function normalizeVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+){1,3}/);
  return match ? match[0] : '';
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split('.').map(Number);
  const right = normalizeVersion(b).split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function safePatchPath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) return '';
  if (ALLOWED_FILES.has(rel)) return rel;
  if (!ALLOWED_ROOTS.has(parts[0])) return '';
  if (/\.(exe|dll|node|msi|bat|cmd|ps1|pfx|pem|key)$/i.test(rel)) return '';
  return parts.join('/');
}

function readJsonAt(ref, file) {
  const raw = ref ? git(['show', ref + ':' + file]) : fs.readFileSync(path.join(ROOT, file), 'utf8');
  try { return JSON.parse(raw); }
  catch (_) { fail('Invalid JSON: ' + (ref ? ref + ':' : '') + file); }
}

function readFileAt(ref, file) {
  if (ref) return git(['show', ref + ':' + file], null);
  return fs.readFileSync(path.join(ROOT, file));
}

function stableJson(value) {
  return JSON.stringify(value || {});
}

function assertRuntimeDependenciesUnchanged(fromPackage, toPackage) {
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const changed = fields.filter(field => stableJson(fromPackage[field]) !== stableJson(toPackage[field]));
  if (changed.length) fail('Runtime dependencies changed (' + changed.join(', ') + '); publish a full installer for this version.');
}

function parseDiff(fromRef, toRef) {
  const args = ['diff', '--name-status', '--find-renames', fromRef];
  if (toRef) args.push(toRef);
  args.push('--');
  const rows = String(git(args)).split(/\r?\n/).filter(Boolean);
  const writes = new Set();
  const deletes = new Set();
  rows.forEach(row => {
    const parts = row.split('\t');
    const status = parts[0] || '';
    if (/^R/.test(status)) {
      const oldPath = safePatchPath(parts[1]);
      const newPath = safePatchPath(parts[2]);
      if (oldPath) deletes.add(oldPath);
      if (newPath) writes.add(newPath);
      return;
    }
    const rel = safePatchPath(parts[1]);
    if (!rel) return;
    if (status === 'D') deletes.add(rel);
    else writes.add(rel);
  });
  deletes.forEach(rel => writes.delete(rel));
  return { writes: Array.from(writes).sort(), deletes: Array.from(deletes).sort() };
}

function assertNoAllowedUntrackedFiles() {
  const files = String(git(['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean);
  const allowed = files.map(safePatchPath).filter(Boolean);
  if (allowed.length) fail('Commit new update files before generating the patch: ' + allowed.join(', '));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (!args.from) { usage(); fail('--from is required.'); }

  git(['rev-parse', '--verify', args.from + '^{commit}']);
  if (args.to) git(['rev-parse', '--verify', args.to + '^{commit}']);
  else assertNoAllowedUntrackedFiles();

  const fromPackage = readJsonAt(args.from, 'package.json');
  const toPackage = readJsonAt(args.to || '', 'package.json');
  const fromVersion = normalizeVersion(fromPackage.version);
  const toVersion = normalizeVersion(toPackage.version);
  if (!fromVersion || !toVersion) fail('Both source and target package.json files need valid versions.');
  if (compareVersions(toVersion, fromVersion) <= 0) fail('Target version ' + toVersion + ' must be newer than ' + fromVersion + '.');
  assertRuntimeDependenciesUnchanged(fromPackage, toPackage);

  const changes = parseDiff(args.from, args.to || '');
  if (!changes.writes.includes('package.json')) fail('package.json must be included so the installed version advances after restart.');
  if (!changes.writes.length && !changes.deletes.length) fail('No patchable runtime changes found.');
  if (changes.writes.length + changes.deletes.length > MAX_FILES) fail('Patch contains more than ' + MAX_FILES + ' file operations.');

  const files = changes.writes.map(rel => {
    const content = readFileAt(args.to || '', rel);
    return { path: rel, sha256: sha256(content), contentBase64: content.toString('base64') };
  });
  const payload = {
    type: 'mineradio-resource-patch',
    from: fromVersion,
    to: toVersion,
    createdAt: new Date().toISOString(),
    restartRequired: true,
    files,
    deletes: changes.deletes,
  };
  const output = Buffer.from(JSON.stringify(payload, null, 2) + '\n');
  if (output.length > MAX_PATCH_BYTES) fail('Patch is larger than 12 MB; publish a full installer.');

  const defaultName = 'Mineradio-' + fromVersion + '\u2192' + toVersion + '.patch.json';
  const outputPath = path.resolve(ROOT, args.output || path.join('dist', defaultName));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  console.log('[update:patch] Created ' + path.relative(ROOT, outputPath));
  console.log('[update:patch] ' + files.length + ' file(s), ' + changes.deletes.length + ' deletion(s), ' + output.length + ' bytes');
  console.log('[update:patch] SHA256 ' + sha256(output));
}

main();
