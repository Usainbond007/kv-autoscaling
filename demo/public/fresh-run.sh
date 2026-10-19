#!/usr/bin/env bash
# Run from the repository root. Changes only the local experiment cluster.
set -euo pipefail
command -v kubectl >/dev/null
[[ -f k8s/vllm.yaml ]] || { echo 'ERROR: run from the repository root' >&2; exit 1; }
stamp=$(date -u +%Y%m%dt%H%M%Sz)
out="results/fresh-$stamp"
mkdir -p "$out"
trap 'echo "ERROR: stopped at line $LINENO. Inspect cluster and logs in $out; no automatic rollback." >&2' ERR
kubectl cluster-info
kubectl get nodes
kubectl top nodes
kubectl -n monitoring get service prometheus-server
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
      if [[ "$failed" == 1 ]]; then
        echo "ERROR: $job failed. Inspect $out/$job.log (Locust request failures also cause nonzero exit)." >&2
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
run_job k8s/locust-autoscale.yaml locust-autoscale "locust-kv-$stamp"
kubectl logs deployment/kv-autoscaler --timestamps > "$out/controller.log"
kubectl scale deployment kv-autoscaler --replicas=0
kubectl wait --for=delete pod -l app=kv-autoscaler --timeout=120s
kubectl apply -f k8s/vllm-hpa.yaml
kubectl scale deployment vllm --replicas=1
kubectl rollout status deployment/vllm --timeout=600s
kubectl apply -f k8s/hpa-cpu.yaml
run_job k8s/locust-hpa.yaml locust-hpa "locust-cpu-$stamp"
kubectl describe hpa vllm-cpu > "$out/hpa-final-snapshot.txt"
echo "DONE: $out. CPU HPA remains active; KV controller is paused."
echo 'Export Prometheus using the NEW start/end timestamps in a separate exporter copy. Do not overwrite historical results.'

