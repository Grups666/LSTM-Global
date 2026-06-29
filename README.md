# LSTM Global

LSTM Global is a Tereon module and static API host for global 1-7 day
probabilistic streamflow forecasts.

The current deployment product is based on Google/FloodHub OpenHydroNet
`mean_embedding_forecast_lstm`. Streamflow observations are not used as
inference inputs. They are reserved for training targets, validation, and future
retrospective scoring.

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

The module payload lives in:

```text
public/modules/streamflow-forecast/
```

## Current Data Product

- Model family: `openhydronet_multimet`
- Model name: `openhydronet_google_mean_embedding_forecast_lstm`
- Latest bundled issue date: `2026-06-28`
- Forecast horizon: lead 1-7 days
- Basins: 15,955 matched OpenHydroNet/Caravan-nc basins
- Rows per daily forecast: 111,685
- Inference streamflow input: `false`
- Current physical products: CPC hindcast plus ECMWF/HRES-like operational forecast group
- Missing product masks: HRES hindcast, GraphCast, IMERG are explicitly marked unavailable/masked

This repository is only the public API and visualization surface. The forecast
runner lives on the remote operational server under:

```text
D:\OpenHydroNet_FloodHub_Operational
```

## Static API

GitHub Pages exposes the latest forecast files here:

```text
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/latest.json
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/basins.json
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/lead-1.json
...
https://grups666.github.io/LSTM-Global/modules/streamflow-forecast/api/lead-7.json
```

`latest.json` contains issue date, row counts, readiness metadata, product
availability/missingness, and links to the per-lead files. Each `lead-N.json`
contains one row per basin with P05/P50/P95/mean forecast values plus
`streamflowInputUsed=false`, `inputProducts`, and `missingProducts`.

## Daily Publication

The intended production route does not go through a local workstation:

1. The remote OpenHydroNet scheduled task builds the daily forecast.
2. The remote publisher copies `outputs/api/latest/static/*.json` into a remote
   checkout of this repository.
3. The remote publisher rebuilds the Tereon dashboard JSON from the static API
   and Caravan-nc shapefile centroids.
4. The remote publisher commits and pushes to `main`.
5. GitHub Pages deploys `public/`.

Remote publish script:

```powershell
scripts\remote_publish_openhydronet_latest.ps1 -Push
```

The script expects a writable deploy key at:

```text
D:\OpenHydroNet_FloodHub_Operational\secrets\lstm_global_deploy_ed25519
```

If GitHub has not authorized that public key as a write-enabled deploy key for
`Grups666/LSTM-Global`, the forecast still runs and the publisher still commits
locally on the remote server, but `git push` fails with `Permission denied
(publickey)`.

## Local Preview

```powershell
python -m http.server 8768 --directory public
```

Open `http://127.0.0.1:8768/`.
