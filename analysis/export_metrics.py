import csv
import json
import math
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(os.getenv("EXPORT_OUTPUT_DIR", Path.home() / "kv-autoscaling/results"))
PROMETHEUS_URL = os.getenv("PROMETHEUS_URL", "http://localhost:9090").rstrip("/")
REQUIRED_METRICS = set(filter(None, os.getenv("REQUIRED_METRICS", "").split(",")))
RUNS = {
    "kv_autoscaler": ("2026-10-19T10:33:44Z", "2026-10-19T10:41:46Z"),
    "cpu_hpa": ("2026-10-19T10:58:37Z", "2026-10-19T11:06:39Z"),
    "kv_repeat_2": ("2026-10-19T11:31:27Z", "2026-10-19T11:39:28Z"),
    "hpa_repeat_2": ("2026-10-19T11:47:23Z", "2026-10-19T11:55:24Z"),
}
if os.getenv("EXPORT_RUNS_JSON"):
    RUNS = json.loads(os.environ["EXPORT_RUNS_JSON"])
QUERIES = {
    "kv_usage": 'vllm:kv_cache_usage_perc{service="vllm"}',
    "waiting": 'vllm:num_requests_waiting{service="vllm"}',
    "running": 'vllm:num_requests_running{service="vllm"}',
    "requests_per_second": (
        'sum by (instance) (rate('
        'vllm:request_success_total{service="vllm",'
        'finished_reason=~"stop|length"}[30s]))'
    ),
    "healthy_targets": 'count(up{service="vllm"} == 1)',
    "queue_p95_seconds": (
        "histogram_quantile(0.95, sum by (le) "
        '(rate(vllm:request_queue_time_seconds_bucket{service="vllm"}[30s])))'
    ),
    "e2e_p95_seconds": (
        "histogram_quantile(0.95, sum by (le) "
        '(rate(vllm:e2e_request_latency_seconds_bucket{service="vllm"}[30s])))'
    ),
    "prefill_p95_seconds": (
        "histogram_quantile(0.95, sum by (le) "
        '(rate(vllm:request_prefill_time_seconds_bucket{service="vllm"}[30s])))'
    ),
    "decode_p95_seconds": (
        "histogram_quantile(0.95, sum by (le) "
        '(rate(vllm:request_decode_time_seconds_bucket{service="vllm"}[30s])))'
    ),
}


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


ROOT.mkdir(parents=True, exist_ok=True)

for run_name, (start, end) in RUNS.items():
    rows = []
    missing = []
    for metric_name, query in QUERIES.items():
        parameters = urlencode({
            "query": query,
            "start": timestamp(start),
            "end": timestamp(end),
            "step": "5s",
        })
        url = f"{PROMETHEUS_URL}/api/v1/query_range?{parameters}"
        with urlopen(url, timeout=30) as response:
            payload = json.load(response)
        if payload["status"] != "success":
            raise RuntimeError(f"{run_name} {metric_name}: {payload}")

        series_set = payload["data"]["result"]
        if not series_set:
            missing.append(metric_name)
            continue
        finite_samples = 0
        for series in series_set:
            instance = series["metric"].get("instance", "aggregate")
            for sample_time, value in series["values"]:
                rows.append((sample_time, metric_name, instance, value))
                if math.isfinite(float(value)):
                    finite_samples += 1
        if finite_samples == 0:
            missing.append(metric_name)

    output = ROOT / f"{run_name}_metrics.csv"
    with output.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["unix_time", "metric", "instance", "value"])
        writer.writerows(sorted(rows))

    required_missing = sorted(REQUIRED_METRICS & set(missing))
    if required_missing:
        output.unlink(missing_ok=True)
        raise RuntimeError(
            f"{run_name}: required metrics had no samples: "
            + ", ".join(required_missing)
        )
    metadata = {
        "run": run_name, "start": start, "end": end,
        "prometheus_url": PROMETHEUS_URL, "missing_metrics": missing, "samples": len(rows),
    }
    output.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"{output}: {len(rows)} samples; missing={','.join(missing) or 'none'}")
