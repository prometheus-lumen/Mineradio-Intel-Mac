'use strict';

const fs = require('fs');
const path = require('path');
const common = require('./release-common');

function parseArgs(argv) {
  const result = { remote: false };
  argv.forEach(arg => {
    if (arg === '--remote') result.remote = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else common.fail('Unknown argument: ' + arg);
  });
  return result;
}

function verifyRecord(record, algorithm, encoding) {
  const file = path.join(common.DIST, record.name || '');
  if (!fs.existsSync(file)) common.fail('Missing ' + record.name);
  const size = fs.statSync(file).size;
  const digest = common.digestFile(file, algorithm, encoding);
  if (size !== Number(record.size)) common.fail('Size mismatch: ' + record.name);
  if (digest !== record[algorithm]) common.fail(algorithm.toUpperCase() + ' mismatch: ' + record.name);
}

async function verifyRemote(manifest, names) {
  const pkg = common.readJson(path.join(common.ROOT, 'package.json'));
  const { owner, repo } = pkg.mineradio.update;
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const resp = await fetch(url, { headers: { 'User-Agent': `Mineradio/${pkg.version}`, Accept: 'application/vnd.github+json' } });
  if (!resp.ok) common.fail('GitHub latest release returned HTTP ' + resp.status);
  const release = await resp.json();
  if (release.draft) common.fail('Latest release is still a draft.');
  if (String(release.tag_name) !== String(manifest.tag)) common.fail('Latest tag is ' + release.tag_name + ', expected ' + manifest.tag);
  const remote = new Map((release.assets || []).map(asset => [asset.name, asset]));
  names.forEach(name => {
    if (!remote.has(name)) common.fail('Remote release is missing ' + name);
    const local = fs.statSync(path.join(common.DIST, name));
    if (Number(remote.get(name).size) !== local.size) common.fail('Remote size mismatch: ' + name);
  });
  console.log('[release:verify] GitHub latest release contains every verified asset.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run release:verify -- [--remote]');
    return;
  }
  const manifest = common.readJson(common.manifestPath());
  if (manifest.schemaVersion !== 1) common.fail('Unsupported manifest schemaVersion.');
  const pkg = common.readJson(path.join(common.ROOT, 'package.json'));
  if (manifest.version !== pkg.version) common.fail('Manifest version does not match package.json.');
  const records = Object.values(manifest.assets || {});
  if (!manifest.assets['darwin-x64'] || !manifest.assets['darwin-arm64']) common.fail('Both Mac architectures are required.');
  records.forEach(record => verifyRecord(record, 'sha512', 'base64'));
  (manifest.patches || []).forEach(record => verifyRecord(record, 'sha256', 'hex'));

  const yml = common.parseLatestMacYml(fs.readFileSync(path.join(common.DIST, 'latest-mac.yml'), 'utf8'));
  records.forEach(record => {
    const item = yml.files.find(file => file.name === record.name);
    if (!item || item.size !== record.size || item.sha512 !== record.sha512) common.fail('latest-mac.yml mismatch: ' + record.name);
  });
  const names = ['Mineradio-update.json', 'latest-mac.yml'].concat(records.map(r => r.name), (manifest.patches || []).map(r => r.name));
  console.log('[release:verify] Local assets, versions, sizes, and hashes are valid.');
  if (args.remote) await verifyRemote(manifest, names);
}

main().catch(err => {
  console.error('[release:verify] ' + (err.message || err));
  process.exitCode = 1;
});
