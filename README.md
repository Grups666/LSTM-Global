# LSTM Global

LSTM Global is a Tereon domain module for global 1-7 day probabilistic streamflow forecast visualization. It shows the latest GFS-driven forecast for all GRDC-Caravan basins and recent observed-discharge validation where daily streamflow labels are available.

The Foundation map and module loader live in:

[https://github.com/Grups666/Tereon](https://github.com/Grups666/Tereon)

## Interactive Page

[https://grups666.github.io/LSTM-Global/](https://grups666.github.io/LSTM-Global/)

## Tereon Module

Direct module manifest:

```text
https://grups666.github.io/LSTM-Global/module.json
```

Repository URL import:

```text
https://github.com/Grups666/LSTM-Global
```

The manifest points Tereon to:

```text
public/modules/streamflow-forecast/
```

## Module Contents

```text
public/
  index.html
  module.json
  tereon-embed.html
  modules/streamflow-forecast/
    module.json
    index.js
    data/dashboard-data-state-current.json
    api/latest.json
    api/basins.json
    api/lead-1.json ... api/lead-7.json
```

## Current Data

- Latest forecast model: primary two-checkpoint GFS state-forecaster ensemble with conservative fallback coverage. Primary rows come from the scheduled two-checkpoint ensemble; missing basin/lead rows are filled from the three-model lead-wise ensemble only when the primary output has no row.
- Forecast horizon: lead 1-7 days.
- Forecast forcing: GFS operational forcing adapter, issue-date realistic lead 1-7 basin forcing.
- Basins: 4057 GRDC-Caravan basins.
- Fine-tuned/validated basins: 1528 USGS/ECCC/Australia matched basins.
- Latest operational-style state forecast basins: 1263 basins for auto-selected issue date 2026-06-21. Of these, 783 basins come from the primary two-checkpoint ensemble and 480 additional basins are fallback coverage.
- Prediction-only basins: 2003 basins without connected recent streamflow observations; 526 additional basins have labels but no held-out validated series in this dashboard split.
- Historical validation curves currently use the three-model lead-wise ensemble matched predictions because the fallback layer is an issue-date coverage merge, not a full historical validation product. Held-out test median NSE by lead: L1 0.525, L2 0.290, L3 0.091, L4 -0.072, L5 -0.176, L6 -0.301, L7 -0.442. Median NSE/KGE/RMSE are the primary dashboard metrics because a few low-variance basins make mean NSE unstable.

The module manifest points to the stable `dashboard-data-state-current.json`
asset. Regenerate it from the latest fallback coverage CSV with:

```powershell
python scripts\build_lstm_global_fallback_dashboard.py --update-manifests
```

The same command also exports a small static API:

```text
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/latest.json
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/basins.json
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/lead-1.json
...
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/lead-7.json
```

`latest.json` contains issue date, row counts, source counts, and file links.
The lead files contain P05/P50/P95 forecasts plus row source and
potential-effectiveness annotations for that lead.

## Local Preview

```powershell
python -m http.server 8768 --directory public
```

Open `http://127.0.0.1:8768/`.
