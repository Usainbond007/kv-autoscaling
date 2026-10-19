import csv
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = Path.home() / "kv-autoscaling/results"
runs = [
    ("KV-aware", root / "kv_repeat_2_metrics.csv"),
    ("CPU HPA", root / "hpa_repeat_2_metrics.csv"),
]
metrics = [
    ("kv_usage", "Highest pod KV usage (%)", max, 100),
    ("running", "Running requests (sum)", sum, 1),
    ("requests_per_second", "Completed requests/s (sum)", sum, 1),
    ("healthy_targets", "Ready scrape targets", max, 1),
]

fig, axes = plt.subplots(4, 2, figsize=(13, 12), sharex="col")

for column, (title, path) in enumerate(runs):
    samples = defaultdict(lambda: defaultdict(list))
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            samples[row["metric"]][float(row["unix_time"])].append(
                float(row["value"])
            )

    start = min(
        time
        for series in samples.values()
        for time in series
    )

    for row_index, (key, label, reducer, factor) in enumerate(metrics):
        ax = axes[row_index, column]
        series = samples[key]
        times = sorted(series)
        x = [(time - start) / 60 for time in times]
        y = [reducer(series[time]) * factor for time in times]
        ax.plot(x, y, linewidth=1.5)
        ax.axvspan(1, 6, color="orange", alpha=0.12)
        ax.set_ylabel(label)
        ax.grid(alpha=0.25)
        if row_index == 0:
            ax.set_title(title)
            if column == 0:
                ax.axhline(45, color="red", linestyle="--",
                           linewidth=1, label="scale-up threshold")
                ax.legend(loc="upper right")
        if row_index == 3:
            ax.set_xlabel("Minutes since test start")
            ax.set_yticks([0, 1, 2])

fig.suptitle("Same workload: 1 user → 8 users → 1 user")
fig.tight_layout()
output = root / "policy_comparison_repeat_2.png"
fig.savefig(output, dpi=160)
print(output)
