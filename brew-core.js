'use strict';

/**
 * brew-core.js — 冲煮记录读写通路的唯一事实来源（single source of truth）。
 *
 * 设计说明（为何归一化放在写端，而不是读端逐次换算）：
 * - 写端一次性把水温、粉水比、萃取时长按固定精度落盘并盖 schemaVersion，
 *   磁盘上的数据此后即为“规范态”。读端无需再猜单位、精度或字段是否缺失，
 *   聚合/排序/报告全部建立在同一份规范数据上，避免每条记录在每次读取、
 *   每个路由、每次聚合里被重复换算（重复换算还会造成浮点漂移与口径不一致）。
 * - 旧数据兼容的代价因此前移到一次性升级脚本（scripts/upgrade-legacy.mjs）：
 *   补默认值、夹取越界、按 id 去重、剔除坏时间戳，这些“脏活”只做一次，
 *   而不是让线上读路径长期背着历史包袱、为每个请求付出代价。
 * - 读端只在 schemaVersion 落后时做迁移（migrateBrewDoc），且迁移逻辑与
 *   写端共用同一套归一化函数，保证升级脚本与运行时读路径行为完全一致。
 */

const SCHEMA_VERSION = 1;

// 各字段落盘的固定精度（小数位数）。
const PRECISION = { temperature: 1, ratio: 2, duration: 0 };
// 物理上可接受的取值范围，越界值在迁移时被夹取到边界。
const LIMITS = {
  temperature: { min: 0, max: 100 }, // 摄氏度
  ratio: { min: 1, max: 30 },        // 粉水比 1:n
  duration: { min: 0, max: 3600 },    // 秒
};
// 字段缺失或无法解析时补的默认值。
const DEFAULTS = { temperature: 92.0, ratio: 15.0, duration: 180 };

const METRICS = ['temperature', 'ratio', 'duration'];

const PLACEHOLDER = '—';

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 解析一个测量字段。
 * - 纯数字（含数字字符串）按数值处理；
 * - 粉水比兼容旧式 "1:16" / "1/16" 字符串，取除数；
 * - 无法解析返回 null（由调用方决定补默认值还是丢弃整条记录）。
 * 返回的值会被夹取到 limits 并按 precision 取整；normal 表示该值是否
 * 来自“正常输入”（false 表示该字段触发了默认值/夹取，供报告统计）。
 */
function normalizeMeasure(value, { precision, min, max, fallback }) {
  let parsed = null;
  if (isFiniteNumber(value)) {
    parsed = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    const ratioMatch = /^[\d.]+(?:\s*[:/]\s*([\d.]+))?$/.exec(text);
    if (ratioMatch && ratioMatch[1] !== undefined) {
      const divisor = Number(ratioMatch[1]);
      if (isFiniteNumber(divisor)) parsed = divisor;
    } else if (text !== '') {
      const numeric = Number(text);
      if (isFiniteNumber(numeric)) parsed = numeric;
    }
  }

  if (parsed === null) {
    return { value: roundTo(fallback, precision), clamped: false, missing: true };
  }

  const clamped = parsed < min || parsed > max;
  const bounded = clamp(parsed, min, max);
  return { value: roundTo(bounded, precision), clamped, missing: false };
}

/**
 * 解析冲煮时间戳，返回 epoch 毫秒；无法解析返回 null（该条目将被剔除）。
 * 支持 epoch 毫秒/秒数字与 ISO/常见日期字符串。
 */
function parseTimestamp(value) {
  if (isFiniteNumber(value)) {
    // 秒级时间戳（10 位左右）归一为毫秒；其余按毫秒处理。
    const millis = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(new Date(millis).getTime()) ? millis : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const millis = Date.parse(value.trim());
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

/**
 * 把一条任意来源的记录规范成落盘形态。
 * 时间戳无法解析时返回 null（条目级剔除）；id 缺失时抛错由去重阶段兜底，
 * 这里统一为 null 同样剔除。
 */
function canonicalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const id = entry.id === undefined || entry.id === null ? null : String(entry.id);
  if (id === null || id === '') return null;

  const brewedAt = parseTimestamp(entry.brewedAt ?? entry.timestamp ?? entry.time);
  if (brewedAt === null) return null;

  const flags = { missing: [], clamped: [] };
  const out = { id, brewedAt };

  for (const metric of METRICS) {
    const result = normalizeMeasure(entry[metric], {
      precision: PRECISION[metric],
      min: LIMITS[metric].min,
      max: LIMITS[metric].max,
      fallback: DEFAULTS[metric],
    });
    out[metric] = result.value;
    if (result.missing) flags.missing.push(metric);
    if (result.clamped) flags.clamped.push(metric);
  }

  out.method = typeof entry.method === 'string' ? entry.method.trim() : '';

  return { entry: out, flags };
}

/**
 * 读端迁移：只应在 schemaVersion 落后时被调用。
 * 依次完成：条目规范化（补默认值、夹取越界）→ 剔除坏条目 →
 * 按 id 去重（保留首次出现）→ 按解析后的时间戳升序排序。
 * 返回 { doc, stats }，doc 为可直接落盘的规范文档。
 */
function migrateBrewDoc(rawDoc) {
  const sourceEntries = Array.isArray(rawDoc) ? rawDoc
    : (rawDoc && typeof rawDoc === 'object' && Array.isArray(rawDoc.entries)) ? rawDoc.entries
    : [];

  const seenIds = new Set();
  const canonical = [];
  let droppedUnparsable = 0;
  let duplicates = 0;
  const missingFields = [];
  const clampedFields = [];

  for (const sourceEntry of sourceEntries) {
    const result = canonicalizeEntry(sourceEntry);
    if (result === null) {
      droppedUnparsable += 1;
      continue;
    }
    if (seenIds.has(result.entry.id)) {
      duplicates += 1;
      continue;
    }
    seenIds.add(result.entry.id);
    canonical.push(result.entry);
    missingFields.push(...result.flags.missing);
    clampedFields.push(...result.flags.clamped);
  }

  // 排序依据是解析后的时间戳（epoch 毫秒），而非原始字符串。
  canonical.sort((a, b) => a.brewedAt - b.brewedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    entries: canonical,
  };

  return {
    doc,
    stats: {
      inputCount: sourceEntries.length,
      kept: canonical.length,
      droppedUnparsable,
      duplicates,
      missingFields,
      clampedFields,
    },
  };
}

/**
 * 写端入口：新数据进入系统时走这里，产出的就是规范文档。
 */
function buildBrewDoc(entries) {
  return migrateBrewDoc({ schemaVersion: 0, entries }).doc;
}

/**
 * 读端入口：已是当前版本则原样返回（不重写、不换算）；
 * 仅在版本落后或缺位时迁移。
 */
function readBrewDoc(rawDoc) {
  if (rawDoc && typeof rawDoc === 'object' && rawDoc.schemaVersion === SCHEMA_VERSION) {
    return { doc: rawDoc, migrated: false, stats: null };
  }
  return { ...migrateBrewDoc(rawDoc), migrated: true };
}

/**
 * 规范化序列化：固定键序、两空格缩进、行尾 \n。
 * 幂等的落盘保障之一——同一文档任何时候序列化结果字节级一致。
 */
function serializeBrewDoc(doc) {
  const ordered = { schemaVersion: doc.schemaVersion, entries: doc.entries };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 聚合前剔空值；全部为空时返回占位符，绝不产出 NaN。 */
function average(values) {
  const valid = values.filter(isFiniteNumber);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

/**
 * 卡片聚合：每个指标只统计非空（非 null/undefined/NaN）的记录值。
 * 全空指标使用占位符 '—'。
 */
function aggregate(entries) {
  const result = { count: entries.length, averages: {}, trend: {} };
  for (const metric of METRICS) {
    const values = entries
      .map((entry) => entry[metric])
      .filter((value) => value !== null && value !== undefined && isFiniteNumber(value));
    const mean = average(values);
    result.averages[metric] = mean === null ? null : roundTo(mean, PRECISION[metric]);
    // 趋势序列按已排序记录给出；剔空值后若没有任何点则为空序列。
    result.trend[metric] = values.length === 0
      ? []
      : entries
          .filter((entry) => isFiniteNumber(entry[metric]))
          .map((entry) => ({ brewedAt: entry.brewedAt, id: entry.id, value: entry[metric] }));
  }
  return result;
}

module.exports = {
  SCHEMA_VERSION,
  PRECISION,
  LIMITS,
  DEFAULTS,
  METRICS,
  PLACEHOLDER,
  roundTo,
  normalizeMeasure,
  parseTimestamp,
  canonicalizeEntry,
  migrateBrewDoc,
  buildBrewDoc,
  readBrewDoc,
  serializeBrewDoc,
  aggregate,
};
