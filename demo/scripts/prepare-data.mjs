import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
const results = path.join(root, 'results');
const evidence = path.join(root, 'demo/public/evidence/fresh');
fs.mkdirSync(evidence, {recursive: true});

const candidates = fs.readdirSync(results).filter(name => name.startsWith('fresh-') && fs.existsSync(path.join(results, name, 'run-windows.json'))).sort();
assert(candidates.length, 'No completed fresh comparison found');
const directory = candidates.at(-1);
const source = path.join(results, directory);
const windows = JSON.parse(fs.readFileSync(path.join(source, 'run-windows.json'), 'utf8'));
const stamp = windows.stamp;
const specs = [
  {key: 'kv', policy: 'KV-aware', prefix: 'locust-kv'},
  {key: 'cpu', policy: 'CPU HPA', prefix: 'locust-cpu'},
];

function parseLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert(text.includes('Shape test completed'), `Incomplete Locust workload: ${file}`);
  const summary = [...text.matchAll(/Aggregated\s+(\d+)\s+(\d+)\([^)]+\)\s+\|\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/g)].at(-1);
  const percentile = text.split('Response time percentiles (approximated)').at(-1).split(/\r?\n/).find(line => line.includes('Aggregated'));
  assert(summary && percentile, `Cannot parse Locust summary: ${file}`);
  const values = percentile.slice(percentile.indexOf('Aggregated') + 'Aggregated'.length).trim().split(/\s+/).map(Number);
  assert(values.length === 12 && values.every(Number.isFinite), `Cannot parse Locust percentiles: ${file}`);
  return {
    requests: Number(summary[1]),
    failures: Number(summary[2]),
    mean: Number(summary[3]) / 1000,
    median: Number(summary[6]) / 1000,
    p95: values[5] / 1000,
  };
}

function parseCsv(file, start, end) {
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).map(line => {
    const [unix, metric, instance, raw] = line.split(',');
    const value = Number(raw);
    return {unix: Number(unix), metric, instance, value: Number.isFinite(value) ? value : null};
  });
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.metric)) groups.set(row.metric, new Map());
    const times = groups.get(row.metric);
    if (!times.has(row.unix)) times.set(row.unix, []);
    times.get(row.unix).push(row);
  }
  const keys = ['e2e_p95_seconds', 'queue_p95_seconds', 'requests_per_second', 'healthy_targets', 'running', 'kv_usage', 'waiting'];
  const metrics = {};
  for (const key of keys) {
    const points = groups.get(key) || new Map();
    metrics[key] = [];
    for (let unix = start; unix <= end; unix += 5) {
      const samples = points.get(unix) || [];
      const finite = samples.filter(sample => sample.value !== null);
      let value = null;
      if (finite.length && finite.length === samples.length) {
        value = key === 'kv_usage'
          ? Math.max(...finite.map(sample => sample.value)) * 100
          : key === 'healthy_targets'
            ? finite[0].value
            : key === 'e2e_p95_seconds' || key === 'queue_p95_seconds'
              ? finite[0].value
              : finite.reduce((total, sample) => total + sample.value, 0);
      }
      metrics[key].push({unix, elapsed: unix - start, value, instances: finite.length});
    }
  }
  return metrics;
}

const runs = specs.map(spec => {
  const name = `${spec.prefix}-${stamp}`;
  const log = `${name}.log`;
  const csv = `${name}_metrics.csv`;
  const metadata = `${name}_metrics.json`;
  const start = Date.parse(windows[spec.key].start) / 1000;
  const end = Date.parse(windows[spec.key].end) / 1000;
  assert(Number.isFinite(start) && end > start, `Invalid ${spec.key} timestamps`);
  const summary = parseLog(path.join(source, log));
  const metrics = parseCsv(path.join(source, csv), start, end);
  for (const key of ['e2e_p95_seconds', 'queue_p95_seconds', 'healthy_targets']) {
    assert(metrics[key].some(point => point.value !== null), `Missing ${key}: ${name}`);
  }
  for (const file of [log, csv, metadata]) fs.copyFileSync(path.join(source, file), path.join(evidence, file));
  const health = metrics.healthy_targets;
  const firstOne = health.findIndex(point => point.value === 1);
  const nextTwo = health.slice(firstOne + 1).find(point => point.value === 2);
  return {...spec, name, log, csv, start, end, ...summary, metrics,
    firstTwoAfterOne: firstOne >= 0 && nextTwo ? nextTwo.unix : null};
});

assert.deepEqual(runs.map(run => [run.requests, run.failures, run.mean, run.median, run.p95]),
  [[800, 0, 2.983, 3.1, 3.4], [666, 1, 3.549, 3.1, 3.4]],
  'Fresh Locust summaries differ from reviewed run; inspect before publishing');

const controllerName = 'controller.log';
const controller = fs.readFileSync(path.join(source, controllerName), 'utf8').split(/\r?\n/).flatMap(line => {
  const brace = line.indexOf('{');
  if (brace < 0) return [];
  try { return [JSON.parse(line.slice(brace))]; } catch { return []; }
});
const decisions = controller.filter(event => event.event === 'scale').map(event => ({
  timestamp: event.timestamp,
  elapsed: Date.parse(event.timestamp) / 1000 - runs[0].start,
  replicas: event.replicas,
  reason: event.reason,
  signals: event.signals,
}));
for (const file of [controllerName, 'hpa-final-snapshot.txt', 'run-windows.json']) {
  fs.copyFileSync(path.join(source, file), path.join(evidence, file));
}
const data = {directory, stamp, runs, decisions};
fs.writeFileSync(path.join(root, 'demo/src/data.json'), JSON.stringify(data));
console.log(`Verified fresh Locust summaries and bundled ${directory} Prometheus observations.`);
