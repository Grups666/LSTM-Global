"""Build the LSTM-Global Tereon dashboard payload from OpenHydroNet static API.

The source API is produced by the operational OpenHydroNet runner:

    static/
      latest.json
      basins.json
      lead-1.json ... lead-7.json

This script optionally enriches basin ids with centroids from Caravan-nc
shapefiles so the Tereon module can render clickable global basin points.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--static-api-dir", type=Path, required=True)
    parser.add_argument("--output-dashboard", type=Path, required=True)
    parser.add_argument("--output-freshness", type=Path)
    parser.add_argument("--caravan-nc-dir", type=Path)
    parser.add_argument("--obs-metrics-csv", type=Path)
    parser.add_argument("--obs-metrics-split", default="test")
    parser.add_argument("--obs-metrics-label", default="Strict USGS observed streamflow validation")
    parser.add_argument("--max-lead", type=int, default=7)
    parser.add_argument("--compact", action="store_true", help="Write compact JSON.")
    return parser.parse_args()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    path.write_text(text + "\n", encoding="utf-8")


def normalize_id_value(value: Any) -> list[str]:
    if value is None:
        return []
    raw = str(value).strip()
    if not raw:
        return []
    values = {raw}
    try:
        number = float(raw)
        if math.isfinite(number) and number.is_integer():
            values.add(str(int(number)))
    except ValueError:
        pass
    return [item for item in values if item]


def build_candidate_ids(group: str, properties: dict[str, Any]) -> set[str]:
    candidates: set[str] = set()
    for value in properties.values():
        for normalized in normalize_id_value(value):
            lower = normalized.lower()
            if lower.startswith(group.lower() + "_"):
                candidates.add(lower)
            candidates.add(f"{group.lower()}_{normalized}")
    return candidates


def representative_lon_lat(geometry: Any) -> tuple[float, float] | None:
    try:
        point = geometry.representative_point()
        lon = float(point.x)
        lat = float(point.y)
    except Exception:
        try:
            centroid = geometry.centroid
            lon = float(centroid.x)
            lat = float(centroid.y)
        except Exception:
            return None
    if not (math.isfinite(lon) and math.isfinite(lat)):
        return None
    return lon, lat


def load_basin_coords(caravan_nc_dir: Path | None, wanted_ids: set[str]) -> dict[str, dict[str, Any]]:
    if not caravan_nc_dir:
        return {}
    shapefile_dir = caravan_nc_dir / "shapefiles"
    if not shapefile_dir.exists():
        return {}

    try:
        import geopandas as gpd  # type: ignore
    except Exception as exc:
        print(f"coord_status=geopandas_unavailable:{exc}", flush=True)
        return load_basin_coords_pyshp(shapefile_dir, wanted_ids)

    coords: dict[str, dict[str, Any]] = {}
    wanted_lower = {basin.lower(): basin for basin in wanted_ids}
    for shp in sorted(shapefile_dir.glob("*/*_basin_shapes.shp")):
        group = shp.parent.name.lower()
        try:
            frame = gpd.read_file(shp)
            if frame.crs is not None:
                frame = frame.to_crs("EPSG:4326")
        except Exception as exc:
            print(f"coord_warning=failed_read:{shp}:{exc}", flush=True)
            continue

        for _, row in frame.iterrows():
            props = {key: row[key] for key in frame.columns if key != "geometry"}
            matched = build_candidate_ids(group, props) & set(wanted_lower.keys())
            if not matched:
                continue
            lon_lat = representative_lon_lat(row.geometry)
            if lon_lat is None:
                continue
            lon, lat = lon_lat
            name = next((str(props[key]) for key in ("gauge_name", "station_nm", "name") if key in props and props[key]), "")
            country = str(props.get("country", "") or props.get("country_id", "") or "")
            for lower_id in matched:
                basin_id = wanted_lower[lower_id]
                coords[basin_id] = {"lon": round(lon, 5), "lat": round(lat, 5), "name": name, "country": country}
        print(f"coord_group={group} matched={sum(1 for key in coords if key.lower().startswith(group + '_'))}", flush=True)
    return coords


def load_basin_coords_pyshp(shapefile_dir: Path, wanted_ids: set[str]) -> dict[str, dict[str, Any]]:
    try:
        import shapefile  # type: ignore
    except Exception as exc:
        print(f"coord_status=pyshp_unavailable:{exc}", flush=True)
        return {}

    coords: dict[str, dict[str, Any]] = {}
    wanted_lower = {basin.lower(): basin for basin in wanted_ids}
    for shp in sorted(shapefile_dir.glob("*/*_basin_shapes.shp")):
        group = shp.parent.name.lower()
        try:
            reader = shapefile.Reader(str(shp))
        except Exception as exc:
            print(f"coord_warning=failed_read:{shp}:{exc}", flush=True)
            continue
        fields = [field[0] for field in reader.fields[1:]]
        for shape_record in reader.iterShapeRecords():
            props = dict(zip(fields, list(shape_record.record)))
            matched = build_candidate_ids(group, props) & set(wanted_lower.keys())
            if not matched:
                continue
            try:
                minx, miny, maxx, maxy = shape_record.shape.bbox
                lon = (float(minx) + float(maxx)) / 2.0
                lat = (float(miny) + float(maxy)) / 2.0
            except Exception:
                continue
            if not (math.isfinite(lon) and math.isfinite(lat)):
                continue
            name = next((str(props[key]) for key in ("gauge_name", "station_nm", "name") if key in props and props[key]), "")
            country = str(props.get("country", "") or props.get("country_id", "") or "")
            for lower_id in matched:
                basin_id = wanted_lower[lower_id]
                coords[basin_id] = {"lon": round(lon, 5), "lat": round(lat, 5), "name": name, "country": country}
        print(f"coord_group={group} matched={sum(1 for key in coords if key.lower().startswith(group + '_'))}", flush=True)
    return coords


def empty_metrics(max_lead: int) -> dict[str, dict[str, Any]]:
    return {
        str(lead): {"n": 0, "nse": None, "kge": None, "rmse": None, "coverage": None}
        for lead in range(1, max_lead + 1)
    }


def finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def load_obs_metrics(
    metrics_csv: Path | None,
    *,
    split: str,
    max_lead: int,
) -> tuple[dict[str, dict[str, dict[str, Any]]], list[dict[str, Any]], int]:
    if not metrics_csv:
        return {}, [], 0
    metrics_by_basin: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    values_by_lead: dict[int, dict[str, list[float]]] = {
        lead: {"nse": [], "kge": [], "rmse": []}
        for lead in range(1, max_lead + 1)
    }
    basin_ids: set[str] = set()
    with metrics_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if str(row.get("split", "")) != split:
                continue
            try:
                lead = int(float(str(row.get("lead_time", "")).strip()))
            except ValueError:
                continue
            if lead < 1 or lead > max_lead:
                continue
            basin = str(row.get("basin", "")).strip()
            if not basin:
                continue
            n = int(float(row.get("n", 0) or 0))
            nse = finite_float(row.get("nse"))
            kge = finite_float(row.get("kge"))
            rmse = finite_float(row.get("rmse_mm_day"))
            coverage = finite_float(row.get("coverage_p05_p95"))
            metric = {
                "n": n,
                "nse": nse,
                "kge": kge,
                "rmse": rmse,
                "coverage": coverage,
            }
            metrics_by_basin[basin][str(lead)] = metric
            basin_ids.add(basin)
            if nse is not None:
                values_by_lead[lead]["nse"].append(nse)
            if kge is not None:
                values_by_lead[lead]["kge"].append(kge)
            if rmse is not None:
                values_by_lead[lead]["rmse"].append(rmse)

    lead_summary = []
    for lead in range(1, max_lead + 1):
        values = values_by_lead[lead]
        lead_summary.append(
            {
                "lead": lead,
                "basinCount": len(values["nse"]),
                "medianNse": statistics.median(values["nse"]) if values["nse"] else None,
                "medianKge": statistics.median(values["kge"]) if values["kge"] else None,
                "medianRmse": statistics.median(values["rmse"]) if values["rmse"] else None,
            }
        )
    return dict(metrics_by_basin), lead_summary, len(basin_ids)


def lead12_mean_nse(metrics: dict[str, dict[str, Any]]) -> float | None:
    values = [
        metric.get("nse")
        for lead, metric in metrics.items()
        if lead in {"1", "2"} and metric.get("nse") is not None
    ]
    if not values:
        return None
    return float(sum(values) / len(values))


def effectiveness_from_metrics(metrics: dict[str, dict[str, Any]]) -> tuple[str, bool]:
    score = lead12_mean_nse(metrics)
    if score is None:
        return "insufficient_data", False
    if score >= 0.5:
        return "proven_effective", True
    if score >= 0.4:
        return "adapter_candidate", True
    if score >= 0.0:
        return "unproven", False
    return "low_skill", False


def build_payload(
    static_api_dir: Path,
    caravan_nc_dir: Path | None,
    max_lead: int,
    obs_metrics_csv: Path | None = None,
    obs_metrics_split: str = "test",
    obs_metrics_label: str = "Strict USGS observed streamflow validation",
) -> tuple[dict[str, Any], dict[str, Any]]:
    latest = read_json(static_api_dir / "latest.json")
    basins_payload = read_json(static_api_dir / "basins.json")
    basin_ids = [str(item["id"]) for item in basins_payload.get("basins", [])]
    wanted_ids = set(basin_ids)
    coords = load_basin_coords(caravan_nc_dir, wanted_ids)
    obs_metrics, obs_lead_summary, obs_basin_count = load_obs_metrics(
        obs_metrics_csv,
        split=obs_metrics_split,
        max_lead=max_lead,
    )

    latest_by_basin: dict[str, dict[str, Any]] = defaultdict(dict)
    lead_summary = []

    for lead in range(1, max_lead + 1):
        lead_payload = read_json(static_api_dir / f"lead-{lead}.json")
        rows = lead_payload.get("forecasts", [])
        lead_summary.append(
            {
                "lead": lead,
                "basinCount": len(rows),
                "medianNse": None,
                "medianKge": None,
                "medianRmse": None,
            }
        )
        for row in rows:
            basin = str(row["basin"])
            latest_item = {
                "issue_date": row.get("issueDate"),
                "valid_date": row.get("validDate"),
                "lead_time": lead,
                "p05": row.get("p05"),
                "p50": row.get("p50"),
                "p95": row.get("p95"),
                "mean": row.get("mean"),
                "rowSource": "openhydronet",
                "inputProducts": row.get("inputProducts", []),
                "missingProducts": row.get("missingProducts", []),
                "missingProductCount": row.get("missingProductCount"),
                "streamflowInputUsed": row.get("streamflowInputUsed", False),
            }
            latest_by_basin[basin][str(lead)] = latest_item

    basin_rows = []
    for basin_id in basin_ids:
        coord = coords.get(basin_id, {})
        metrics = obs_metrics.get(basin_id, empty_metrics(max_lead))
        has_obs_metrics = basin_id in obs_metrics
        effectiveness_status, potential_effective = effectiveness_from_metrics(metrics) if has_obs_metrics else ("unknown", False)
        basin_rows.append(
            {
                "id": basin_id,
                "lat": coord.get("lat"),
                "lon": coord.get("lon"),
                "name": coord.get("name") or basin_id,
                "country": coord.get("country") or "",
                "station_id": basin_id,
                "status": "supervised_label_available" if has_obs_metrics else "prediction_only",
                "validationStatus": "strict_obs_validated" if has_obs_metrics else "prediction_only",
                "effectivenessStatus": effectiveness_status,
                "deploymentPolicy": "openhydronet_no_streamflow_input",
                "potentialEffective": potential_effective,
                "targetedAdapterCandidate": effectiveness_status == "adapter_candidate",
                "hasLatestStateForecast": False,
                "metrics": metrics,
                "latestForecast": latest_by_basin.get(basin_id, {}),
            }
        )

    validation_summary = obs_lead_summary if obs_lead_summary else lead_summary
    meta = {
        "schemaVersion": "lstm-global-openhydronet-dashboard-v1",
        "model": "Google/FloodHub OpenHydroNet mean_embedding_forecast_lstm",
        "modelFamily": latest.get("modelFamily", "openhydronet_multimet"),
        "latestIssueDate": latest.get("issueDate"),
        "maxLead": latest.get("maxLead", max_lead),
        "rowCount": latest.get("rowCount"),
        "basinCount": latest.get("basinCount", len(basin_rows)),
        "mappedBasinCount": sum(1 for row in basin_rows if row.get("lat") is not None and row.get("lon") is not None),
        "predictionOnlyBasinCount": max(0, len(basin_rows) - obs_basin_count),
        "latestStateForecastBasinCount": latest.get("basinCount", len(basin_rows)),
        "fineTunedValidatedBasinCount": obs_basin_count,
        "obsValidationBasinCount": obs_basin_count,
        "obsValidationSplit": obs_metrics_split if obs_metrics_csv else None,
        "obsValidationLabel": obs_metrics_label if obs_metrics_csv else None,
        "obsMetricsSource": str(obs_metrics_csv) if obs_metrics_csv else None,
        "streamflowInputUsed": latest.get("streamflowInputUsed", False),
        "readiness": latest.get("readiness", {}),
        "inputProductCounts": latest.get("inputProductCounts", {}),
        "missingProductCounts": latest.get("missingProductCounts", {}),
        "latestForecastSourceCounts": {"openhydronet": latest.get("rowCount", 0)},
    }
    dashboard = {
        "meta": meta,
        "leadSummary": validation_summary,
        "baseLeadSummary": lead_summary,
        "calibratorLeadMetrics": [],
        "basins": basin_rows,
    }
    freshness = {
        "meta": {**meta, "freshnessMode": True},
        "leadSummary": lead_summary,
    }
    return dashboard, freshness


def main() -> int:
    args = parse_args()
    dashboard, freshness = build_payload(
        args.static_api_dir,
        args.caravan_nc_dir,
        args.max_lead,
        args.obs_metrics_csv,
        args.obs_metrics_split,
        args.obs_metrics_label,
    )
    write_json(args.output_dashboard, dashboard, compact=args.compact)
    if args.output_freshness:
        write_json(args.output_freshness, freshness, compact=args.compact)
    meta = dashboard["meta"]
    print(
        "dashboard_basin_count={basinCount} mapped_basin_count={mappedBasinCount} row_count={rowCount}".format(**meta),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
