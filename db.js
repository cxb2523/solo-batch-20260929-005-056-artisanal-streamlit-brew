'use strict';

/**
 * db.js —— 冲煮记录的文件存储薄层。
 * 业务/归一化/迁移口径全部在 brew-core.js，本文件只负责：
 * 读 JSON、原子落盘（同目录临时文件 + fsync + rename）、版本判断。
 * 路由与一次性升级脚本共用这里，避免读写逻辑再次散落。
 */

const fs = require('node:fs');
const path = require('node:path');

const core = require('./brew-core.js');

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 原子写：同目录临时文件写满并 flush 后 rename 覆盖目标。
 * 同卷 rename 是原子的——读者只会看到旧文件或完整新文件，读不到半成品；
 * 任何中途异常都会清理临时文件，目标保持原样。
 */
function atomicWriteFileSync(filePath, contents) {
  const directory = path.dirname(path.resolve(filePath));
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  let handle;
  try {
    handle = fs.openSync(tempPath, 'w');
    fs.writeFileSync(handle, contents);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* 交给 unlink 兜底 */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* 临时文件可能还没建出来 */ }
    throw error;
  }
}

/** 读路径：当前版本直接返回；落后版本迁移后返回（是否回写由调用方决定）。 */
function loadBrewDoc(filePath) {
  const raw = readJsonIfExists(filePath);
  if (raw === null) {
    return { doc: { schemaVersion: core.SCHEMA_VERSION, entries: [] }, migrated: false, existed: false };
  }
  return { ...core.readBrewDoc(raw), existed: true };
}

/** 写路径：任何来源的文档先过同一套规范化，再按规范字节序落盘。 */
function saveBrewDoc(filePath, doc) {
  const normalized = core.readBrewDoc(doc).migrated
    ? core.migrateBrewDoc(doc).doc
    : doc;
  atomicWriteFileSync(filePath, core.serializeBrewDoc(normalized));
  return normalized;
}

function appendBrewEntries(filePath, entries) {
  const loaded = loadBrewDoc(filePath);
  const merged = core.buildBrewDoc([...(loaded.doc.entries || []), ...entries]);
  atomicWriteFileSync(filePath, core.serializeBrewDoc(merged));
  return merged;
}

module.exports = {
  readJsonIfExists,
  atomicWriteFileSync,
  loadBrewDoc,
  saveBrewDoc,
  appendBrewEntries,
};