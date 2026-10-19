import json
import os
import ssl
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROMETHEUS = os.getenv(
    "PROMETHEUS_URL", "http://prometheus-server.monitoring.svc.cluster.local"
)
NAMESPACE = os.getenv("TARGET_NAMESPACE", "default")
DEPLOYMENT = os.getenv("TARGET_DEPLOYMENT", "vllm")
DRY_RUN = os.getenv("DRY_RUN", "true").lower() == "true"

UP_KV = float(os.getenv("UP_KV", "0.45"))
DOWN_KV = float(os.getenv("DOWN_KV", "0.15"))
DOWN_SECONDS = int(os.getenv("DOWN_SECONDS", "120"))
CHECK_SECONDS = int(os.getenv("CHECK_SECONDS", "5"))

ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")
TOKEN = (ACCOUNT / "token").read_text().strip()
TLS = ssl.create_default_context(cafile=str(ACCOUNT / "ca.crt"))
KUBE_API = "https://kubernetes.default.svc"
SCALE_PATH = (
    f"/apis/apps/v1/namespaces/{NAMESPACE}/deployments/{DEPLOYMENT}/scale"
)

low_since = None


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


def metric(query):
    url = PROMETHEUS + "/api/v1/query?" + urlencode({"query": query})
    result = read_json(url)
    if result["status"] != "success":
        raise ValueError(f"Prometheus query failed: {query}")
    values = result["data"]["result"]
    if len(values) != 1:
        raise ValueError(f"Expected one value for {query}, got {len(values)}")
    return float(values[0]["value"][1])


def scale_to(replicas):
    print(f"decision: scale to {replicas}; dry_run={DRY_RUN}", flush=True)
    if DRY_RUN:
        return
    body = json.dumps({"spec": {"replicas": replicas}}).encode()
    read_json(KUBE_API + SCALE_PATH, method="PATCH", data=body)


while True:
    try:
        desired = int(read_json(KUBE_API + SCALE_PATH)["spec"]["replicas"])
        healthy = int(metric(
            f'count(up{{service="{DEPLOYMENT}",namespace="{NAMESPACE}"}} == 1)'
        ))

        if healthy != desired:
            low_since = None
            print(f"waiting for pods: healthy={healthy}, desired={desired}", flush=True)
        else:
            kv = metric(
                f'max(vllm:kv_cache_usage_perc'
                f'{{service="{DEPLOYMENT}",namespace="{NAMESPACE}"}})'
            )
            waiting = metric(
                f'sum(vllm:num_requests_waiting'
                f'{{service="{DEPLOYMENT}",namespace="{NAMESPACE}"}})'
            )
            print(
                f"replicas={desired} max_kv={kv:.3f} waiting={waiting:.0f}",
                flush=True,
            )

            if desired == 1 and (kv >= UP_KV or waiting >= 1):
                scale_to(2)
                low_since = None
            elif desired == 2 and kv < DOWN_KV and waiting == 0:
                if low_since is None:
                    low_since = time.monotonic()
                if time.monotonic() - low_since >= DOWN_SECONDS:
                    scale_to(1)
                    low_since = None
            else:
                low_since = None

    except Exception as exc:
        low_since = None
        print(f"no scaling decision: {type(exc).__name__}: {exc}", flush=True)

    time.sleep(CHECK_SECONDS)
