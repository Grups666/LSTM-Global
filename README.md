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
    data/dashboard-data-state-residual-hist7-persistence-blend-20260623.json
```

## Current Data

- Model: GFS residual-state forecaster, 7-day observed-flow history, 512 hidden units, trained on nonnegative USGS/ECCC daily streamflow labels, with a lead-wise D-1 persistence blend applied to P50.
- Forecast horizon: lead 1-7 days.
- Forecast forcing: GFS operational forcing adapter, issue-date realistic lead 1-7 basin forcing.
- Basins: 4057 GRDC-Caravan basins.
- Fine-tuned/validated basins: 1528 USGS/ECCC matched basins.
- Latest operational-style state forecast basins: 781 basins with enough observed-flow history before issue date 2026-06-20.
- Prediction-only basins: 2529 basins without connected recent streamflow observations.
- Test median NSE by lead after persistence blend: L1 0.508, L2 0.253, L3 0.065, L4 -0.096, L5 -0.210, L6 -0.332, L7 -0.452. Median NSE/KGE/RMSE are the primary dashboard metrics because a few low-variance basins make mean NSE unstable.

## Local Preview

```powershell
python -m http.server 8768 --directory public
```

Open `http://127.0.0.1:8768/`.
