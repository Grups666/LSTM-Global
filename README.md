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
    data/dashboard-data-state-ensemble-20260621.json
```

## Current Data

- Latest forecast model: validation-tuned two-checkpoint GFS state-forecaster ensemble. The primary member is the conservative conditional-gate state forecaster; the secondary member is the 12M persistence-blend state forecaster. The ensemble configuration is tracked in `configs/gfs_state_forecaster_ensemble_deployment.yml`.
- Forecast horizon: lead 1-7 days.
- Forecast forcing: GFS operational forcing adapter, issue-date realistic lead 1-7 basin forcing.
- Basins: 4057 GRDC-Caravan basins.
- Fine-tuned/validated basins: 1528 USGS/ECCC/Australia matched basins.
- Latest operational-style state forecast basins: 783 basins with enough observed-flow history before auto-selected issue date 2026-06-21.
- Prediction-only basins: 2003 basins without connected recent streamflow observations; 526 additional basins have labels but no held-out validated series in this dashboard split.
- Historical validation curves currently use the conservative conditional-gate matched predictions. Test median NSE by lead for that baseline: L1 0.526, L2 0.270, L3 0.083, L4 -0.096, L5 -0.210, L6 -0.332, L7 -0.452. The validation-tuned ensemble improves several later leads in held-out tests but has not yet replaced the historical matched-curve dataset. Median NSE/KGE/RMSE are the primary dashboard metrics because a few low-variance basins make mean NSE unstable.

## Local Preview

```powershell
python -m http.server 8768 --directory public
```

Open `http://127.0.0.1:8768/`.
