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
    parser.add_argument("--candidate-metrics-csv", type=Path)
    parser.add_argument("--candidate-manifest-json", type=Path)
    parser.add_argument("--candidate-skill-classes-csv", type=Path)
    parser.add_argument("--candidate-metrics-split", default="test")
    parser.add_argument("--candidate-label", default="Strict obs posttrain candidate")
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


def median(values: list[float]) -> float | None:
    finite_values = sorted(value for value in values if math.isfinite(value))
    if not finite_values:
        return None
    midpoint = len(finite_values) // 2
    if len(finite_values) % 2:
        return finite_values[midpoint]
    return (finite_values[midpoint - 1] + finite_values[midpoint]) / 2.0


def correlation(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2 or len(xs) != len(ys):
        return None
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    var_x = sum((x - mean_x) ** 2 for x in xs)
    var_y = sum((y - mean_y) ** 2 for y in ys)
    if var_x <= 0.0 or var_y <= 0.0:
        return None
    cov = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys, strict=False))
    return cov / math.sqrt(var_x * var_y)


def validation_metrics(rows: list[list[Any]]) -> dict[str, Any]:
    obs: list[float] = []
    pred: list[float] = []
    abs_errors: list[float] = []
    inside_count = 0
    for row in rows:
        p50 = row[3]
        observed = row[5]
        if p50 is None or observed is None:
            continue
        pred.append(float(p50))
        obs.append(float(observed))
        if row[6] is not None:
            abs_errors.append(float(row[6]))
        if row[7]:
            inside_count += 1
    n = len(obs)
    if n < 2:
        return {"n": n, "nse": None, "kge": None, "maeMmDay": None, "coverageP05P95": None}
    mean_obs = sum(obs) / n
    mean_pred = sum(pred) / n
    denominator = sum((value - mean_obs) ** 2 for value in obs)
    nse = None
    if denominator > 0:
        nse = 1.0 - sum((p - o) ** 2 for p, o in zip(pred, obs, strict=False)) / denominator
    r = correlation(pred, obs)
    std_obs = math.sqrt(sum((value - mean_obs) ** 2 for value in obs) / n)
    std_pred = math.sqrt(sum((value - mean_pred) ** 2 for value in pred) / n)
    alpha = std_pred / std_obs if std_obs > 0 else None
    beta = mean_pred / mean_obs if mean_obs != 0 else None
    kge = None
    if r is not None and alpha is not None and beta is not None:
        kge = 1.0 - math.sqrt((r - 1.0) ** 2 + (alpha - 1.0) ** 2 + (beta - 1.0) ** 2)
    return {
        "n": n,
        "nse": finite_number(nse),
        "kge": finite_number(kge),
        "maeMmDay": finite_number(sum(abs_errors) / len(abs_errors)) if abs_errors else None,
        "coverageP05P95": finite_number(inside_count / n),
    }


def candidate_metric_from_row(row: dict[str, str]) -> dict[str, Any]:
    return {
        "n": int(float(row["n"])) if row.get("n") else 0,
        "nse": finite_number(row.get("nse")),
        "kge": finite_number(row.get("kge")),
        "maeMmDay": finite_number(row.get("mae_mm_day")),
        "rmseMmDay": finite_number(row.get("rmse_mm_day")),
        "coverageP05P95": finite_number(row.get("coverage_p05_p95")),
    }


def load_candidate_skill_classes(path: Path | None) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    if not path or not path.exists():
        return {}, {}
    by_basin: dict[str, dict[str, Any]] = {}
    counts: dict[str, int] = defaultdict(int)
    for row in read_csv(path):
        basin = row.get("basin")
        if not basin:
            continue
        skill_class = row.get("skill_class") or "unknown"
        counts[skill_class] += 1
        by_basin[basin] = {
            "lead12MeanNse": finite_number(row.get("lead12_mean_nse")),
            "lead12MinNse": finite_number(row.get("lead12_min_nse")),
            "lead12Pairs": int(float(row["lead12_pairs"])) if row.get("lead12_pairs") else 0,
            "lead1Nse": finite_number(row.get("lead1_nse")),
            "lead2Nse": finite_number(row.get("lead2_nse")),
            "skillClass": skill_class,
        }
    return by_basin, dict(sorted(counts.items()))


def load_candidate_metrics(
    metrics_csv: Path | None,
    *,
    manifest_json: Path | None,
    skill_classes_csv: Path | None,
    split: str,
    label: str,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any] | None]:
    if not metrics_csv or not metrics_csv.exists():
        return {}, None

    skill_by_basin, skill_counts = load_candidate_skill_classes(skill_classes_csv)
    metrics_by_basin: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    metrics_by_lead: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in read_csv(metrics_csv):
        if row.get("split") != split:
            continue
        basin = row.get("basin")
        lead = row.get("lead_time")
        if not basin or not lead:
            continue
        metric = candidate_metric_from_row(row)
        metrics_by_basin[basin][str(int(float(lead)))] = metric
        metrics_by_lead[str(int(float(lead)))].append(metric)

    basin_payload: dict[str, dict[str, Any]] = {}
    lead12_scores: list[float] = []
    for basin, by_lead in metrics_by_basin.items():
        lead12 = [
            metric["nse"]
            for lead, metric in by_lead.items()
            if lead in {"1", "2"} and metric.get("nse") is not None
        ]
        lead12_mean = sum(lead12) / len(lead12) if lead12 else None
        if lead12_mean is not None:
            lead12_scores.append(lead12_mean)
        skill = skill_by_basin.get(basin, {})
        basin_payload[basin] = {
            "label": label,
            "split": split,
            "byLead": dict(sorted(by_lead.items(), key=lambda item: int(item[0]))),
            "lead12MeanNse": finite_number(skill.get("lead12MeanNse", lead12_mean)),
            "lead12MinNse": finite_number(skill.get("lead12MinNse", min(lead12) if lead12 else None)),
            "lead12Pairs": skill.get("lead12Pairs"),
            "skillClass": skill.get("skillClass"),
        }

    manifest = read_json(manifest_json) if manifest_json and manifest_json.exists() else {}
    by_lead_summary = []
    for lead, rows in sorted(metrics_by_lead.items(), key=lambda item: int(item[0])):
        nses = [row["nse"] for row in rows if row.get("nse") is not None]
        by_lead_summary.append(
            {
                "leadTime": int(lead),
                "basins": len(rows),
                "medianNse": finite_number(median(nses)),
                "nseGt0": sum(1 for value in nses if value > 0.0),
                "nseGt04": sum(1 for value in nses if value > 0.4),
                "nseGt05": sum(1 for value in nses if value > 0.5),
            }
        )

    summary = {
        "label": label,
        "split": split,
        "source": metrics_csv.name,
        "schema": "streamflow-observation-candidate-metrics-v1",
        "candidateSchema": manifest.get("schema"),
        "gate": manifest.get("gate") or manifest.get("selector"),
        "selector": manifest.get("selector"),
        "calibrationSplit": manifest.get("calibration_split"),
        "members": manifest.get("members"),
        "selectionLeads": manifest.get("selection_leads"),
        "fallbackModel": manifest.get("fallback_model"),
        "basinCount": len(basin_payload),
        "lead12MedianNse": finite_number(median(lead12_scores)),
        "lead12NseGt0": sum(1 for value in lead12_scores if value > 0.0),
        "lead12NseGt04": sum(1 for value in lead12_scores if value > 0.4),
        "lead12NseGt05": sum(1 for value in lead12_scores if value > 0.5),
        "countsBySkillClass": skill_counts,
        "byLead": by_lead_summary,
        "contract": "Observed streamflow selected this fixed candidate on calibration splits only; observations are not realtime inference inputs.",
    }
    return basin_payload, summary


def main() -> None:
    args = parse_args()
    run_dir = args.validation_run_dir
    summary = read_json(run_dir / "summary.json")
    metrics_summary_path = run_dir / "forecast_validation_metrics_summary.json"
    metrics_summary = read_json(metrics_summary_path) if metrics_summary_path.exists() else {}
    audit_rows = read_csv(run_dir / "basin_observation_match_audit.csv")
    observation_rows = read_csv_gz(run_dir / "observed_streamflow.csv.gz")
    validation_rows = read_csv_gz(run_dir / "forecast_validation.csv.gz")
    candidate_by_basin, candidate_summary = load_candidate_metrics(
        args.candidate_metrics_csv,
        manifest_json=args.candidate_manifest_json,
        skill_classes_csv=args.candidate_skill_classes_csv,
        split=args.candidate_metrics_split,
        label=args.candidate_label,
    )

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
        all_validation_rows = [
            row
            for lead_rows in val_by_basin.get(basin_id, {}).values()
            for row in lead_rows
        ]
        overall_metrics = validation_metrics(all_validation_rows)
        by_lead_metrics = {
            lead: validation_metrics(rows)
            for lead, rows in sorted(val_by_basin.get(basin_id, {}).items(), key=lambda item: int(item[0]))
        }
        basin_payload = {
            "id": basin_id,
            "source": audit.get("source"),
            "stationId": audit.get("station_id"),
            "name": audit.get("gauge_name"),
            "latestObsDate": audit.get("daily_latest_date"),
            "obsCount": len(obs_by_basin.get(basin_id, [])),
            "validationCount": len(all_validation_rows),
            "metrics": overall_metrics,
            "byLead": by_lead_metrics,
            "maeMmDay": overall_metrics["maeMmDay"],
            "coverageP05P95": overall_metrics["coverageP05P95"],
            "nse": overall_metrics["nse"],
            "kge": overall_metrics["kge"],
        }
        candidate = candidate_by_basin.get(basin_id)
        if candidate:
            basin_payload["candidateMetrics"] = candidate
            basin_payload["candidateByLead"] = candidate["byLead"]
        basin_rows.append(basin_payload)

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
        "candidateMetrics": candidate_summary,
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
