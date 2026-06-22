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
    data/dashboard-data-supervised-calibrated-20260622.json
```

## Current Data

- Model: Handoff Forecast LSTM + CMAL epoch10 with supervised GFS quantile calibrator.
- Forecast horizon: lead 1-7 days.
- Forecast forcing: GFS operational forcing adapter.
- Basins: 4057 GRDC-Caravan basins.
- Fine-tuned/validated basins: 1523 USGS/ECCC matched basins.
- Supervised-label-only basins: 5 matched basins without held-out test pairs in the dashboard split.
- Prediction-only basins: 2529 basins without connected recent streamflow observations.
- Current calibrated test median NSE remains negative under GFS forcing, but coverage improves to roughly 0.93-0.97 across lead 1-7.

## Local Preview

```powershell
python -m http.server 8768 --directory public
```

Open `http://127.0.0.1:8768/`.
