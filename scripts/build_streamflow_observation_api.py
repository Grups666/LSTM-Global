"""Build compact static observation/validation API for GitHub Pages."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validation-run-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--shard-size", type=int, default=50)
    return parser.parse_args()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_csv_gz(path: Path) -> list[dict[str, str]]:
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def finite_number(value: Any, digits: int = 6) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return round(number, digits)


def main() -> None:
    args = parse_args()
    run_dir = args.validation_run_dir
    summary = read_json(run_dir / "summary.json")
    metrics_summary_path = run_dir / "forecast_validation_metrics_summary.json"
    metrics_summary = read_json(metrics_summary_path) if metrics_summary_path.exists() else {}
    audit_rows = read_csv(run_dir / "basin_observation_match_audit.csv")
    observation_rows = read_csv_gz(run_dir / "observed_streamflow.csv.gz")
    validation_rows = read_csv_gz(run_dir / "forecast_validation.csv.gz")

    strict_rows = [row for row in audit_rows if row.get("audit_status") == "matched_recent"]
    strict_by_basin = {row["forecast_basin_id"]: row for row in strict_rows}

    obs_by_basin: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in observation_rows:
        basin = row["basin"]
        obs_by_basin[basin].append(
            [
                row["date"],
                finite_number(row.get("streamflow_mm_day"), 6),
                finite_number(row.get("discharge_cms"), 6),
            ]
        )

    val_by_basin: dict[str, dict[str, list[list[Any]]]] = defaultdict(lambda: defaultdict(list))
    basin_metric_acc: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for row in validation_rows:
        basin = row["basin"]
        lead = str(row["lead_time"])
        obs = finite_number(row.get("observed_streamflow_mm_day"), 6)
        p50 = finite_number(row.get("forecast_p50_mm_day"), 6)
        p05 = finite_number(row.get("forecast_p05_mm_day"), 6)
        p95 = finite_number(row.get("forecast_p95_mm_day"), 6)
        ae = finite_number(row.get("absolute_error_p50_mm_day"), 6)
        inside = str(row.get("inside_p05_p95", "")).lower() == "true"
        val_by_basin[basin][lead].append([row["issue_date"], row["valid_date"], p05, p50, p95, obs, ae, inside])
        if ae is not None:
            basin_metric_acc[basin]["ae"].append(ae)
        if inside:
            basin_metric_acc[basin]["inside"].append(1.0)
        else:
            basin_metric_acc[basin]["inside"].append(0.0)

    basin_rows: list[dict[str, Any]] = []
    for basin_id in sorted(strict_by_basin):
        audit = strict_by_basin[basin_id]
        ae_values = basin_metric_acc[basin_id]["ae"]
        inside_values = basin_metric_acc[basin_id]["inside"]
        basin_rows.append(
            {
                "id": basin_id,
                "source": audit.get("source"),
                "stationId": audit.get("station_id"),
                "name": audit.get("gauge_name"),
                "latestObsDate": audit.get("daily_latest_date"),
                "obsCount": len(obs_by_basin.get(basin_id, [])),
                "validationCount": sum(len(rows) for rows in val_by_basin.get(basin_id, {}).values()),
                "maeMmDay": round(sum(ae_values) / len(ae_values), 6) if ae_values else None,
                "coverageP05P95": round(sum(inside_values) / len(inside_values), 6) if inside_values else None,
            }
        )

    shard_files: list[str] = []
    basin_shard: dict[str, str] = {}
    for shard_index, offset in enumerate(range(0, len(basin_rows), args.shard_size)):
        subset = basin_rows[offset : offset + args.shard_size]
        shard_name = f"shard-{shard_index:03d}.json"
        shard_files.append(shard_name)
        payload = {"schemaVersion": "streamflow-observation-shard-v1", "basins": {}}
        for basin in subset:
            basin_id = basin["id"]
            basin_shard[basin_id] = shard_name
            payload["basins"][basin_id] = {
                "meta": basin,
                "observations": sorted(obs_by_basin.get(basin_id, []), key=lambda item: item[0]),
                "validation": {
                    lead: sorted(rows, key=lambda item: (item[0], item[1]))
                    for lead, rows in sorted(val_by_basin.get(basin_id, {}).items(), key=lambda item: int(item[0]))
                },
            }
        write_json(args.output_dir / shard_name, payload)

    source_counts: dict[str, int] = defaultdict(int)
    for row in strict_rows:
        source_counts[row.get("source") or "unknown"] += 1

    latest_payload = {
        "schemaVersion": "streamflow-observation-api-v1",
        "generatedAtUtc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "runDate": summary.get("run_date"),
        "startDate": summary.get("start_date"),
        "endDate": summary.get("end_date"),
        "retentionDays": summary.get("retention_days", 30),
        "totalForecastBasins": summary.get("total_forecast_basins"),
        "strictMatchedRecentBasins": summary.get("strict_matched_recent_basins"),
        "needsReviewBasins": summary.get("match_status_counts", {}).get("needs_review"),
        "observationRows": summary.get("observation_rows"),
        "validationRows": summary.get("validation_rows"),
        "sourceCounts": dict(sorted(source_counts.items())),
        "metrics": metrics_summary.get("overall") or summary.get("validation_metrics") or {},
        "byLead": metrics_summary.get("by_lead", []),
        "contract": "Observed streamflow is validation-only and is not used as forecast inference input.",
        "files": {
            "index": "index.json",
            "basins": "basins.json",
        },
    }
    index_payload = {
        "schemaVersion": "streamflow-observation-index-v1",
        "generatedAtUtc": latest_payload["generatedAtUtc"],
        "runDate": latest_payload["runDate"],
        "window": {"startDate": latest_payload["startDate"], "endDate": latest_payload["endDate"]},
        "basinCount": len(basin_rows),
        "shardSize": args.shard_size,
        "shardFiles": shard_files,
        "basinShard": basin_shard,
    }
    write_json(args.output_dir / "latest.json", latest_payload)
    write_json(args.output_dir / "index.json", index_payload)
    write_json(args.output_dir / "basins.json", {"schemaVersion": "streamflow-observation-basins-v1", "basins": basin_rows})
    print(json.dumps({k: latest_payload[k] for k in ["runDate", "strictMatchedRecentBasins", "observationRows", "validationRows"]}, indent=2))


if __name__ == "__main__":
    main()
