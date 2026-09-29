/**
 * render-report.mjs — 把迁移结果渲染成确定性的单文件 HTML 报告。
 * 卡片聚合剔空值、全空显示占位符；趋势图严格按解析后的时间戳次序
 * （迁移时已排序）绘制内联 SVG，无外链、无随机数、无生成时间戳，
 * 因而同一份输入两次渲染字节级一致。
 */

import corePkg from '../brew-core.js';

const { METRICS, PRECISION, PLACEHOLDER, aggregate } = corePkg;

const METRIC_LABELS = {
  temperature: { title: '平均水温', unit: '°C', color: '#c2410c' },
  ratio: { title: '平均粉水比', unit: '', color: '#1d4ed8' },
  duration: { title: '平均萃取时长', unit: 's', color: '#15803d' },
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAverage(metric, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return PLACEHOLDER;
  return `${value.toFixed(PRECISION[metric])}${METRIC_LABELS[metric].unit}`;
}

function buildSvg(entries, summary) {
  const width = 720;
  const height = 240;
  const padding = 28;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  const xFor = (index) => {
    if (entries.length <= 1) return padding + innerWidth / 2;
    return padding + (innerWidth * index) / (entries.length - 1);
  };

  const polylines = METRICS.map((metric) => {
    const points = summary.trend[metric];
    const meta = METRIC_LABELS[metric];
    if (points.length === 0) {
      return { metric, color: meta.color, label: meta.title, points: '', empty: true };
    }
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const yFor = (value) => {
      if (span === 0) return padding + innerHeight / 2;
      return padding + innerHeight - (innerHeight * (value - min)) / span;
    };
    // 点的 x 位置必须按时间戳次序；entries 已按 brewedAt 升序。
    const indexById = new Map(entries.map((entry, index) => [entry.id, index]));
    const ordered = [...points].sort((a, b) => {
      const timeDelta = a.brewedAt - b.brewedAt;
      return timeDelta !== 0 ? timeDelta : indexById.get(a.id) - indexById.get(b.id);
    });
    const coordinateList = ordered
      .map((point) => {
        const x = xFor(indexById.get(point.id));
        const y = yFor(point.value);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
    return { metric, color: meta.color, label: meta.title, points: coordinateList, empty: false, min, max };
  });

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = padding + innerHeight * ratio;
      return `<line x1="${padding}" y1="${y.toFixed(2)}" x2="${width - padding}" y2="${y.toFixed(2)}" class="grid"/>`;
    })
    .join('');

  const lineSvg = polylines
    .map((line) => {
      if (line.empty) return '';
      return `<polyline points="${line.points}" fill="none" stroke="${line.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join('');

  const legend = polylines
    .map((line) => `<span class="legend-item"><i style="background:${line.color}"></i>${escapeHtml(line.label)}${line.empty ? `（${PLACEHOLDER}）` : ''}</span>`)
    .join('');

  return `<div class="legend">${legend}</div>
<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="冲煮指标趋势图（按时间升序）">
  ${gridLines}
  ${lineSvg}
</svg>`;
}

function buildRows(entries) {
  if (entries.length === 0) {
    return '<tr><td colspan="5" class="placeholder">无有效记录</td></tr>';
  }
  return entries
    .map((entry) => {
      const when = new Date(entry.brewedAt).toISOString();
      return `<tr>
  <td>${escapeHtml(entry.id)}</td>
  <td>${escapeHtml(when)}</td>
  <td>${entry.temperature.toFixed(PRECISION.temperature)}</td>
  <td>${entry.ratio.toFixed(PRECISION.ratio)}</td>
  <td>${entry.duration.toFixed(PRECISION.duration)}</td>
</tr>`;
    })
    .join('');
}

export function renderReport({ doc, stats }) {
  const summary = aggregate(doc.entries);
  const cards = METRICS.map((metric) => {
    const meta = METRIC_LABELS[metric];
    return `<div class="card">
  <div class="card-label">${escapeHtml(meta.title)}</div>
  <div class="card-value">${escapeHtml(formatAverage(metric, summary.averages[metric]))}</div>
</div>`;
  }).join('');

  const droppedNote = stats.droppedUnparsable > 0
    ? `<li>解析失败剔除：<strong>${stats.droppedUnparsable}</strong> 条</li>`
    : '<li>解析失败剔除：0 条</li>';
  const duplicateNote = stats.duplicates > 0
    ? `<li>按 id 去重：<strong>${stats.duplicates}</strong> 条</li>`
    : '<li>按 id 去重：0 条</li>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>冲煮记录升级报告</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #faf7f2; color: #292524; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #78716c; font-size: 13px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 16px; }
  .card-label { font-size: 12px; color: #78716c; margin-bottom: 6px; }
  .card-value { font-size: 24px; font-weight: 650; }
  section { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 18px; margin-bottom: 20px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; font-size: 12px; color: #57534e; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-item i { width: 12px; height: 3px; border-radius: 2px; display: inline-block; }
  .grid { stroke: #f1efec; stroke-width: 1; }
  ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.9; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f1efec; }
  th { color: #78716c; font-weight: 600; }
  .placeholder { text-align: center; color: #a8a29e; padding: 20px; }
</style>
</head>
<body>
<main>
  <h1>冲煮记录升级报告</h1>
  <div class="sub">schemaVersion: ${doc.schemaVersion}</div>
  <div class="cards">
    <div class="card">
      <div class="card-label">有效记录</div>
      <div class="card-value">${summary.count}</div>
    </div>
    ${cards}
  </div>
  <section>
    <h2>趋势（按解析后的时间戳升序）</h2>
    ${buildSvg(doc.entries, summary)}
  </section>
  <section>
    <h2>升级明细</h2>
    <ul>
      <li>输入条目：${stats.inputCount} 条</li>
      <li>保留条目：${stats.kept} 条</li>
      ${droppedNote}
      ${duplicateNote}
    </ul>
  </section>
  <section>
    <h2>记录明细</h2>
    <table>
      <thead><tr><th>id</th><th>时间</th><th>水温 (°C)</th><th>粉水比</th><th>时长 (s)</th></tr></thead>
      <tbody>
        ${buildRows(doc.entries)}
      </tbody>
    </table>
  </section>
</main>
</body>
</html>
`;
}
