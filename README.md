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
    data/dashboard-data-state-three-model-20260621.json
```

## Current Data

- Latest forecast model: experimental three-model lead-wise GFS state-forecaster ensemble. The members are the conservative conditional-gate state forecaster, the 12M persistence-blend state forecaster, and the train7M source x lead persistence-blend state forecaster. The comparison configuration is tracked in `configs/gfs_three_model_leadwise_ensemble_20260626.json`.
- Forecast horizon: lead 1-7 days.
- Forecast forcing: GFS operational forcing adapter, issue-date realistic lead 1-7 basin forcing.
- Basins: 4057 GRDC-Caravan basins.
- Fine-tuned/validated basins: 1528 USGS/ECCC/Australia matched basins.
- Latest operational-style state forecast basins: 1263 basins with enough observed-flow history before auto-selected issue date 2026-06-21 in at least two ensemble members.
- Prediction-only basins: 2003 basins without connected recent streamflow observations; 526 additional basins have labels but no held-out validated series in this dashboard split.
- Historical validation curves use the three-model lead-wise ensemble matched predictions. Held-out test median NSE by lead: L1 0.526, L2 0.290, L3 0.091, L4 -0.071, L5 -0.176, L6 -0.301, L7 -0.440. Median NSE/KGE/RMSE are the primary dashboard metrics because a few low-variance basins make mean NSE unstable.

## Local Preview

```powershell
python -m http.server 8768 --directory public
```

Open `http://127.0.0.1:8768/`.
