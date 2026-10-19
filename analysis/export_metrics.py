import csv
import json
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path.home() / "kv-autoscaling/results"
RUNS = {
    "kv_autoscaler": ("2026-10-19T10:33:44Z", "2026-10-19T10:41:46Z"),
    "cpu_hpa": ("2026-10-19T10:58:37Z", "2026-10-19T11:06:39Z"),
    "kv_repeat_2": ("2026-10-19T11:31:27Z", "2026-10-19T11:39:28Z"),
    "hpa_repeat_2": ("2026-10-19T11:47:23Z", "2026-10-19T11:55:24Z"),
}
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
}


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


ROOT.mkdir(parents=True, exist_ok=True)

for run_name, (start, end) in RUNS.items():
    rows = []
    for metric_name, query in QUERIES.items():
        parameters = urlencode({
            "query": query,
            "start": timestamp(start),
            "end": timestamp(end),
            "step": "5s",
        })
        url = f"http://localhost:9090/api/v1/query_range?{parameters}"
        with urlopen(url, timeout=30) as response:
            payload = json.load(response)
        if payload["status"] != "success":
            raise RuntimeError(f"{run_name} {metric_name}: {payload}")

        for series in payload["data"]["result"]:
            instance = series["metric"].get("instance", "aggregate")
            for sample_time, value in series["values"]:
                rows.append((sample_time, metric_name, instance, value))

    output = ROOT / f"{run_name}_metrics.csv"
    with output.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["unix_time", "metric", "instance", "value"])
        writer.writerows(sorted(rows))

    print(f"{output}: {len(rows)} samples")
