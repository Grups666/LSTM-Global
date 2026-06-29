"""Build a rolling basin-level forecast history API from OpenHydroNet static exports.

Input layout:

    history-root/
      2026-06-01/static/latest.json
      2026-06-01/static/lead-1.json ... lead-7.json
      ...

Output layout:

    history/
      index.json
      shard-000.json
      shard-001.json
      ...

The dashboard loads only index.json initially. Basin time series are fetched on
demand by shard so the map does not need to load the full rolling window.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--window-days", type=int, default=30)
    parser.add_argument("--max-lead", type=int, default=7)
    parser.add_argument("--shard-size", type=int, default=250)
    return parser.parse_args()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def issue_sort_key(path: Path) -> str:
    try:
        return datetime.strptime(path.name, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return path.name


def discover_issue_dirs(history_root: Path, window_days: int) -> list[Path]:
    candidates = []
    for item in history_root.iterdir() if history_root.exists() else []:
        if not item.is_dir():
            continue
        static_dir = item / "static"
        if (static_dir / "latest.json").exists():
            candidates.append(item)
    return sorted(candidates, key=issue_sort_key)[-window_days:]


def quantile_triplet(row: dict[str, Any]) -> list[float | None]:
    values = []
    for key in ("p05", "p50", "p95"):
        value = row.get(key)
        if isinstance(value, (int, float)):
            values.append(round(float(value), 4))
        else:
            values.append(None)
    return values


def main() -> int:
    args = parse_args()
    issue_dirs = discover_issue_dirs(args.history_root, args.window_days)
    if not issue_dirs:
        raise SystemExit(f"No history static exports found under {args.history_root}")

    issue_dates = [read_json(path / "static" / "latest.json").get("issueDate", path.name) for path in issue_dirs]
    issue_dates = [str(date) for date in issue_dates]
    basin_ids: set[str] = set()
    by_basin: dict[str, dict[str, list[list[float | None] | None]]] = {}

    for date_index, issue_dir in enumerate(issue_dirs):
        static_dir = issue_dir / "static"
        for lead in range(1, args.max_lead + 1):
            lead_path = static_dir / f"lead-{lead}.json"
            if not lead_path.exists():
                continue
            payload = read_json(lead_path)
            for row in payload.get("forecasts", []):
                basin = str(row.get("basin", ""))
                if not basin:
                    continue
                basin_ids.add(basin)
                basin_series = by_basin.setdefault(basin, {})
                lead_series = basin_series.setdefault(str(lead), [None] * len(issue_dirs))
                lead_series[date_index] = quantile_triplet(row)

    sorted_basins = sorted(basin_ids)
    output_dir = args.output_dir
    if output_dir.exists():
        for old in output_dir.glob("shard-*.json"):
            old.unlink()
    output_dir.mkdir(parents=True, exist_ok=True)

    basin_to_shard: dict[str, str] = {}
    shard_files = []
    for shard_index, start in enumerate(range(0, len(sorted_basins), args.shard_size)):
        shard_basins = sorted_basins[start : start + args.shard_size]
        shard_name = f"shard-{shard_index:03d}.json"
        shard_files.append(shard_name)
        for basin in shard_basins:
            basin_to_shard[basin] = shard_name
        shard_payload = {
            "schemaVersion": "openhydronet-history-shard-v1",
            "issueDates": issue_dates,
            "basins": {basin: by_basin.get(basin, {}) for basin in shard_basins},
        }
        write_json(output_dir / shard_name, shard_payload)

    index = {
        "schemaVersion": "openhydronet-history-index-v1",
        "generatedAt": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "windowDays": args.window_days,
        "maxLead": args.max_lead,
        "issueDates": issue_dates,
        "basinCount": len(sorted_basins),
        "shardSize": args.shard_size,
        "shardFiles": shard_files,
        "basinShard": basin_to_shard,
    }
    write_json(output_dir / "index.json", index)
    print(
        f"history_issue_count={len(issue_dates)} basin_count={len(sorted_basins)} shard_count={len(shard_files)}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
