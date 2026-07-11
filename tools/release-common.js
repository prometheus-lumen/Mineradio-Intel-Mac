'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function fail(message) {
  const err = new Error(message);
  err.code = 'RELEASE_VERIFY_FAILED';
  throw err;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digestFile(file, algorithm, encoding) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}

function fileRecord(file, algorithm, encoding) {
  if (!fs.existsSync(file)) fail('Missing release asset: ' + path.basename(file));
  return {
    name: path.basename(file),
    size: fs.statSync(file).size,
    [algorithm]: digestFile(file, algorithm, encoding),
  };
}

function parseLatestMacYml(text) {
  const versionMatch = String(text || '').match(/^version:\s*(.+?)\s*$/m);
  const files = [];
  const pattern = /^\s*-\s+url:\s*(.+?)\s*$\n\s+sha512:\s*(.+?)\s*$\n\s+size:\s*(\d+)\s*$/gm;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    files.push({
      name: match[1].trim().replace(/^['"]|['"]$/g, ''),
      sha512: match[2].trim().replace(/^['"]|['"]$/g, ''),
      size: Number(match[3]),
    });
  }
  return {
    version: versionMatch ? versionMatch[1].trim().replace(/^['"]|['"]$/g, '') : '',
    files,
  };
}

function releaseNotes() {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(line => line && !line.startsWith('#'))
    .slice(0, 4);
}

function manifestPath() {
  return path.join(DIST, 'Mineradio-update.json');
}

module.exports = {
  ROOT,
  DIST,
  fail,
  readJson,
  digestFile,
  fileRecord,
  parseLatestMacYml,
  releaseNotes,
  manifestPath,
};
