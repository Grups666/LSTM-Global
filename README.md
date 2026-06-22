# LSTM Global Streamflow Forecast

Static GitHub Pages dashboard for the global 1-7 day probabilistic streamflow forecast prototype.

The dashboard currently shows the GFS operational forcing demo for 2026-05-18 through 2026-06-16. Recent observed
streamflow validation is included where near-real-time USGS NWIS daily values are available. Additional USGS and
ECCC/HYDAT basins with 2022-2026 streamflow labels are marked as supervised-label candidates for future GFS fine-tuning;
the remaining basins are prediction-only until an operational observation source is connected.

Important: the displayed skill is for the current pre-fine-tuning model under GFS forcing, so it should be treated as a
domain-shift diagnostic, not as the final supervised GFS-calibrated result.

Open locally with a static server:

```powershell
python -m http.server 8088
```

Then browse to `http://localhost:8088`.
