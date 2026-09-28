#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [assetPath, htmlPath, backupDir] = process.argv.slice(2);
if (!assetPath || !htmlPath || !backupDir) {
  throw new Error('usage: node activate-cached-asset.mjs <patched-index.js> <index.html> <existing-private-backup-dir>');
}
const asset = path.resolve(assetPath);
const html = path.resolve(htmlPath);
const backup = fs.realpathSync(backupDir);
if (!fs.statSync(backup).isDirectory()) throw new Error('backup directory is not a directory');
const oldName = path.basename(asset);
if (!/^index(?:[.-][\w-]+)?\.js$/.test(oldName)) throw new Error('expected an index JS asset');
const bytes = fs.readFileSync(asset);
const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const newName = `index-${digest}.js`;
const nextAsset = path.join(path.dirname(asset), newName);
const originalHtml = fs.readFileSync(html, 'utf8');
const oldReference = `src="/assets/${oldName}"`;
const newReference = `src="/assets/${newName}"`;
if (originalHtml.split(oldReference).length !== 2) throw new Error('expected exactly one index asset reference');
if (fs.existsSync(nextAsset) && !fs.readFileSync(nextAsset).equals(bytes)) throw new Error('new asset name already exists with different content');
const htmlBackup = path.join(backup, 'index.html');
if (fs.existsSync(htmlBackup)) throw new Error('HTML backup already exists');
fs.copyFileSync(html, htmlBackup, fs.constants.COPYFILE_EXCL);
if (!fs.existsSync(nextAsset)) fs.copyFileSync(asset, nextAsset, fs.constants.COPYFILE_EXCL);
const staged = `${html}.cardloom-${process.pid}.tmp`;
try {
  fs.writeFileSync(staged, originalHtml.replace(oldReference, newReference), { flag: 'wx', mode: fs.statSync(html).mode });
  fs.renameSync(staged, html);
} finally {
  if (fs.existsSync(staged)) fs.unlinkSync(staged);
}
console.log(`${oldName} -> ${newName}`);
