'use strict';

/**
 * brew-core.js —— 冲煮记录读/写/聚合的唯一口径（single source of truth）。
 *
 * 为什么把归一化放在「写端」，而不是读端每次现算：
 * 1. 写端落盘时就把水温、粉水比、萃取时长统一到各自的固定精度并盖上
 *    schemaVersion，磁盘上从此只有一种规范形态。读端不必再猜单位、精度或
 *    缺字段的含义，排序、聚合、渲染报告全部建立在同一份规范数据上。
 * 2. 若放到读端逐次换算，同一条记录会在每个路由、每次聚合里被反复换算，
 *    既浪费又会因浮点反复取整产生漂移、各路径口径还可能逐渐分叉。
 * 3. 旧数据兼容的代价因此「前移」到一次性升级脚本
 *    （scripts/upgrade-legacy.mjs）：补默认值、夹取越界、按 id 去重、剔除
 *    坏时间戳这些脏活只做一次；线上读路径不再长期背历史包袱。
 * 4. 读端仅在 schemaVersion 落后时迁移（readBrewDoc -> migrateBrewDoc），
 *    且与写端共用同一套规范化函数，保证升级脚本与运行时行为一致。
 */

const SCHEMA_VERSION = 1;

// 各指标落盘的固定精度（小数位数）。
const PRECISION = Object.freeze({ temperature: 1, ratio: 2, duration: 0 });

// 物理合理区间，越界值迁移时夹取到边界。
const LIMITS = Object.freeze({
  temperature: { min: 0, max: 100 }, // 摄氏度
  ratio: { min: 1, max: 30 },        // 粉水比 1:n
  duration: { min: 0, max: 3600 },   // 秒
});

// 缺字段 / 无法解析时补的默认值。
const DEFAULTS = Object.freeze({ temperature: 92.0, ratio: 15.0, duration: 180 });

const METRICS = Object.freeze(['temperature', 'ratio', 'duration']);

// 聚合结果全空时卡片上展示的占位符，杜绝 NaN 泄漏。
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
 * 规范化单个测量值。
 * - 数字（含可直接转成数字的字符串）按数值处理；
 * - 粉水比兼容旧式 "1:16.5" / "1/17" 写法，取冒号/斜杠后的除数；
 * - 无法解析时回退到 fallback（并标记 missing）。
 * 返回 { value, missing, clamped }：value 已夹取并按固定精度取整。
 */
function normalizeMeasure(raw, { precision, min, max, fallback }) {
  let parsed = null;

  if (isFiniteNumber(raw)) {
    parsed = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (text !== '') {
      const paired = /^[\d.]+\s*[:/]\s*([\d.]+)$/.exec(text);
      if (paired) {
        const divisor = Number(paired[1]);
        if (isFiniteNumber(divisor)) parsed = divisor;
      } else {
        const numeric = Number(text);
        if (isFiniteNumber(numeric)) parsed = numeric;
      }
    }
  }

  if (parsed === null) {
    return { value: roundTo(fallback, precision), missing: true, clamped: false };
  }

  const outOfRange = parsed < min || parsed > max;
  return {
    value: roundTo(clamp(parsed, min, max), precision),
    missing: false,
    clamped: outOfRange,
  };
}

/**
 * 解析冲煮时间戳，返回 epoch 毫秒；解析失败返回 null（该条目将被剔除）。
 * 接受：ISO/常见日期字符串、毫秒数字、秒级 unix 时间戳（< 1e12 视为秒）。
 */
function parseTimestamp(raw) {
  if (isFiniteNumber(raw)) {
    const millis = raw < 1e12 ? raw * 1000 : raw;
    return Number.isFinite(new Date(millis).getTime()) ? millis : null;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const millis = Date.parse(raw.trim());
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

/**
 * 把任意来源的一条记录规范化成落盘形态。
 * 非对象、缺/空 id、时间戳无法解析时返回 null（条目级剔除）。
 * 否则返回 { entry, flags }，flags 记录触发默认值/夹取的字段，供报告统计。
 */
function canonicalizeEntry(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;

  if (source.id === undefined || source.id === null) return null;
  const id = String(source.id);
  if (id === '') return null;

  const brewedAt = parseTimestamp(source.brewedAt ?? source.timestamp ?? source.time);
  if (brewedAt === null) return null;

  const entry = { id, brewedAt };
  const flags = { missing: [], clamped: [] };

  for (const metric of METRICS) {
    const outcome = normalizeMeasure(source[metric], {
      precision: PRECISION[metric],
      min: LIMITS[metric].min,
      max: LIMITS[metric].max,
      fallback: DEFAULTS[metric],
    });
    entry[metric] = outcome.value;
    if (outcome.missing) flags.missing.push(metric);
    if (outcome.clamped) flags.clamped.push(metric);
  }

  entry.method = typeof source.method === 'string' ? source.method.trim() : '';
  return { entry, flags };
}

/**
 * 迁移核心：规范化 -> 剔除坏条目 -> 按 id 去重（保留首次出现）
 * -> 按解析后的时间戳升序排序（同时间戳再按 id 稳定排序）。
 * 入参可以是裸数组，也可以是 { schemaVersion, entries } 文档。
 */
function migrateBrewDoc(rawDoc) {
  const sourceEntries = Array.isArray(rawDoc)
    ? rawDoc
    : (rawDoc && typeof rawDoc === 'object' && Array.isArray(rawDoc.entries))
      ? rawDoc.entries
      : [];

  const seenIds = new Set();
  const entries = [];
  const missingFields = [];
  const clampedFields = [];
  let droppedUnparsable = 0;
  let duplicates = 0;

  for (const source of sourceEntries) {
    const result = canonicalizeEntry(source);
    if (result === null) {
      droppedUnparsable += 1;
      continue;
    }
    if (seenIds.has(result.entry.id)) {
      duplicates += 1;
      continue;
    }
    seenIds.add(result.entry.id);
    entries.push(result.entry);
    missingFields.push(...result.flags.missing);
    clampedFields.push(...result.flags.clamped);
  }

  // 排序依据是解析后的 epoch 毫秒，而不是原始字符串（字符串在跨格式时不可靠）。
  entries.sort((a, b) => (a.brewedAt - b.brewedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    doc: { schemaVersion: SCHEMA_VERSION, entries },
    stats: {
      inputCount: sourceEntries.length,
      kept: entries.length,
      droppedUnparsable,
      duplicates,
      missingFields,
      clampedFields,
    },
  };
}

/** 写端入口：新数据进入系统即产出规范文档并盖当前 schemaVersion。 */
function buildBrewDoc(entries) {
  return migrateBrewDoc(entries).doc;
}

/**
 * 读端入口：已是当前版本则原样返回（不重写、不换算）；
 * 版本落后或缺 schemaVersion 才迁移。
 */
function readBrewDoc(rawDoc) {
  if (rawDoc && typeof rawDoc === 'object' && rawDoc.schemaVersion === SCHEMA_VERSION) {
    return { doc: rawDoc, migrated: false, stats: null };
  }
  return { ...migrateBrewDoc(rawDoc), migrated: true };
}

/**
 * 确定性序列化：固定键序、两空格缩进、结尾单个 \n。
 * 同一文档任何时刻序列化都字节一致，是落盘幂等的基础。
 */
function serializeBrewDoc(doc) {
  const ordered = { schemaVersion: doc.schemaVersion, entries: doc.entries };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 聚合前剔空值；一个有效值都没有时返回 null（由上层转占位符），绝不返回 NaN。 */
function average(values) {
  const valid = values.filter(isFiniteNumber);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

/**
 * 卡片聚合：每个指标只计入非空且为有限数的记录。
 * trend 序列沿用已排序条目顺序；某指标全空时 trend 为空序列。
 */
function aggregate(entries) {
  const summary = { count: entries.length, averages: {}, trend: {} };
  for (const metric of METRICS) {
    const points = entries
      .filter((entry) => isFiniteNumber(entry[metric]))
      .map((entry) => ({ brewedAt: entry.brewedAt, id: entry.id, value: entry[metric] }));

    summary.averages[metric] = points.length === 0
      ? null
      : roundTo(average(points.map((point) => point.value)), PRECISION[metric]);
    summary.trend[metric] = points;
  }
  return summary;
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