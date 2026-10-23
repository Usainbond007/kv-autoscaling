import json
import math
import os
import ssl
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROMETHEUS = os.getenv(
    "PROMETHEUS_URL", "http://prometheus-server.monitoring.svc.cluster.local"
)
NAMESPACE = os.getenv("TARGET_NAMESPACE", "default")
DEPLOYMENT = os.getenv("TARGET_DEPLOYMENT", "vllm")
DRY_RUN = os.getenv("DRY_RUN", "true").lower() == "true"

UP_KV = float(os.getenv("UP_KV", "0.30"))
DOWN_KV = float(os.getenv("DOWN_KV", "0.15"))
DOWN_SECONDS = int(os.getenv("DOWN_SECONDS", "120"))
CHECK_SECONDS = int(os.getenv("CHECK_SECONDS", "5"))
UP_QUEUE_P95_SECONDS = float(os.getenv("UP_QUEUE_P95_SECONDS", "1.0"))
UP_RUNNING = int(os.getenv("UP_RUNNING", "6"))
UP_CONSECUTIVE_SAMPLES = int(os.getenv("UP_CONSECUTIVE_SAMPLES", "2"))
UP_WAITING = int(os.getenv("UP_WAITING", "1"))
QUERY_WINDOW_SECONDS = int(os.getenv("QUERY_WINDOW_SECONDS", "30"))
DOWN_QUEUE_P95_SECONDS = float(os.getenv("DOWN_QUEUE_P95_SECONDS", "0.20"))
DOWN_RUNNING = int(os.getenv("DOWN_RUNNING", "1"))

ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")
TOKEN = (ACCOUNT / "token").read_text().strip()
TLS = ssl.create_default_context(cafile=str(ACCOUNT / "ca.crt"))
KUBE_API = "https://kubernetes.default.svc"
SCALE_PATH = (
    f"/apis/apps/v1/namespaces/{NAMESPACE}/deployments/{DEPLOYMENT}/scale"
)

up_signal_counts = {}
low_since = None


def log_event(event, **fields):
    timestamp = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    print(json.dumps({"timestamp": timestamp, "event": event, **fields}, sort_keys=True), flush=True)


def read_json(url, *, method="GET", data=None):
    headers = {}
    if url.startswith(KUBE_API):
        headers["Authorization"] = f"Bearer {TOKEN}"
    if data is not None:
        headers["Content-Type"] = "application/merge-patch+json"
    request = Request(url, data=data, headers=headers, method=method)
    with urlopen(
        request,
        timeout=4,
        context=TLS if url.startswith(KUBE_API) else None,
    ) as response:
        return json.load(response)


def metric(query, *, optional=False):
    url = PROMETHEUS + "/api/v1/query?" + urlencode({"query": query})
    result = read_json(url)
    if result["status"] != "success":
        raise ValueError(f"Prometheus query failed: {query}")
    values = result["data"]["result"]
    if not values and optional:
        return None
    if len(values) != 1:
        raise ValueError(f"Expected one value for {query}, got {len(values)}")
    value = float(values[0]["value"][1])
    if not math.isfinite(value):
        if optional:
            return None
        raise ValueError(f"Prometheus returned a nonfinite value for {query}")
    return value


def scale_to(replicas, *, reason, signals):
    log_event("scale", replicas=replicas, reason=reason, signals=signals, dry_run=DRY_RUN)
    if DRY_RUN:
        return
    body = json.dumps({"spec": {"replicas": replicas}}).encode()
    read_json(KUBE_API + SCALE_PATH, method="PATCH", data=body)


while True:
    try:
        global_up_counts = up_signal_counts
        desired = int(read_json(KUBE_API + SCALE_PATH)["spec"]["replicas"])
        healthy = int(metric(
            f'count(up{{service="{DEPLOYMENT}",namespace="{NAMESPACE}"}} == 1)'
        ))

        if healthy != desired:
            low_since = None
            global_up_counts.clear()
            log_event("waiting_for_healthy_targets", healthy_targets=healthy, desired=desired)
        else:
            kv = metric(
                f'max(vllm:kv_cache_usage_perc'
                f'{{service="{DEPLOYMENT}",namespace="{NAMESPACE}"}})'
            )
            waiting = metric(
                f'sum(vllm:num_requests_waiting'
                f'{{service="{DEPLOYMENT}",namespace="{NAMESPACE}"}})'
            )
            running = metric(
                f'sum(vllm:num_requests_running'
                f'{{service="{DEPLOYMENT}",namespace="{NAMESPACE}"}})'
            )
            queue_p95 = metric(
                "histogram_quantile(0.95, sum by (le) (rate("
                f'vllm:request_queue_time_seconds_bucket{{service="{DEPLOYMENT}",'
                f'namespace="{NAMESPACE}"}}[{QUERY_WINDOW_SECONDS}s])))',
                optional=True,
            )
            signals = {
                "queue_p95": queue_p95 is not None and queue_p95 >= UP_QUEUE_P95_SECONDS,
                "waiting": waiting >= UP_WAITING,
                "running": running >= UP_RUNNING,
                "kv_pressure": kv >= UP_KV,
            }
            for name, active in signals.items():
                global_up_counts[name] = global_up_counts.get(name, 0) + 1 if active else 0
            sample = {
                "desired": desired, "healthy_targets": healthy, "kv_usage": kv,
                "waiting": waiting, "running": running, "queue_p95_seconds": queue_p95,
            }
            log_event("observed", signal_counts=global_up_counts, **sample)

            reasons = [name for name, count in global_up_counts.items()
                       if count >= UP_CONSECUTIVE_SAMPLES]
            if desired == 1 and reasons:
                scale_to(2, reason=reasons[0], signals=sample)
                global_up_counts.clear()
                low_since = None
            elif (desired == 2 and queue_p95 is not None
                  and queue_p95 <= DOWN_QUEUE_P95_SECONDS
                  and kv < DOWN_KV and waiting == 0 and running <= DOWN_RUNNING):
                if low_since is None:
                    low_since = time.monotonic()
                if time.monotonic() - low_since >= DOWN_SECONDS:
                    scale_to(1, reason="sustained_low_load", signals=sample)
                    low_since = None
            else:
                low_since = None

    except Exception as exc:
        low_since = None
        up_signal_counts.clear()
        log_event("sampling_error", error_type=type(exc).__name__, message=str(exc))

    time.sleep(CHECK_SECONDS)
