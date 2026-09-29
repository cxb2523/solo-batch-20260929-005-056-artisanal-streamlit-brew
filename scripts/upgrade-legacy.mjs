#!/usr/bin/env node
/**
 * upgrade-legacy.mjs —— 一次性旧数据升级器。
 *
 * 用法:
 *   node scripts/upgrade-legacy.mjs --in fixtures/legacy.json \
 *       --out out/brew.json --report out/report.html
 *
 * 幂等 / 并发 / 崩溃安全：
 * - 同一份输入连喂两次产物字节级一致：out 已盖最新 schemaVersion 时整体
 *   跳过（mtime 都不动），已存在的 report.html 原样保留。
 * - 并发：out 同级的 lock 目录用“原子 mkdir”当互斥锁，只有持锁者真正
 *   落盘；抢不到锁的进程轮询 out，一旦读到最新 schemaVersion 立即退出
 *   （读到结果即退），不重复落盘。
 * - 持有者崩溃会留下陈旧锁，超过 BREW_LOCK_STALE_MS（默认 30s）后由后来者
 *   接管，避免死锁。
 * - 替换顺序：先把旧 out 原样复制成 out.bak，再用同目录临时文件 + rename
 *   原子替换。中途异常时 out 维持旧内容、只多出 .bak，绝不留半成品。
 * - 输入文件只读，永不修改。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import corePkg from '../brew-core.js';
import dbPkg from '../db.js';
import { renderReport } from './render-report.mjs';

const { SCHEMA_VERSION, migrateBrewDoc, serializeBrewDoc } = corePkg;
const { atomicWriteFileSync } = dbPkg;

const STALE_LOCK_MS = Number(process.env.BREW_LOCK_STALE_MS ?? 30_000);
const LOCK_WAIT_MS = Number(process.env.BREW_LOCK_WAIT_MS ?? 60_000);
const CRASH_HOOK = process.env.BREW_UPGRADE_CRASH_HOOK ?? null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function readSchemaVersion(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed.schemaVersion : undefined;
  } catch {
    return undefined;
  }
}

class LockBusy extends Error {}

/** 原子 mkdir 抢锁；锁存在且未陈旧时抛 LockBusy；陈旧锁先清再接管。 */
function tryAcquireLock(lockDir, token) {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    } catch {
      // 锁目录在、owner.json 还没落盘：按陈旧处理。
    }
    const age = owner && Number.isFinite(owner.startedAt) ? Date.now() - owner.startedAt : Infinity;
    if (age <= STALE_LOCK_MS) throw new LockBusy(lockDir);
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ token, pid: process.pid, host: os.hostname(), startedAt: Date.now() }, null, 2),
  );
}

async function acquireLock(lockDir, token, outPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let backoff = 0;
  for (;;) {
    try {
      tryAcquireLock(lockDir, token);
      return;
    } catch (error) {
      if (!(error instanceof LockBusy)) throw error;
      // 等锁期间先看 out：对端若已落盘最新结果，读到即退，绝不重复写。
      if (readSchemaVersion(outPath) === SCHEMA_VERSION) {
        process.stdout.write(`跳过: 另一进程已完成升级，读到 ${outPath}（schemaVersion=${SCHEMA_VERSION}）\n`);
        process.exit(0);
      }
      if (Date.now() >= deadline) throw new Error(`等待升级锁超时: ${lockDir}`);
      backoff = Math.min(backoff + 1, 6);
      await sleep(25 * 2 ** backoff);
    }
  }
}

/** 只删自己持有的锁，避免误删被陈旧接管后属于别人的锁。 */
function releaseLock(lockDir, token) {
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return;
  }
  if (owner.token !== token) return;
  fs.rmSync(lockDir, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    process.stderr.write('用法: node scripts/upgrade-legacy.mjs --in <legacy.json> --out <brew.json> [--report <report.html>]\n');
    process.exit(2);
  }

  const inPath = path.resolve(args.in);
  const outPath = path.resolve(args.out);
  const reportPath = args.report ? path.resolve(args.report) : null;
  const lockDir = `${outPath}.lock`;
  const token = randomUUID();

  // 锁目录与临时文件都在 out 同级，先确保父目录存在。
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let locked = false;
  try {
    await acquireLock(lockDir, token, outPath);
    locked = true;

    // 持锁后 double-check：等锁期间对端可能已经完成。
    if (readSchemaVersion(outPath) === SCHEMA_VERSION) {
      process.stdout.write(`跳过: ${args.out} 已是 schemaVersion=${SCHEMA_VERSION}，无需重写\n`);
      return;
    }

    // 输入只读：解析旧数据，所有归一化都在内存中完成。
    const legacy = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    const { doc, stats } = migrateBrewDoc(legacy);

    // 先备份旧 out，再原子替换；异常时旧文件原样，现场只多一份 .bak。
    let backupPath = null;
    if (fs.existsSync(outPath)) {
      backupPath = `${outPath}.bak`;
      fs.copyFileSync(outPath, backupPath);
    }
    if (CRASH_HOOK === 'after_backup') {
      throw new Error('注入故障: 备份完成后中止（演练崩溃安全）');
    }

    atomicWriteFileSync(outPath, serializeBrewDoc(doc));
    if (CRASH_HOOK === 'after_data_write') {
      throw new Error('注入故障: 数据落盘后中止（演练崩溃安全）');
    }

    // report 是派生物：仅在不存在时写出，保证二次运行整棵产物树都不动。
    if (reportPath && !fs.existsSync(reportPath)) {
      atomicWriteFileSync(reportPath, renderReport({ doc, stats }));
    }

    const backupNote = backupPath
      ? `，备份 ${path.relative(process.cwd(), backupPath) || backupPath}`
      : '';
    process.stdout.write(
      `升级完成: 输入 ${stats.inputCount} 条，保留 ${stats.kept} 条，`
      + `解析失败剔除 ${stats.droppedUnparsable} 条，按 id 去重 ${stats.duplicates} 条，`
      + `schemaVersion=${SCHEMA_VERSION}${backupNote}\n`,
    );
  } finally {
    if (locked) {
      try {
        releaseLock(lockDir, token);
      } catch {
        // 释放失败最多让下一个进程多等一个陈旧锁周期，不能掩盖主流程结果。
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`升级失败: ${error.message}\n`);
  process.exit(1);
});