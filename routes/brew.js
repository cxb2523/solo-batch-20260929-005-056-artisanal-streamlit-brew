'use strict';

/**
 * routes/brew.js — 冲煮记录的路由薄层。
 * 历史上散落在各路由里的“补默认值/夹取/去重/聚合”逻辑已全部上收
 * 到 brew-core.js；这里只做 HTTP 形状的参数解包与响应拼装，
 * 保证读、写、聚合只有一套口径。
 */

const db = require('../db.js');
const core = require('../brew-core.js');

async function listBrews(request, { dataFile }) {
  const { doc } = db.loadBrewDoc(dataFile);
  return { status: 200, body: { schemaVersion: doc.schemaVersion, entries: doc.entries } };
}

async function addBrew(request, { dataFile }) {
  const entry = request && request.body ? request.body : {};
  const doc = db.appendBrewEntries(dataFile, [entry]);
  return { status: 201, body: { schemaVersion: doc.schemaVersion, count: doc.entries.length } };
}

async function brewSummary(request, { dataFile }) {
  const { doc } = db.loadBrewDoc(dataFile);
  const summary = core.aggregate(doc.entries);
  // 全空指标以占位符呈现，杜绝 NaN 泄漏到卡片。
  for (const metric of core.METRICS) {
    if (summary.averages[metric] === null) summary.averages[metric] = core.PLACEHOLDER;
  }
  return { status: 200, body: summary };
}

module.exports = { listBrews, addBrew, brewSummary };
