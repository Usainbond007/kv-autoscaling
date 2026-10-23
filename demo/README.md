# Recorded autoscaling viewer

The React demo opens with the saved K3s comparison from 21 October 2026. It needs Node.js 22.12 or newer and npm.

From an Ubuntu/WSL terminal:

```sh
cd ~/kv-autoscaling/demo
npm install
npm run dev
```

On this machine npm uses Windows Node. The launcher handles the WSL path automatically, builds the saved demo, and serves it at http://127.0.0.1:5173. Keep that terminal open and open the URL in a Windows browser. The CMD warning about UNC paths is harmless. The viewer needs no live cluster connection. With Linux Node installed in Ubuntu, the same commands run Vite directly.

For a separate production build, run `npm run build`.

## Data and charts

`npm run data` reads the newest complete `results/fresh-*/` directory with `run-windows.json`. It verifies both final Locust summaries, bundles the Prometheus CSV observations into `src/data.json`, and copies the logs, CSVs, controller log, HPA snapshot, and run windows into `public/evidence/fresh/`. The verified run is `fresh-20261021t100502z`: KV-aware 800 requests / 0 failures, mean 2.983 s, median 3.1 s, p95 3.4 s; CPU HPA 666 / 1, mean 3.549 s, median 3.1 s, p95 3.4 s.

The chart grid uses actual UTC run windows and five-second Prometheus samples. Missing and nonfinite samples break lines. Per-instance values are aggregated only where observed. The first KV health sample shows two targets before the one-target state; the later one-to-two transition is used for target timing. Healthy Prometheus targets are not Kubernetes Ready timestamps. The KV scale decision comes from its timestamped controller log. The CPU HPA file is a final snapshot and cannot give an exact CPU decision time.

Queue p95 is 0.285 s for both policies wherever finite; this histogram did not distinguish them. The table uses measured Locust mean, median, and p95. The charts include rolling Prometheus end-to-end p95, which has a different aggregation and should not be read as the overall Locust p95.

## Fresh comparison

From the repository root in Ubuntu:

```sh
KUBECONFIG="$HOME/.kube/k3s.yaml" bash demo/public/fresh-run.sh
```

The workflow requires local K3s, working `kubectl` access, Python 3, curl, metrics-server, Prometheus with vLLM queue and end-to-end latency histograms, NVIDIA container support, model and image access, and enough GPU memory. The device plugin advertises two shared slots, but both time-sliced pods use one physical 8 GiB GPU. Allow at least 16 minutes plus model startup and readiness.

The script uses a loopback Prometheus port-forward unless `PROMETHEUS_URL` is set. It saves a new `results/fresh-<timestamp>/` directory with logs, run windows, Prometheus CSVs, and decision evidence. A full Locust workload that records request failures remains valid comparison data. Infrastructure or early workload failures stop the script. After a completed run, CPU HPA remains active and the KV controller is paused.

The browser cannot start or monitor K3s jobs. Review a new run's summaries, then run `npm run data` and `npm run build` to bundle it into the viewer. The data script checks the currently reviewed summary values; update that assertion only after reviewing a new pair.

## Checks

`npm run build` verifies summaries and builds the site. `npm run test` checks evidence links, the interactive sample slider, desktop and mobile layout, touch targets, and browser errors against a running development server.
