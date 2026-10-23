#!/usr/bin/env bash
# Run from the repository root. Changes only the local experiment cluster.
set -euo pipefail
command -v kubectl >/dev/null
command -v python3 >/dev/null
command -v curl >/dev/null
[[ -f k8s/vllm.yaml ]] || { echo 'ERROR: run from the repository root' >&2; exit 1; }
stamp=$(date -u +%Y%m%dt%H%M%Sz)
out="results/fresh-$stamp"
mkdir -p "$out"
prometheus_url="${PROMETHEUS_URL:-}"
prometheus_pid=""
cleanup() {
  if [[ -n "$prometheus_pid" ]]; then
    kill "$prometheus_pid" >/dev/null 2>&1 || true
    wait "$prometheus_pid" 2>/dev/null || true
  fi
}
report_error() {
  echo "ERROR: stopped at line $1. Inspect cluster and logs in $out; no automatic rollback." >&2
}
trap cleanup EXIT
trap 'report_error "$LINENO"' ERR
start_prometheus_access() {
  if [[ -n "$prometheus_url" ]]; then
    return
  fi
  local port="${PROMETHEUS_LOCAL_PORT:-19090}"
  prometheus_url="http://127.0.0.1:$port"
  kubectl -n monitoring port-forward service/prometheus-server "$port:80" >"$out/prometheus-port-forward.log" 2>&1 &
  prometheus_pid=$!
  for _ in {1..30}; do
    curl -fsS "$prometheus_url/-/ready" >/dev/null && return
    sleep 1
  done
  echo "ERROR: Prometheus port-forward did not become ready" >&2
  return 1
}
kubectl cluster-info
kubectl get nodes
kubectl top nodes
kubectl -n monitoring get service prometheus-server
start_prometheus_access
curl -fsS "$prometheus_url/api/v1/label/__name__/values" > "$out/prometheus-metric-names.json"
for required_name in \
  'vllm:request_queue_time_seconds_bucket' \
  'vllm:e2e_request_latency_seconds_bucket'
do
  if ! grep -Fq "\"$required_name\"" "$out/prometheus-metric-names.json"; then
    echo "ERROR: required Prometheus metric is unavailable: $required_name" >&2
    exit 1
  fi
done

kubectl create configmap kv-autoscaler-code --from-file=controller.py=autoscaler/controller.py --dry-run=client -o yaml | kubectl apply -f -
kubectl create configmap locust-autoscale-script --from-file=autoscale_stress.py=locust/autoscale_stress.py --dry-run=client -o yaml | kubectl apply -f -
# Pause both policies before resetting serving configuration.
kubectl delete hpa vllm-cpu --ignore-not-found
if kubectl get deployment kv-autoscaler >/dev/null 2>&1; then
  kubectl scale deployment kv-autoscaler --replicas=0
  kubectl wait --for=delete pod -l app=kv-autoscaler --timeout=120s
fi
# Replace only the initial replica setting in the applied stream; repository intact.
sed 's/^  replicas: 2$/  replicas: 1/' k8s/vllm.yaml | kubectl apply -f -
kubectl rollout status deployment/vllm --timeout=600s
kubectl apply -f k8s/autoscaler.yaml
kubectl rollout status deployment/kv-autoscaler --timeout=120s
run_job() {
  local manifest="$1" original="$2" job="$3"
  sed "s/^  name: $original$/  name: $job/" "$manifest" | kubectl create -f -
  echo "RUNNING $job (8-minute workload plus startup)"
  local deadline=$((SECONDS+900))
  while (( SECONDS < deadline )); do
    local succeeded failed
    succeeded=$(kubectl get job "$job" -o jsonpath='{.status.succeeded}')
    failed=$(kubectl get job "$job" -o jsonpath='{.status.failed}')
    if [[ "$succeeded" == 1 || "$failed" == 1 ]]; then
      kubectl logs "job/$job" --timestamps > "$out/$job.log"
      kubectl get job "$job" -o yaml > "$out/$job.yaml"
      if [[ "$failed" == 1 ]] && grep -Fq "Shape test completed" "$out/$job.log"; then
        echo "COMPLETED $job with recorded request failures; logs saved"
        return 0
      elif [[ "$failed" == 1 ]]; then
        echo "ERROR: $job stopped before the workload completed. Inspect $out/$job.log." >&2
        return 1
      fi
      echo "COMPLETED $job; logs saved"
      return 0
    fi
    sleep 5
  done
  kubectl logs "job/$job" --timestamps > "$out/$job.log" || true
  echo "ERROR: $job exceeded 15-minute wait; job may still be running" >&2
  return 1
}
kv_name="locust-kv-$stamp"
run_job k8s/locust-autoscale.yaml locust-autoscale "$kv_name"
sleep 15
kv_start=$(kubectl get pods -l "job-name=$kv_name" -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.startedAt}')
kv_finished=$(kubectl get pods -l "job-name=$kv_name" -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.finishedAt}')
kv_end=$(date -u -d "$kv_finished + 15 seconds" +%Y-%m-%dT%H:%M:%SZ)
kubectl logs deployment/kv-autoscaler --timestamps > "$out/controller.log"
kubectl scale deployment kv-autoscaler --replicas=0
kubectl wait --for=delete pod -l app=kv-autoscaler --timeout=120s
kubectl apply -f k8s/vllm-hpa.yaml
kubectl scale deployment vllm --replicas=1
kubectl rollout status deployment/vllm --timeout=600s
kubectl apply -f k8s/hpa-cpu.yaml
cpu_name="locust-cpu-$stamp"
run_job k8s/locust-hpa.yaml locust-hpa "$cpu_name"
sleep 15
cpu_start=$(kubectl get pods -l "job-name=$cpu_name" -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.startedAt}')
cpu_finished=$(kubectl get pods -l "job-name=$cpu_name" -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.finishedAt}')
cpu_end=$(date -u -d "$cpu_finished + 15 seconds" +%Y-%m-%dT%H:%M:%SZ)
kubectl describe hpa vllm-cpu > "$out/hpa-final-snapshot.txt"
kv_runs_json=$(printf '{"%s":["%s","%s"]}' "$kv_name" "$kv_start" "$kv_end")
cpu_runs_json=$(printf '{"%s":["%s","%s"]}' "$cpu_name" "$cpu_start" "$cpu_end")
for run_json in "$kv_runs_json" "$cpu_runs_json"; do
  EXPORT_RUNS_JSON="$run_json" \
  EXPORT_OUTPUT_DIR="$out" \
  PROMETHEUS_URL="$prometheus_url" \
  REQUIRED_METRICS="queue_p95_seconds,e2e_p95_seconds" \
    python3 analysis/export_metrics.py
done
printf '{"stamp":"%s","kv":{"start":"%s","end":"%s"},"cpu":{"start":"%s","end":"%s"}}\n' \
  "$stamp" "$kv_start" "$kv_end" "$cpu_start" "$cpu_end" > "$out/run-windows.json"
echo "DONE: $out. CPU HPA remains active; KV controller is paused."
echo 'Fresh Prometheus CSVs, metadata, workload logs, and controller/HPA evidence were saved.'

