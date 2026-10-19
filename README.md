# KV-Aware Autoscaling for GPU-Efficient LLM Inference

A Kubernetes prototype that scales LLM inference replicas using **vLLM KV-cache pressure and queued requests**. It includes a CPU-based Horizontal Pod Autoscaler (HPA) baseline, an in-cluster Locust workload, Prometheus metrics, and scripts for comparing the policies.

The experiment runs on **one physical NVIDIA GPU**. NVIDIA device-plugin time-sharing lets Kubernetes schedule two vLLM pods onto that GPU. This demonstrates the complete autoscaling control loop without claiming that the laptop has two GPUs or twice the GPU compute capacity.

## The problem

CPU utilization alone can be a weak signal for LLM serving pressure. An inference server may be constrained by active token sequences, GPU KV-cache capacity, or requests waiting for scheduling while its CPU usage tells a different story.

This project asks:

> Can inference-specific vLLM metrics drive Kubernetes replica decisions, and how does that behavior compare with a CPU HPA under the same request workload?

The goal is an observable, working system: clients generate real requests, inference pods expose metrics, a controller makes decisions, and Kubernetes changes the number of serving pods.

## What the system does

The request path is:

**Locust → Kubernetes vLLM Service → vLLM pod → NVIDIA GPU**

The control path is:

**vLLM `/metrics` → Prometheus → KV-aware controller → Kubernetes Deployment scale API**

The custom controller reads:

- KV-cache utilization from `vllm:kv_cache_usage_perc`
- Queued requests from `vllm:num_requests_waiting`
- Prometheus target health to check that the expected serving pods are being observed

It scales the vLLM Deployment between **one and two replicas**. A high KV-cache reading or queued requests can trigger scale-up. Sustained low load can trigger scale-down. The controller waits for the intended number of healthy targets before making another decision.

The CPU baseline uses Kubernetes HPA with a CPU utilization target. Only one scaling policy should control the vLLM Deployment at a time.

## Components

| Component | Role |
|---|---|
| K3s | Local Kubernetes cluster in Ubuntu under WSL2 |
| NVIDIA device plugin | Advertises GPU resources and enables time-sharing |
| vLLM | Serves `Qwen/Qwen2.5-0.5B-Instruct` through an OpenAI-compatible API |
| Prometheus | Scrapes metrics from individual vLLM pods |
| KV-aware controller | Reads Prometheus and updates the Deployment replica count |
| CPU HPA | Comparison autoscaling policy |
| Locust | Generates staged chat-completion traffic inside the cluster |
| Analysis scripts | Export metric time series and produce comparison plots |

## Repository structure

```text
autoscaler/
  controller.py             KV-aware scaling controller

analysis/
  export_metrics.py         Export recorded Prometheus time series
  plot_runs.py              Plot first comparison pair
  plot_repeat.py            Plot second comparison pair

k8s/
  vllm.yaml                 KV-aware experiment's serving Deployment and Service
  vllm-hpa.yaml             Serving configuration for the CPU baseline
  autoscaler.yaml           Controller Deployment, ServiceAccount, and RBAC
  hpa-cpu.yaml              CPU HPA baseline
  gpu-time-slicing.yaml     GPU-sharing configuration
  locust-*.yaml             In-cluster load-test Jobs

locust/
  autoscale_stress.py       Staged comparison workload
  *.py                      Smoke, burst, and stress workloads

results/
  *.log                     Locust and controller output
  *_metrics.csv             Exported Prometheus samples
  policy_comparison*.png    Time-series figures
```

## Hardware and deployment choices

The laptop has one NVIDIA GPU with approximately 8 GiB of VRAM. The NVIDIA device plugin advertises shared GPU allocations, allowing two vLLM pods to request `nvidia.com/gpu.shared`. Each pod serves the same small instruction model.

The serving configuration limits model context length and explicitly budgets KV-cache memory so that two model processes can coexist in the available VRAM. A readiness probe checks the vLLM health endpoint before a pod is considered available. The Deployment rollout settings avoid temporarily creating an additional inference pod beyond the intended replica count.

Because both pods share the same device, they compete for GPU time and memory. An additional pod improves the number of independently scheduled serving instances; it does **not** create an additional physical GPU.

## Autoscaling behavior

The KV-aware controller uses thresholds, a low-load hold period, and a one-to-two-replica limit. Its observed decision sequence in the experiment was:

```text
1 replica → 2 replicas during load → 1 replica after load decreased
```

The controller runs with a dedicated Kubernetes ServiceAccount. Its RBAC grants access to the vLLM Deployment's scale interface, rather than broad permission to change arbitrary workloads. The manifest supports a dry-run setting for inspecting decisions without changing replicas.

The CPU HPA baseline scales the same vLLM service between one and two replicas using CPU utilization relative to its configured CPU request. The reported utilization percentage is relative to that request; it is not the percentage of the laptop's total CPU capacity.

## Experiment design

Locust runs inside Kubernetes and calls the vLLM Service, avoiding a host-side port-forward in the load path. The comparison workload has three stages:

| Stage | Duration | Locust users |
|---|---:|---:|
| Initial load | 1 minute | 1 |
| Burst | 5 minutes | 8 |
| Recovery | 2 minutes | 1 |

Each client sends a long chat-completion request with a varying request identifier. The same workload definition is used for the KV-aware and CPU HPA policies.

Before each policy's run, the other controller is disabled and the serving Deployment starts at one ready replica. The experiments record Locust request counts, failures, response-time percentiles, vLLM metrics, and the number of healthy Prometheus scrape targets.

There are **two runs per policy**. Individual runs are paired for comparison, but their results should be treated as measurements from this laptop setup, not a statistically conclusive benchmark.

## Results

| Trial | Policy | Completed requests | Failures | Median | p95 | Approx. p99 |
|---|---|---:|---:|---:|---:|---:|
| 1 | KV-aware | 496 | 2 | 3.0 s | 5.0 s | 43 s |
| 1 | CPU HPA | 323 | 4 | 5.0 s | 6.7 s | 90 s |
| 2 | KV-aware | 897 | 0 | 2.1 s | 2.6 s | 61 s |
| 2 | CPU HPA | 806 | 0 | 2.2 s | 3.3 s | 56 s |

The p99 figures are approximations from Locust's percentile summaries. Both policies produced long latency outliers, including in runs with no failed requests.

In these runs, the KV-aware policy completed more requests and had a lower p95 than the CPU HPA. However, the second run's CPU HPA brought its second healthy scrape target online earlier than the KV-aware policy. The evidence supports a functioning KV-aware autoscaler and a promising result for this workload; it does **not** establish that it scales faster or performs better in every situation.

The figures show KV-cache usage, running requests, completed requests per second, and healthy Prometheus scrape targets:

