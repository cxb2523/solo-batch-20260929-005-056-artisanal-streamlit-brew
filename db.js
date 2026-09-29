'use strict';

/**
 * db.js — 冲煮记录的文件存储薄层。
 * 业务/归一化/迁移逻辑全部位于 brew-core.js；这里只负责
 * 原子落盘（同目录临时文件 + rename）、读取与版本判断，
 * 供路由与升级脚本共用，避免逻辑再散落到各处。
 */

const fs = require('node:fs');
const path = require('node:path');

const core = require('./brew-core.js');

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 原子写：先写同目录临时文件并 flush，再 rename 覆盖目标。
 * rename 在同卷上是原子操作——任何读者要么看到旧文件、要么看到新文件，
 * 不会读到半成品；中途异常时临时文件被清理，目标保持原样。
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
      try { fs.closeSync(handle); } catch { /* 关闭失败时交由 unlink 兜底 */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* 临时文件可能尚未创建 */ }
    throw error;
  }
}

/** 读路径：当前版本直接返回；落后版本迁移后返回（由调用方决定是否回写）。 */
function loadBrewDoc(filePath) {
  const raw = readJsonIfExists(filePath);
  if (raw === null) {
    return { doc: { schemaVersion: core.SCHEMA_VERSION, entries: [] }, migrated: false, existed: false };
  }
  return { ...core.readBrewDoc(raw), existed: true };
}

/** 写路径：统一过一遍核心归一化，再按规范字节序落盘。 */
function saveBrewDoc(filePath, doc) {
  const normalized = core.readBrewDoc(doc).migrated
    ? core.migrateBrewDoc(doc).doc
    : doc;
  atomicWriteFileSync(filePath, core.serializeBrewDoc(normalized));
  return normalized;
}

function appendBrewEntries(filePath, entries) {
  const existing = loadBrewDoc(filePath);
  const merged = core.buildBrewDoc([...(existing.doc.entries || []), ...entries]);
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
