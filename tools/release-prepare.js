'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const common = require('./release-common');

function run(command, args) {
  console.log('[release:prepare] ' + command + ' ' + args.join(' '));
  execFileSync(command, args, { cwd: common.ROOT, stdio: 'inherit', env: process.env });
}

function parseArgs(argv) {
  const result = { from: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true, from: [] };
    if (!['--version', '--tag', '--from', '--notes-file', '--skip-build'].includes(key)) common.fail('Unknown argument: ' + key);
    if (key === '--skip-build') { result.skipBuild = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) common.fail('Missing value for ' + key);
    if (key === '--from') result.from.push(value);
    else result[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return result;
}

function usage() {
  console.log([
    'Usage:',
    '  npm run release:prepare -- [--version 1.1.6] [--tag 1.1.6] [--from 1.1.5]',
    '',
    'Builds and verifies local release assets only. It never commits, tags, pushes, or uploads.',
  ].join('\n'));
}

function notesFromFile(file) {
  if (!file) return common.releaseNotes();
  return fs.readFileSync(path.resolve(common.ROOT, file), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 4);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const pkg = common.readJson(path.join(common.ROOT, 'package.json'));
  const version = args.version || pkg.version;
  if (version !== pkg.version) common.fail('--version must match package.json (' + pkg.version + ').');
  const tag = args.tag || version;

  ['server.js', 'desktop/main.js', 'desktop/preload.js', 'public/scripts/app.js'].forEach(file => run(process.execPath, ['--check', file]));
  run('git', ['diff', '--check']);
  if (!args.skipBuild) run('npm', ['run', 'build:mac:dmg']);
  fs.mkdirSync(common.DIST, { recursive: true });

  args.from.forEach(ref => {
    run(process.execPath, ['tools/generate-update-patch.js', '--from', ref]);
  });

  const ymlPath = path.join(common.DIST, 'latest-mac.yml');
  if (!fs.existsSync(ymlPath)) common.fail('Missing dist/latest-mac.yml. Run without --skip-build first.');
  const yml = common.parseLatestMacYml(fs.readFileSync(ymlPath, 'utf8'));
  if (yml.version !== version) common.fail('latest-mac.yml version is ' + yml.version + ', expected ' + version + '.');

  const assets = {};
  ['x64', 'arm64'].forEach(arch => {
    const expectedName = `Mineradio-${version}-${arch}.dmg`;
    const record = common.fileRecord(path.join(common.DIST, expectedName), 'sha512', 'base64');
    const ymlRecord = yml.files.find(item => item.name === expectedName);
    if (!ymlRecord || ymlRecord.size !== record.size || ymlRecord.sha512 !== record.sha512) {
      common.fail('latest-mac.yml does not match ' + expectedName + '.');
    }
    assets['darwin-' + arch] = record;
  });

  const patches = fs.readdirSync(common.DIST)
    .filter(name => name.endsWith('.patch.json'))
    .map(name => {
      const file = path.join(common.DIST, name);
      const payload = common.readJson(file);
      if (payload.to !== version) return null;
      const record = common.fileRecord(file, 'sha256', 'hex');
      return { from: payload.from, to: payload.to, ...record };
    })
    .filter(Boolean);

  const owner = pkg.mineradio.update.owner;
  const repo = pkg.mineradio.update.repo;
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    notes: notesFromFile(args.notesFile),
    assets,
    patches,
  };
  fs.writeFileSync(common.manifestPath(), JSON.stringify(manifest, null, 2) + '\n');

  const uploadNames = ['Mineradio-update.json', 'latest-mac.yml']
    .concat(Object.values(assets).map(item => item.name), patches.map(item => item.name));
  const listPath = path.join(common.DIST, `Mineradio-${version}-UPLOAD.txt`);
  fs.writeFileSync(listPath, uploadNames.join('\n') + '\n');
  console.log('[release:prepare] Ready. Upload the files listed in ' + path.relative(common.ROOT, listPath));
  console.log('[release:prepare] No Git or GitHub state was changed.');
}

try { main(); } catch (err) {
  console.error('[release:prepare] ' + (err.message || err));
  process.exitCode = 1;
}
