# Recorded autoscaling viewer

Requires Node.js 22.12+ (or 24) and npm. From `demo/`:

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. Production: `npm run build`, then `npm run preview`.
Servers bind to loopback. No cluster, GPU, credentials, or Prometheus is needed for saved results.

## Data

`npm run data` reads the four comparison Locust logs and four Prometheus CSVs in `../results/`, verifies final summaries, generates `src/data.json`, and copies evidence into `public/evidence/`. These generated assets are included for immediate rendering. Regenerate after intentional evidence changes.

Charts follow the original plotting scripts: maximum observed pod KV percentage; summed running requests and successful-completion rates; aggregate healthy scrape targets. Original timestamps are retained and aligned to each export's start. The original 5-second grid covers 0–480 seconds. Missing/nonfinite values remain null and break lines; aggregates include observed instances only. Healthy targets do not establish Kubernetes Ready timestamps. Phase bands come from the workload definition. Use the shared keyboard-accessible slider for exact values and UTC times.

Controller logs lack timestamps; the HPA file is a final snapshot. Neither supplies exact decision times. Two trials on one physical 8 GiB GPU do not establish a universal winner.

## Fresh comparison (optional)

Run `bash demo/public/fresh-run.sh` from the repository root in Ubuntu. Requires configured local K3s, kubectl access, NVIDIA runtime and two shared GPU slots, Prometheus scraping individual pods, metrics-server, model/image access, and free GPU memory. The script switches controllers and changes the local experiment Deployment. Duration: 16+ minutes plus startup/readiness.

The script prints status/errors and saves logs to a new timestamped results directory. It stops on errors; request failures can cause Locust to return nonzero even after the workload finishes. Inspect saved logs before retrying. Jobs remain for inspection; CPU HPA remains active on successful completion. Cluster/plugin provisioning is not included.

There is no execution backend: the browser cannot start jobs or monitor status. Fresh metrics are not imported automatically. Use a separate copy of `analysis/export_metrics.py` with actual new start/end windows and distinct output names; the original exporter hard-codes historical windows. Existing experiment files and saved evidence remain intact.

## Checks

`npm run build` validates summaries and builds. `npm run test` checks both trials, sample controls, source links, responsive layout and browser errors against a running dev server.

For Windows access through a WSL share, build with a mapped drive. If filesystem watching fails, serve the built app with 
ode scripts/serve.mjs at http://127.0.0.1:5173. Browser tests require 
px playwright install chromium.

Windows/WSL fallback: build using a mapped drive, then run `node scripts/serve.mjs` to serve the production files at http://127.0.0.1:5173 if development file watching is unavailable. Browser tests require `npx playwright install chromium`.
