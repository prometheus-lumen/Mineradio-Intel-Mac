'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function fail(message) {
  console.error('[release:update] ' + message);
  process.exit(1);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: options.encoding === null ? null : 'utf8',
      input: options.input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.inherit ? 'inherit' : undefined,
    });
  } catch (error) {
    const detail = String((error.stderr && error.stderr.toString()) || error.message || error).trim();
    throw new Error(command + ' ' + args.join(' ') + (detail ? '\n' + detail : ''));
  }
}

function git(args, options) {
  return run('git', args, options);
}

function parseArgs(argv) {
  const args = { mode: 'auto', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (key === '--dry-run') { args.dryRun = true; continue; }
    if (!['--version', '--mode', '--base', '--notes-file'].includes(key)) fail('Unknown argument: ' + key);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail('Missing value for ' + key);
    args[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    i += 1;
  }
  if (!['auto', 'patch', 'full'].includes(args.mode)) fail('--mode must be auto, patch, or full.');
  return args;
}

function usage() {
  console.log([
    'Usage:',
    '  npm run release:update -- [--version 1.1.5] [--mode auto|patch|full]',
    '                            [--base 1.1.4] [--notes-file RELEASE_NOTES.md] [--dry-run]',
    '',
    'Examples:',
    '  npm run release:update -- --version 1.1.4 --mode full',
    '  npm run release:update',
    '  npm run release:update -- --mode patch --notes-file docs/RELEASE_NOTES.md',
  ].join('\n'));
}

function normalizeVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+){2,3}/);
  return match ? match[0] : '';
}

function versionParts(value) {
  return normalizeVersion(value).split('.').map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function nextPatchVersion(value) {
  const parts = versionParts(value);
  if (parts.length < 3) fail('Invalid package version: ' + value);
  return [parts[0], parts[1], parts[2] + 1].join('.');
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function readPackageAt(ref) {
  return JSON.parse(git(['show', ref + ':package.json']));
}

function stable(value) {
  return JSON.stringify(value || {});
}

function releaseNeedsFullBuild(baseRef, currentPackage) {
  const basePackage = readPackageAt(baseRef);
  const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  if (runtimeFields.some(field => stable(basePackage[field]) !== stable(currentPackage[field]))) return true;
  if (stable(basePackage.build) !== stable(currentPackage.build)) return true;
  const baseElectron = basePackage.devDependencies && basePackage.devDependencies.electron;
  const currentElectron = currentPackage.devDependencies && currentPackage.devDependencies.electron;
  if (baseElectron !== currentElectron) return true;
  const baseUpdate = basePackage.mineradio && basePackage.mineradio.update;
  const currentUpdate = currentPackage.mineradio && currentPackage.mineradio.update;
  if (stable(baseUpdate) !== stable(currentUpdate)) return true;
  const changed = String(git(['diff', '--name-only', baseRef, 'HEAD', '--'])).split(/\r?\n/).filter(Boolean);
  return changed.some(file => /^build\//i.test(file) || /\.(?:node|dylib|so|dll|exe|msi)$/i.test(file));
}

function resolveBaseRef(targetVersion, requestedBase) {
  if (requestedBase) {
    git(['rev-parse', '--verify', requestedBase + '^{commit}']);
    return requestedBase;
  }
  const tags = String(git(['tag', '--list'])).split(/\r?\n/).filter(Boolean)
    .map(tag => ({ tag, version: normalizeVersion(tag) }))
    .filter(item => item.version && compareVersions(item.version, targetVersion) < 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!tags.length) fail('No earlier release tag found. Pass --base <tag>.');
  return tags[0].tag;
}

function assertCleanWorktree() {
  const status = String(git(['status', '--porcelain'])).trim();
  if (status) fail('Commit or stash existing changes before releasing:\n' + status);
}

function releaseNotes(baseRef, notesFile, version) {
  if (notesFile) return fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8').trim();
  const log = String(git(['log', '--pretty=format:- %s', baseRef + '..HEAD'])).trim();
  return ['## Mineradio ' + version, '', log || '- Maintenance update'].join('\n');
}

function contentType(file) {
  if (/\.dmg$/i.test(file)) return 'application/x-apple-diskimage';
  if (/\.ya?ml$/i.test(file)) return 'application/x-yaml';
  return 'application/json';
}

function githubToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const output = run('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' });
    const password = String(output).split(/\r?\n/).find(line => line.startsWith('password='));
    if (password) return password.slice('password='.length).trim();
  } catch (_) {}
  fail('GitHub credentials not found. Set GH_TOKEN once or sign in with Git Credential Manager.');
}

async function githubRequest(token, method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...headers,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error('GitHub ' + response.status + ': ' + (text || response.statusText));
  return text ? JSON.parse(text) : null;
}

async function findRelease(token, apiBase, tag) {
  const releases = await githubRequest(token, 'GET', apiBase + '/releases?per_page=100');
  return (releases || []).find(release => release.tag_name === tag) || null;
}

async function uploadAsset(token, owner, repo, release, filePath) {
  const name = path.basename(filePath);
  if ((release.assets || []).some(asset => asset.name === name)) {
    console.log('[release:update] Reusing uploaded asset ' + name);
    return;
  }
  const data = fs.readFileSync(filePath);
  const url = 'https://uploads.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo)
    + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(name);
  await githubRequest(token, 'POST', url, data, {
    'Content-Type': contentType(name),
    'Content-Length': String(data.length),
  });
  console.log('[release:update] Uploaded ' + name);
}

function prepareAssets(mode, baseRef, version) {
  if (mode === 'full') {
    run('npm', ['run', 'build:mac:dmg'], { inherit: true });
    return [
      path.join(ROOT, 'dist', 'Mineradio-' + version + '-x64.dmg'),
      path.join(ROOT, 'dist', 'Mineradio-' + version + '-arm64.dmg'),
      path.join(ROOT, 'dist', 'latest-mac.yml'),
    ];
  }
  run(process.execPath, [path.join(ROOT, 'tools', 'generate-update-patch.js'), '--from', baseRef], { inherit: true });
  const baseVersion = normalizeVersion(readPackageAt(baseRef).version || baseRef);
  return [path.join(ROOT, 'dist', 'Mineradio-' + baseVersion + '\u2192' + version + '.patch.json')];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  const initialPackage = readPackage();
  const targetVersion = normalizeVersion(args.version) || nextPatchVersion(initialPackage.version);
  if (!targetVersion) fail('Invalid target version.');
  if (compareVersions(targetVersion, initialPackage.version) < 0) fail('Target version cannot be older than package.json.');

  if (!args.dryRun) {
    assertCleanWorktree();
    run('git', ['fetch', '--tags', 'origin'], { inherit: true });
  }
  const baseRef = resolveBaseRef(targetVersion, args.base);
  const tag = targetVersion;
  const existingTag = String(git(['tag', '--list', tag])).trim();
  if (existingTag && String(git(['rev-parse', tag])).trim() !== String(git(['rev-parse', 'HEAD'])).trim()) {
    fail('Tag ' + tag + ' already points to another commit.');
  }
  let mode = args.mode;
  if (mode === 'auto') mode = releaseNeedsFullBuild(baseRef, initialPackage) ? 'full' : 'patch';

  console.log('[release:update] Plan: ' + baseRef + ' -> ' + targetVersion + ' (' + mode + ')');
  if (args.dryRun) return;

  const notes = releaseNotes(baseRef, args.notesFile, targetVersion);
  run('npm', ['version', targetVersion, '--no-git-tag-version', '--allow-same-version'], { inherit: true });
  run(process.execPath, ['--check', 'server.js'], { inherit: true });
  run(process.execPath, ['--check', 'desktop/main.js'], { inherit: true });
  run(process.execPath, ['--check', 'desktop/preload.js'], { inherit: true });
  run(process.execPath, ['--check', 'public/scripts/app.js'], { inherit: true });
  git(['diff', '--check'], { inherit: true });
  git(['add', 'package.json', 'package-lock.json'], { inherit: true });
  const staged = String(git(['diff', '--cached', '--name-only'])).trim();
  if (staged) git(['commit', '-m', 'release: ' + targetVersion], { inherit: true });

  let assets;
  try {
    assets = prepareAssets(mode, baseRef, targetVersion);
  } catch (error) {
    if (args.mode !== 'auto' || mode === 'full') throw error;
    console.warn('[release:update] Patch unavailable; falling back to full DMG release.');
    mode = 'full';
    assets = prepareAssets(mode, baseRef, targetVersion);
  }
  assets.forEach(file => { if (!fs.existsSync(file)) fail('Missing release asset: ' + file); });

  if (!existingTag) git(['tag', tag], { inherit: true });
  git(['push', 'origin', 'HEAD'], { inherit: true });
  git(['push', 'origin', tag], { inherit: true });

  const currentPackage = readPackage();
  const publish = currentPackage.build && currentPackage.build.publish && currentPackage.build.publish[0];
  const owner = publish && publish.owner;
  const repo = publish && publish.repo;
  if (!owner || !repo) fail('GitHub publish repository is not configured in package.json.');
  const token = githubToken();
  const apiBase = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
  let release = await findRelease(token, apiBase, tag);
  if (release && !release.draft) fail('Release ' + tag + ' is already published.');
  if (!release) {
    release = await githubRequest(token, 'POST', apiBase + '/releases', JSON.stringify({
      tag_name: tag,
      name: 'Mineradio-Intel-Mac ' + targetVersion,
      body: notes,
      draft: true,
      prerelease: false,
    }), { 'Content-Type': 'application/json' });
  }
  for (const asset of assets) await uploadAsset(token, owner, repo, release, asset);
  await githubRequest(token, 'PATCH', apiBase + '/releases/' + release.id, JSON.stringify({
    draft: false,
    prerelease: false,
    make_latest: 'true',
  }), { 'Content-Type': 'application/json' });
  console.log('[release:update] Published https://github.com/' + owner + '/' + repo + '/releases/tag/' + tag);
}

main().catch(error => fail(error.message || error));
