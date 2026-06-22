# LSTM Global Streamflow Forecast

Static GitHub Pages dashboard for the GRDC-Caravan 1-7 day probabilistic streamflow forecast evaluation.

The dashboard uses the selected Handoff Forecast LSTM + CMAL model, with full-test basin NSE/KGE/RMSE from the
2015-2019 holdout evaluation and a one-month hydrograph sample from December 2019. Observed streamflow comes from
GRDC-Caravan holdout data. The 2026 GFS operational demo is not used for observed-vs-forecast scoring because no
near-real-time GRDC observations are bundled with that operational input demo.

Open locally with a static server:

```powershell
python -m http.server 8088
```

Then browse to `http://localhost:8088`.
