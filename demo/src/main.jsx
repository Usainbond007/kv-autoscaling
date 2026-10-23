import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import data from './data.json';
import './style.css';

const [kv, cpu] = data.runs;
const policies = [kv, cpu];
const palette = ['#be422c', '#4c6577'];
const totalSeconds = Math.max(...policies.map(run => run.metrics.healthy_targets.at(-1).elapsed));
const sampleCount = kv.metrics.healthy_targets.length;
const time = unix => new Date(unix * 1000).toISOString().slice(11, 19);
const elapsed = seconds => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const valueText = (value, suffix, digits = 2) => value === null ? 'No sample' : `${Number(value).toFixed(digits)}${suffix}`;
const source = name => `/evidence/fresh/${name}`;
const definitions = [
  {key: 'e2e_p95_seconds', title: 'End-to-end latency - rolling p95', subtitle: 'Prometheus histogram, 30-second rate; seconds; log vertical scale', suffix: ' s', ticks: [0, 1, 3, 10, 30, 60], log: true},
  {key: 'requests_per_second', title: 'Successful request throughput', subtitle: 'Completed requests, 30-second rate; requests/s', suffix: ' req/s', ticks: [0, 1, 2, 3]},
  {key: 'healthy_targets', title: 'Healthy vLLM targets', subtitle: 'Prometheus up = 1; observed scrape targets', suffix: ' targets', ticks: [0, 1, 2]},
  {key: 'running', title: 'Running requests', subtitle: 'Sum across observed vLLM instances; requests', suffix: ' requests', ticks: [0, 4, 8]},
  {key: 'kv_usage', title: 'KV-cache usage', subtitle: 'Highest observed pod; % of configured KV cache', suffix: '%', ticks: [0, 25, 50, 75]},
  {key: 'queue_p95_seconds', title: 'Queue latency - rolling p95', subtitle: 'Prometheus histogram, 30-second rate; seconds', suffix: ' s', ticks: [0, .25, .5, .75]},
];

function Legend() {
  return <div className="legend" aria-label="Chart legend"><span><i/>KV-aware</span><span><i/>CPU HPA</span></div>;
}

function OutcomeCharts() {
  const meanMax = Math.ceil(Math.max(...policies.map(run => run.mean)));
  const failureMax = Math.max(1, ...policies.map(run => run.failures));
  const burstAverageRunning = run => {
    const points = run.metrics.running.filter(point => point.value !== null && point.elapsed >= 60 && point.elapsed < 360);
    return points.length ? points.reduce((sum, point) => sum + point.value, 0) / points.length : null;
  };
  const kvThresholdTime = kv.metrics.kv_usage.find(point => point.value !== null && point.value >= 30)?.elapsed;
  const cpuThresholdTime = cpu.metrics.kv_usage.find(point => point.value !== null && point.value >= 30)?.elapsed;
  const metrics = [
    {title: 'Failures', hint: 'Fewer is better', max: failureMax, value: run => run.failures, format: value => String(value),
      result: kv.failures + ' KV-aware failures versus ' + cpu.failures + ' CPU HPA failure.'},
    {title: 'Time to 30% KV-cache usage', hint: 'Earlier is better', max: 120,
      value: run => run.key === kv.key ? kvThresholdTime ?? null : cpuThresholdTime ?? null,
      format: value => value === null ? 'Not reached' : elapsed(value),
      result: 'KV-aware reached the threshold ' + (cpuThresholdTime - kvThresholdTime) + ' s earlier; first recorded samples, not interpolated times.'},
    {title: 'Average running requests during burst', hint: 'Same 8-user phase', max: 8, value: burstAverageRunning, format: value => value === null ? 'No samples' : value.toFixed(2),
      result: 'Average of recorded 5-second Prometheus samples from minutes 1-6.'},
    {title: 'Mean latency', hint: 'Lower is better', max: meanMax, value: run => run.mean, format: value => value.toFixed(3) + ' s',
      result: (cpu.mean - kv.mean).toFixed(3) + ' s lower (' + Math.round((1 - kv.mean / cpu.mean) * 100) + '% lower).'},
  ];
  return <div className="recorded-visuals">
    <div className="request-comparison" role="img" aria-label={'Requests processed: KV-aware ' + kv.requests + ', CPU HPA ' + cpu.requests + '; KV-aware processed ' + (kv.requests - cpu.requests) + ' more requests'}>
            <div className="request-comparison-heading"><h3>Requests processed</h3><span>Locust total</span></div>
            <div className="request-comparison-row"><span>KV-aware</span><div className="request-comparison-track"><div className="request-comparison-bar kv" style={{width: (kv.requests / Math.max(kv.requests, cpu.requests) * 100) + '%'}}/></div><strong>{kv.requests}</strong></div>
            <div className="request-comparison-row"><span>CPU HPA</span><div className="request-comparison-track"><div className="request-comparison-bar cpu" style={{width: (cpu.requests / Math.max(kv.requests, cpu.requests) * 100) + '%'}}/></div><strong>{cpu.requests}</strong></div>
            <p>KV-aware processed {kv.requests - cpu.requests} more requests in this run.</p>
          </div><div className="outcome-charts" aria-label="Recorded outcome comparisons">
    {metrics.map(metric => <article className="outcome-chart" key={metric.title}>
      <header><h3>{metric.title}</h3><span>{metric.hint}</span></header>
      {policies.map((run, index) => <div className="outcome-row" key={run.key}>
        <span>{run.policy}</span>
        <div className="outcome-track"><div className={index ? 'outcome-bar cpu' : 'outcome-bar kv'} style={{width: (metric.value(run) === null ? 0 : metric.value(run) / metric.max * 100) + '%'}}/></div>
        <b>{metric.format(metric.value(run))}</b>
      </div>)}
      <p>{metric.result}</p>
    </article>)}
  </div>
  </div>;
}

function Chart({definition, cursor, setCursor}) {
  const {key, title, subtitle, suffix, ticks, log} = definition;
  const left = 48;
  const right = 728;
  const top = 24;
  const bottom = 168;
  const max = ticks.at(-1);
  const x = seconds => left + seconds / totalSeconds * (right - left);
  const y = value => bottom - (log ? Math.log1p(value) / Math.log1p(max) : value / max) * (bottom - top);
  const trace = points => {
    let previous = false;
    return points.map(point => {
      if (point.value === null) {previous = false; return '';}
      const move = previous ? 'L' : 'M';
      previous = true;
      return `${move}${x(point.elapsed).toFixed(1)},${y(Math.max(0, Math.min(max, point.value))).toFixed(1)}`;
    }).join(' ');
  };
  const selected = policies.map(run => run.metrics[key][cursor]);
  return <article className="chart">
    <header><div><h3>{title}</h3><p>{subtitle}</p></div><Legend/></header>
    <svg viewBox="0 0 760 204" role="img" aria-label={`${title}. Move pointer or use shared sample slider for exact values.`} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const viewX = (event.clientX - rect.left) / rect.width * 760;
      const index = Math.round((viewX - left) / (right - left) * (sampleCount - 1));
      setCursor(Math.max(0, Math.min(sampleCount - 1, index)));
    }}>
      <rect x={x(60)} y={top} width={x(360) - x(60)} height={bottom - top} fill="#f8eee8"/>
      {ticks.map(tick => <g key={tick}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="#dce0d8"/><text x={left - 8} y={y(tick) + 4} textAnchor="end">{tick}</text></g>)}
      {[0, 60, 120, 180, 240, 300, 360, 420, 480].map(second => <g key={second}><line x1={x(second)} x2={x(second)} y1={bottom} y2={bottom + 5} stroke="#8d958d"/><text x={x(second)} y="191" textAnchor="middle">{Math.floor(second / 60)}:00</text></g>)}
      <line x1={x(480)} x2={x(480)} y1={top} y2={bottom} stroke="#a6ada2" strokeDasharray="3 4"/>
      {key === 'kv_usage' && <g><line x1={left} x2={right} y1={y(30)} y2={y(30)} stroke="#9c6456" strokeDasharray="2 4"/><text x={right - 3} y={y(30) - 5} textAnchor="end">30% scale-up threshold</text></g>}
      {key === 'kv_usage' && policies.map((run, index) => { const point = run.metrics.kv_usage.find(sample => sample.value !== null && sample.value >= 30); return point ? <circle key={run.key} cx={x(point.elapsed)} cy={y(point.value)} r="5" fill={palette[index]} stroke="white" strokeWidth="2"/> : null; })}
      {key === 'healthy_targets' && <text x={x(5) + 5} y={y(2) + 14}>initial 2-target sample</text>}
      {policies.map((run, index) => <path key={run.key} d={trace(run.metrics[key])} fill="none" stroke={palette[index]} strokeWidth="2" strokeDasharray={index ? '6 4' : undefined}/>)}
      {key === 'healthy_targets' && data.decisions.filter(decision => decision.replicas === 2).map(decision => <g key={decision.timestamp}><line x1={x(decision.elapsed)} x2={x(decision.elapsed)} y1={top} y2={bottom} stroke="#be422c" strokeDasharray="3 3"/><text x={x(decision.elapsed) + 5} y={top + 13}>KV decision</text></g>)}
      <line x1={x(selected[0].elapsed)} x2={x(selected[0].elapsed)} y1={top} y2={bottom} stroke="#747d74" strokeDasharray="3 3"/>
      {selected.map((point, index) => point.value === null ? null : <circle key={index} cx={x(point.elapsed)} cy={y(Math.max(0, Math.min(max, point.value)))} r="3.5" fill={palette[index]} stroke="white"/>)}
    </svg>
    <div className="readout">{policies.map((run, index) => <span key={run.key} style={{color: palette[index]}}>{run.policy}: <b>{valueText(selected[index].value, suffix, key === 'healthy_targets' || key === 'running' ? 0 : 2)}</b><small>{selected[index].instances ? `${selected[index].instances} recorded series` : 'sample missing'}</small></span>)}</div>
    {key === 'kv_usage' && <p className="threshold-note">First observed sample at or above 30%: KV-aware {elapsed(policies[0].metrics.kv_usage.find(point => point.value !== null && point.value >= 30)?.elapsed ?? 0)}; CPU HPA {elapsed(policies[1].metrics.kv_usage.find(point => point.value !== null && point.value >= 30)?.elapsed ?? 0)}. This is time to threshold, not lower peak usage.</p>}
  </article>;
}

function App() {
  const [cursor, setCursor] = useState(0);
  const [copyStatus, setCopyStatus] = useState('Copy command');
  const decision = data.decisions.find(event => event.replicas === 2);
  const commands = 'cd ~/kv-autoscaling\nKUBECONFIG="$HOME/.kube/k3s.yaml" bash demo/public/fresh-run.sh';
  async function copyCommand() {
    try {await navigator.clipboard.writeText(commands); setCopyStatus('Copied');}
    catch {setCopyStatus('Copy unavailable');}
  }
  const date = new Date(kv.start * 1000).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'}).toUpperCase();
  return <>
    <a className="skip" href="#results">Skip to results</a>
    <div className="shell">
      <header className="masthead"><a className="brand" href="#results"><strong>KV</strong><span>/</span>AUTOSCALING</a><span className="edition">EXPERIMENT NOTEBOOK / 02</span><a href="#rerun">Fresh comparison</a></header>
      <nav aria-label="Sections">{[['results', 'Recorded results'], ['run', 'What happened during the run'], ['decisions', 'Scaling decisions'], ['method', 'How the experiment ran'], ['rerun', 'Run it again']].map(([id, label], index) => <a href={'#' + id} key={id}><span>0{index + 1}</span>{label}</a>)}</nav>
      <main>
        <section id="results">
          <div className="eyebrow">RECORDED RESULTS</div>
          <h1>KV-aware scaling under a burst workload.</h1>
          <p className="intro">An eight-minute long-context workload, run once under each policy on one shared GPU.</p>
          <div className="toolbar"><span className="saved">Saved comparison; opens without a cluster connection</span><a className="button" href="#run">Inspect the run</a></div>
          <div className="outcomes"><div className="table-wrap">
            <table><caption>Measured Locust outcomes - completed fresh comparison</caption><thead><tr>{['Policy', 'Requests', 'Failures', 'Mean', 'Median', 'p95'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{policies.map((run, index) => <tr key={run.key}><th scope="row"><span className={'policy ' + (index ? 'cpu' : 'kv')}/>{run.policy}</th><td>{run.requests}</td><td>{run.failures}</td><td>{run.mean.toFixed(3)} s</td><td>{run.median.toFixed(1)} s</td><td>{run.p95.toFixed(1)} s</td></tr>)}</tbody></table>
            <p className="fine">Requests include failures. Mean uses all Locust requests; p95 is Locust's approximate percentile. <a href={source(kv.log)}>KV log</a> / <a href={source(cpu.log)}>CPU log</a></p>
          </div><aside><span className="eyebrow">READING THE RESULT</span><h2>More requests. Lower mean latency. 0 failures with KV-aware autoscaling.</h2><p>KV-aware: <strong>800 requests; 0 failures</strong>. CPU HPA: <strong>666 requests; 1 failure</strong>. That is <strong>134 more requests</strong> in this run. Mean latency was <strong>2.983 s vs 3.549 s</strong>. Median and p95 were <strong>3.1 s and 3.4 s for both</strong>.</p><p className="constraint">One paired run: two time-sliced pods shared <strong>one physical 8 GiB GPU</strong>.</p></aside></div>
          <OutcomeCharts/>
        </section>
        <section id="run">
          <div className="section-heading"><div><span className="eyebrow">02 / TIME SERIES</span><h2>What happened during the run</h2></div><span className="mono">5 s PROMETHEUS EXPORT</span></div>
          <p className="muted">Each series uses its own run's UTC start. Move across any chart or use the slider to inspect synchronized elapsed time.</p>
          <div className="phase-strip"><span>0-1 min - low load / 1 user</span><span>1-6 min - burst / 8 users</span><span>6-8 min - recovery / 1 user</span></div>
          <div className="scrubber"><label htmlFor="sample">Sample <output>{elapsed(cursor * 5)}</output></label><input id="sample" type="range" min="0" max={sampleCount - 1} value={cursor} onChange={event => setCursor(Number(event.target.value))} aria-valuetext={`${elapsed(cursor * 5)} elapsed`}/><span className="mono">{elapsed(totalSeconds)}</span></div>
          <div className="timestamps">{policies.map(run => <span key={run.key}>{run.policy} <time>{time(run.start + cursor * 5)} UTC</time> <small>start {time(run.start)}</small></span>)}</div>
          <div className="charts">{definitions.slice(0, 5).map(definition => <Chart key={definition.key} definition={definition} cursor={cursor} setCursor={setCursor}/>)}</div>
          <details className="diagnostics"><summary>Queue diagnostics</summary><p className="fine">The exported queue p95 is 0.285 s for both policies wherever finite. This histogram did not separate the runs. KV usage shows cache pressure and the controller's 30% scale-up threshold.</p><div className="charts">{definitions.slice(5).map(definition => <Chart key={definition.key} definition={definition} cursor={cursor} setCursor={setCursor}/>)}</div></details>
          <p className="fine">Lines join adjacent finite samples only. Missing or nonfinite samples break the line. Aggregates use observed series. The first KV health sample shows two targets before the one-target state; timing uses the later one-to-two transition. Healthy scrape targets are not Kubernetes Ready events. A 30-second Prometheus rate does not equal Locust's total request count.</p>
          <details><summary>Inspect source CSVs and run windows</summary><div className="source-links"><a href={source(kv.csv)} download>KV Prometheus CSV</a><a href={source(cpu.csv)} download>CPU Prometheus CSV</a><a href={source('run-windows.json')}>UTC run windows</a></div></details>
        </section>
        <section id="decisions">
          <div className="section-heading"><div><span className="eyebrow">03 / EVIDENCE & TIMING</span><h2>Scaling decisions</h2></div></div>
          <div className="evidence-grid"><div><h3>KV controller event</h3><p>The timestamped controller log records a scale-to-two request at <strong>{decision ? time(Date.parse(decision.timestamp) / 1000) : 'unavailable'} UTC</strong>, {decision ? Math.round(decision.elapsed) : '-'} seconds after workload start. Its recorded reason was <strong>{decision?.reason.replace('_', ' ') || 'unavailable'}</strong>.</p><p><a href={source('controller.log')}>Controller log</a></p></div>
          <div><h3>First observed return to two healthy targets</h3><table><thead><tr><th scope="col">Policy</th><th scope="col">Elapsed</th><th scope="col">UTC sample</th></tr></thead><tbody>{policies.map(run => <tr key={run.key}><th scope="row">{run.policy}</th><td>{run.firstTwoAfterOne ? elapsed(run.firstTwoAfterOne - run.start) : 'Not observed'}</td><td>{run.firstTwoAfterOne ? time(run.firstTwoAfterOne) : '-'}</td></tr>)}</tbody></table><p className="fine">First one-to-two transitions on the 5-second scrape grid. KV: 455 s; CPU: 400 s. Model startup dominated readiness timing.</p></div></div>
          <p className="fine"><a href={source('hpa-final-snapshot.txt')}>Final CPU HPA snapshot</a> confirms a resize to two and the 1-2 replica cap. Its relative event age does not establish an exact CPU HPA decision timestamp.</p>
        </section>
        <section id="method"><span className="eyebrow">04 / METHOD</span><h2>How the experiment ran</h2><div className="method-grid">
          <div><h3>Workload & model</h3><p>Locust sent long-context chat completions to Qwen/Qwen2.5-0.5B-Instruct through the vLLM Service. Each request used 30 context items and up to 128 output tokens; client timeout was 90 s.</p><p>Each policy ran for 8 minutes: 1 user for 1 minute, 8 users for 5 minutes, then 1 user for 2 minutes.</p></div>
          <div><h3>Scaling controls</h3><p>KV-aware sampled every 5 s. Scale-up needed two consecutive observations of queue p95 at least 1 s, at least one waiting request, at least six running requests, or KV usage at least 30%. Scale-down required queue p95 at most 0.2 s, KV usage below 15%, no waiting requests, and at most one running request for 120 s.</p><p>CPU HPA targeted 70% of its 100m CPU request. Both policies were capped at two replicas.</p></div>
          <div><h3>Hardware boundary</h3><p>The device plugin advertises two shared GPU slots; both time-sliced pods use one physical 8 GiB GPU. A second serving process shares compute and memory.</p><p>vLLM v0.32.0 used a 128 MiB KV cache per pod, 1,024-token maximum context, and eager execution.</p></div>
        </div></section>
        <section id="rerun"><div className="section-heading"><div><span className="eyebrow">05 / OPTIONAL / LOCAL TERMINAL</span><h2>Run it again</h2></div><span className="duration">16+ minutes <small>plus startup & readiness</small></span></div>
          <p>The browser has no K3s execution backend. Run the comparison in your Ubuntu terminal; its status and errors appear there.</p>
          <div className="evidence-grid"><div><h3>Prerequisites</h3><ul><li>Local K3s access and a readable kubeconfig.</li><li>NVIDIA runtime and two advertised shared GPU slots on one 8 GiB device.</li><li>Prometheus serving vLLM queue and end-to-end latency histograms; metrics-server for CPU HPA.</li><li>Model and image access, plus enough free GPU memory.</li></ul><p>The script switches the experiment controllers and writes a new timestamped results directory. Completed request failures remain in the recorded comparison.</p></div><div className="terminal"><div className="terminal-title">LOCAL TERMINAL COMMAND <span>NOT STARTED IN BROWSER</span></div><pre>{commands}</pre><p role="status">Fresh-run status appears in your terminal. This page cannot check the cluster.</p><button onClick={copyCommand}>{copyStatus}</button> <a className="button" href="/fresh-run.sh" download>Download script</a></div></div>
          <p className="fine">A completed run writes Locust logs, timestamped controller events, a final HPA snapshot, run windows, and Prometheus CSVs. Run <code>npm run data</code> and rebuild the demo to bundle a new comparison after reviewing its summaries.</p>
        </section>
      </main>
      <footer><span>KV / AUTOSCALING</span><span>Recorded paired run; one physical GPU</span><a href="#results">Back to results</a></footer>
    </div>
  </>;
}
createRoot(document.getElementById('root')).render(<App/>);
