'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../brew-core.js');

test('写端按各自固定精度落盘并盖 schemaVersion', () => {
  const doc = core.buildBrewDoc([
    { id: 'a', brewedAt: '2026-09-20T00:00:00Z', temperature: 93.256, ratio: 14.333, duration: 175.6 },
  ]);
  assert.equal(doc.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(doc.entries[0].temperature, 93.3);
  assert.equal(doc.entries[0].ratio, 14.33);
  assert.equal(doc.entries[0].duration, 176);
});

test('粉水比兼容旧式 1:n 与 1/n 字符串', () => {
  const doc = core.buildBrewDoc([
    { id: 'a', brewedAt: '2026-09-20T00:00:00Z', ratio: '1:16.5' },
    { id: 'b', brewedAt: '2026-09-21T00:00:00Z', ratio: '1/17' },
  ]);
  assert.equal(doc.entries[0].ratio, 16.5);
  assert.equal(doc.entries[1].ratio, 17);
});

test('迁移补默认值并夹取越界', () => {
  const { doc, stats } = core.migrateBrewDoc([
    { id: 'a', brewedAt: '2026-09-20T00:00:00Z' },
    { id: 'b', brewedAt: '2026-09-21T00:00:00Z', temperature: 142, ratio: 99, duration: 99999 },
    { id: 'c', brewedAt: '2026-09-22T00:00:00Z', temperature: 'hot', ratio: null, duration: -50 },
  ]);
  assert.deepEqual(doc.entries[0].temperature, core.DEFAULTS.temperature);
  assert.equal(doc.entries[1].temperature, 100);
  assert.equal(doc.entries[1].ratio, 30);
  assert.equal(doc.entries[1].duration, 3600);
  assert.equal(doc.entries[2].temperature, core.DEFAULTS.temperature);
  assert.equal(doc.entries[2].duration, 0);
  assert.ok(stats.missingFields.includes('temperature'));
  assert.ok(stats.clampedFields.includes('temperature'));
});

test('按 id 去重并计数（保留首次出现）', () => {
  const { doc, stats } = core.migrateBrewDoc([
    { id: 'x', brewedAt: '2026-09-20T00:00:00Z', temperature: 90 },
    { id: 'x', brewedAt: '2026-09-20T01:00:00Z', temperature: 91 },
  ]);
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].temperature, 90);
  assert.equal(stats.duplicates, 1);
});

test('解析失败的条目剔除并计数（坏时间戳/缺 id）', () => {
  const { doc, stats } = core.migrateBrewDoc([
    { id: 'a', brewedAt: 'not-a-date' },
    { id: '', brewedAt: '2026-09-20T00:00:00Z' },
    { brewedAt: '2026-09-20T00:00:00Z' },
    { id: 'ok', brewedAt: '2026-09-20T00:00:00Z' },
  ]);
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].id, 'ok');
  assert.equal(stats.droppedUnparsable, 3);
});

test('排序按解析后的时间戳（ISO / unix 秒 / 带时区）', () => {
  const { doc } = core.migrateBrewDoc([
    { id: 'late', brewedAt: '2026-09-22T01:00:00Z' },
    { id: 'unix', brewedAt: 1790000000 },
    { id: 'tz', brewedAt: '2026-09-22T10:00:00+08:00' },
    { id: 'early', brewedAt: '2026-09-20T00:00:00Z' },
  ]);
  assert.deepEqual(doc.entries.map((entry) => entry.id), ['early', 'unix', 'late', 'tz']);
});

test('当前版本读端原样返回不迁移', () => {
  const current = { schemaVersion: core.SCHEMA_VERSION, entries: [{ id: 'z', brewedAt: 1 }] };
  const result = core.readBrewDoc(current);
  assert.equal(result.migrated, false);
  assert.equal(result.doc, current);
});

test('迁移幂等：同一份输入连喂两次字节级一致', () => {
  const raw = [
    { id: 'a', brewedAt: '2026-09-21T00:00:00Z', temperature: 93.256, ratio: '1:16.5', duration: '210' },
    { id: 'a', brewedAt: '2026-09-22T00:00:00Z' },
    { id: 'b', brewedAt: 'bad' },
  ];
  const first = core.serializeBrewDoc(core.migrateBrewDoc(raw).doc);
  const upgraded = JSON.parse(first);
  const second = core.serializeBrewDoc(core.readBrewDoc(upgraded).doc);
  assert.equal(first, second);
});

test('聚合剔空值，全空输出 null/占位符而非 NaN', () => {
  assert.deepEqual(core.aggregate([]).averages, { temperature: null, ratio: null, duration: null });
  const summary = core.aggregate([
    { id: 'a', brewedAt: 1, temperature: 90, ratio: 15, duration: 180 },
    { id: 'b', brewedAt: 2, temperature: 94, ratio: 17, duration: 200 },
  ]);
  assert.equal(summary.averages.temperature, 92);
  assert.equal(summary.averages.ratio, 16);
  assert.equal(summary.averages.duration, 190);
  for (const metric of core.METRICS) {
    assert.ok(!Number.isNaN(summary.averages[metric]));
    assert.equal(summary.trend[metric].length, 2);
  }
});
