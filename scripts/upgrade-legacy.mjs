#!/usr/bin/env node
/**
 * upgrade-legacy.mjs — 一次性旧数据升级器。
 *
 * 用法:
 *   node scripts/upgrade-legacy.mjs --in fixtures/legacy.json \
 *       --out out/brew.json --report out/report.html
 *
 * 幂等/并发/崩溃安全保证：
 * - 同一份输入连喂两次产物字节级一致：已升级（schemaVersion 最新）的
 *   out 不会被重写（mtime 都不动），已存在的 report 也原样保留。
 * - 两个进程同时升级同一文件：out 同级的 lock 目录以原子 mkdir 作为
 *   互斥锁，只有持锁者真正落盘；未抢到锁的进程轮询 out，一旦读到
 *   schemaVersion 最新的结果立即退出（读到结果即退）。
 * - 锁可因持有者崩溃而变“陈旧”（BREW_LOCK_STALE_MS，默认 30s），
 *   之后被后来者接管，避免死锁。
 * - 落盘顺序：先把旧 out 原样复制到 out.bak，再用“同目录临时文件 +
 *   rename”原子替换 out。中途任何异常都不会留下半成品：out 要么是
 *   旧内容、要么是完整新内容，现场只多出一份 .bak。
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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    }
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSchemaVersion(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return raw && typeof raw === 'object' ? raw.schemaVersion : undefined;
  } catch {
    return undefined;
  }
}

class LockBusyError extends Error {}

function tryAcquireLock(lockDir, token) {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const ownerPath = path.join(lockDir, 'owner.json');
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    } catch {
      // 锁目录存在但 owner 尚未落盘：按陈旧锁处理。
    }
    const age = owner && Number.isFinite(owner.startedAt) ? Date.now() - owner.startedAt : Infinity;
    if (age > STALE_LOCK_MS) {
      // 接管陈旧锁（持有者大概率已崩溃）。
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
    } else {
      throw new LockBusyError(lockDir);
    }
  }
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ token, pid: process.pid, host: os.hostname(), startedAt: Date.now() }, null, 2),
  );
}

async function acquireLock(lockDir, token, outPath, onPeersResult) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let backedOff = 0;
  for (;;) {
    try {
      tryAcquireLock(lockDir, token);
      return;
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      // 未持锁期间先看一眼 out：对端若已落盘最新结果，读到即退。
      if (readSchemaVersion(outPath) === SCHEMA_VERSION) {
        onPeersResult();
        process.exit(0);
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待升级锁超时: ${lockDir}`);
      }
      backedOff = Math.min(backedOff + 1, 6);
      await sleep(25 * 2 ** backedOff);
    }
  }
}

function releaseLock(lockDir, token) {
  const ownerPath = path.join(lockDir, 'owner.json');
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  } catch {
    return;
  }
  if (owner.token !== token) return; // 锁已被陈旧接管，不能删别人的。
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

  let locked = false;
  try {
    // 锁目录与临时文件都位于 out 同级，先保证父目录存在。
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await acquireLock(lockDir, token, outPath, () => {
      process.stdout.write(`跳过: 另一进程已完成升级，读到 ${args.out}（schemaVersion=${SCHEMA_VERSION}）\n`);
    });
    locked = true;

    // 持锁后二次确认（double-check）：防止在等锁期间对端已经完成。
    if (readSchemaVersion(outPath) === SCHEMA_VERSION) {
      process.stdout.write(`跳过: ${args.out} 已是 schemaVersion=${SCHEMA_VERSION}，无需重写\n`);
      return;
    }

    // 输入只读：解析旧数据，任何归一化都在内存里进行。
    const legacy = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    const { doc, stats } = migrateBrewDoc(legacy);

    // 先备份再原子替换：异常时旧 out 原样保留，现场只多出 .bak。
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

    // report 是派生物：仅在不存在时写出，保证第二次运行整棵产物树不动。
    if (reportPath && !fs.existsSync(reportPath)) {
      atomicWriteFileSync(reportPath, renderReport({ doc, stats }));
    }

    process.stdout.write(
      `升级完成: 输入 ${stats.inputCount} 条，保留 ${stats.kept} 条，`
      + `解析失败剔除 ${stats.droppedUnparsable} 条，按 id 去重 ${stats.duplicates} 条，`
      + `schemaVersion=${SCHEMA_VERSION}`
      + (backupPath ? `，备份 ${path.relative(process.cwd(), backupPath) || backupPath}` : '')
      + '\n',
    );
  } finally {
    if (locked) {
      try {
        releaseLock(lockDir, token);
      } catch {
        // 释放失败只影响陈旧锁等待时长，不能掩盖主流程结果。
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`升级失败: ${error.message}\n`);
  process.exit(1);
});
