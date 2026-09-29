'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'upgrade-legacy.mjs');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'legacy.json');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brew-upgrade-'));
}

function runUpgrade(args, env = {}, expectedExitCode = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== expectedExitCode) {
        reject(new Error(`exit=${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

test('CLI 全流程：升级、报告、二次运行产物 diff 为空、已升级不重写', async () => {
  const dir = makeTempDir();
  const outPath = path.join(dir, 'brew.json');
  const reportPath = path.join(dir, 'report.html');

  await runUpgrade(['--in', FIXTURE, '--out', outPath, '--report', reportPath]);
  const doc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(doc.schemaVersion, 1);
  // 11 条输入：坏时间戳 1、缺/空 id 2、重复 1 -> 保留 7。
  assert.equal(doc.entries.length, 7);
  assert.ok(fs.existsSync(reportPath));
  const html = fs.readFileSync(reportPath, 'utf8');
  assert.match(html, /解析失败剔除：<strong>3<\/strong>/);
  assert.match(html, /按 id 去重：<strong>1<\/strong>/);

  const firstData = fs.readFileSync(outPath);
  const firstReport = fs.readFileSync(reportPath);
  const firstStat = fs.statSync(outPath);
  const firstReportStat = fs.statSync(reportPath);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await runUpgrade(['--in', FIXTURE, '--out', outPath, '--report', reportPath]);
  assert.match(second.stdout, /已是 schemaVersion=1/);

  assert.deepEqual(fs.readFileSync(outPath), firstData, 'brew.json 两次产物必须一致');
  assert.deepEqual(fs.readFileSync(reportPath), firstReport, 'report.html 两次产物必须一致');
  assert.equal(fs.statSync(outPath).mtimeMs, firstStat.mtimeMs, '已升级文件不得重写');
  assert.equal(fs.statSync(reportPath).mtimeMs, firstReportStat.mtimeMs, '已生成报告不得重写');
  assert.ok(!fs.existsSync(path.join(dir, 'brew.json.bak')), '无需替换时不应产生 .bak');

  // 趋势图次序：明细表中的时间列必须升序。
  const times = [...html.matchAll(/<td>(\d{4}-\d{2}-\d{2}T[^<]+)<\/td>/g)].map((match) => match[1]);
  const sorted = [...times].sort();
  assert.deepEqual(times, sorted);
});

test('中途异常：原文件原样保留，只落 .bak，不留半成品', async () => {
  const dir = makeTempDir();
  const outPath = path.join(dir, 'brew.json');
  const staleContent = '{"schemaVersion":0,"entries":[]}';
  fs.writeFileSync(outPath, staleContent);

  await runUpgrade(
    ['--in', FIXTURE, '--out', outPath],
    { BREW_UPGRADE_CRASH_HOOK: 'after_backup' },
    1,
  );
  assert.equal(fs.readFileSync(outPath, 'utf8'), staleContent, '崩溃后旧 out 必须原样保留');
  assert.equal(fs.readFileSync(`${outPath}.bak`, 'utf8'), staleContent, '现场只应多出 .bak 副本');
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '不得残留临时半成品');
});

test('两个进程同时升级同一文件：只有一个落盘，另一个读到结果即退', async () => {
  const dir = makeTempDir();
  const outPath = path.join(dir, 'brew.json');
  const reportPath = path.join(dir, 'report.html');

  const first = runUpgrade(['--in', FIXTURE, '--out', outPath, '--report', reportPath], {
    // 放大持锁窗口，确保第二个进程进入等待。
    BREW_LOCK_STALE_MS: '120000',
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = runUpgrade(['--in', FIXTURE, '--out', outPath, '--report', reportPath], {
    BREW_LOCK_STALE_MS: '120000',
  });

  const [a, b] = await Promise.all([first, second]);
  const combined = `${a.stdout}\n${b.stdout}`;
  assert.match(combined, /升级完成/);
  assert.match(combined, /另一进程已完成升级|已是 schemaVersion=1/);

  const doc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.entries.length, 7);
  assert.ok(!fs.existsSync(`${outPath}.lock`), '完成后锁目录必须被清理');
});

test('陈旧锁会被接管，升级不卡死', async () => {
  const dir = makeTempDir();
  const outPath = path.join(dir, 'brew.json');
  const lockDir = `${outPath}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ token: 'dead', pid: 0, startedAt: Date.now() - 10_000 }),
  );

  await runUpgrade(['--in', FIXTURE, '--out', outPath], { BREW_LOCK_STALE_MS: '100' });
  const doc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(doc.schemaVersion, 1);
  assert.ok(!fs.existsSync(lockDir));
});

test('旧 out 被替换时产生 .bak，再次运行幂等', async () => {
  const dir = makeTempDir();
  const outPath = path.join(dir, 'brew.json');
  fs.writeFileSync(outPath, JSON.stringify({ schemaVersion: 0, entries: [] }));

  await runUpgrade(['--in', FIXTURE, '--out', outPath]);
  assert.ok(fs.existsSync(`${outPath}.bak`));
  const dataOnce = fs.readFileSync(outPath);
  await runUpgrade(['--in', FIXTURE, '--out', outPath]);
  assert.deepEqual(fs.readFileSync(outPath), dataOnce);
});
