/**
 * LSTM Global Streamflow Forecast Module
 *
 * Tereon module for 1-7 day probabilistic streamflow forecast inspection.
 */
window.StreamflowForecastModule = class StreamflowForecastModule {
  constructor(app, manifest = {}) {
    this.app = app;
    this.manifest = manifest;
    this.basePath = manifest.basePath || `/modules/${manifest.id || "streamflow-forecast"}/`;
    this.layerId = manifest.layerId || manifest.provides?.layers?.[0]?.id || "streamflow-forecast-basins";
    this.layerName = manifest.layerName || manifest.provides?.layers?.[0]?.name || "Global Streamflow Forecast";
    this.legendId = `${manifest.id || "streamflow-forecast"}-legend`;
    this.data = null;
    this.datasetsByMode = new Map();
    this.datasetMode = "coverage";
    this.basins = [];
    this.byId = new Map();
    this.selected = null;
    this.selectedLead = 1;
    this.chartModal = null;
    this.activeModalBasin = null;
    this.handleFeatureClick = (payload) => {
      if (payload.layer?.id !== this.layerId || payload.layer?.moduleId !== this.manifest.id) return;
      this.selected = payload.feature;
      this.showInspector(payload.feature);
      this.app.draw?.();
    };
  }

  async onLoad() {
    const dataset = this.manifest.datasets?.find((item) => item.id === "streamflow-forecast-dashboard");
    this.datasetsByMode.set("coverage", {
      label: "Coverage",
      data: await this.fetchJson(this.resolve(dataset?.file || "./data/dashboard-data.json"))
    });
    const freshnessDataset = this.manifest.datasets?.find((item) => item.id === "streamflow-forecast-dashboard-freshness");
    if (freshnessDataset?.file) {
      try {
        this.datasetsByMode.set("freshness", {
          label: "Freshness",
          data: await this.fetchJson(this.resolve(freshnessDataset.file))
        });
      } catch (error) {
        console.warn("Freshness-first streamflow dataset unavailable", error);
      }
    }
    this.setDataPayload(this.datasetsByMode.get(this.datasetMode).data);
    this.addLayer();
    this.ensureStyles();
    this.ensureLegend();
    this.showOverview();
    Foundation.eventBus.on(Foundation.Events.FEATURE_CLICK, this.handleFeatureClick);
    this.app.draw?.();
  }

  setDataPayload(data) {
    this.data = data;
    this.basins = (this.data.basins || [])
      .filter((basin) => Number.isFinite(Number(basin.lon)) && Number.isFinite(Number(basin.lat)))
      .map((basin) => ({
        ...basin,
        id: String(basin.id),
        lon: Number(basin.lon),
        lat: Number(basin.lat)
      }));
    this.byId = new Map(this.basins.map((basin) => [basin.id, basin]));
  }

  onUnload() {
    this.app.layerManager.removeLayer(this.layerId);
    this.app.unregisterLegend?.(this.legendId);
    Foundation.eventBus.off(Foundation.Events.FEATURE_CLICK, this.handleFeatureClick);
    this.closeChartModal();
    this.selected = null;
  }

  getLayerIds() {
    return [this.layerId];
  }

  resolve(path) {
    if (/^https?:\/\//i.test(path) || path.startsWith("/")) return path;
    return this.basePath + path.replace(/^\.\//, "");
  }

  async fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    return response.json();
  }

  addLayer() {
    this.app.layerManager.addLayer({
      id: this.layerId,
      name: this.layerName,
      type: "vector",
      visible: true,
      interactive: true,
      moduleId: this.manifest.id,
      groupPath: ["forecast"],
      metadata: {
        issueDate: this.data?.meta?.latestIssueDate,
        model: this.data?.meta?.model
      },
      renderer: (ctx, _layer, viewport) => this.render(ctx, viewport),
      hitTest: (lon, lat, viewport) => this.hitTest(lon, lat, viewport)
    });
    this.app.updateLayerList?.();
  }

  render(ctx, viewport) {
    const base = (viewport.height / 180) * viewport.scale;
    const { width, height, offsetX, offsetY } = viewport;
    const leftLon = (-width / 2 - offsetX) / base;
    const rightLon = (width / 2 - offsetX) / base;
    const firstSeg = Math.floor(leftLon / 360);
    const lastSeg = Math.ceil(rightLon / 360);

    for (let seg = firstSeg; seg <= lastSeg; seg++) {
      const lonOffset = seg * 360;
      for (const basin of this.basins) {
        const x = width / 2 + (basin.lon + lonOffset) * base + offsetX;
        const y = height / 2 - basin.lat * base + offsetY;
        if (x < -18 || x > width + 18 || y < -18 || y > height + 18) continue;

        const selected = this.selected?.id === basin.id;
        const hovered = this.app.hoveredLayer?.id === this.layerId && this.app.hoveredFeatureId === basin.id;
        const forecastSource = this.latestSourceForLead(basin);
        const fallbackForecast = forecastSource && forecastSource !== "primary";
        const radius = selected ? 6.8 : hovered ? 5.6 : 3.9;
        ctx.globalAlpha = selected ? 0.98 : basin.status === "prediction_only" ? 0.72 : 0.84;
        ctx.fillStyle = this.skillColor(this.metricValue(basin, "nse"));
        ctx.strokeStyle = fallbackForecast ? "#f59e0b" : selected ? "#0f172a" : hovered ? "#1d4ed8" : "rgba(15,23,42,0.34)";
        ctx.lineWidth = fallbackForecast ? (selected || hovered ? 2.4 : 1.6) : selected ? 2.2 : hovered ? 1.8 : 0.7;

        if (basin.status === "prediction_only") {
          this.drawTriangle(ctx, x, y, radius + 0.8);
        } else if (basin.status === "supervised_label_available") {
          this.drawDiamond(ctx, x, y, radius + 1.0);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
      }
    }
  }

  drawTriangle(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.moveTo(x, y - radius);
    ctx.lineTo(x + radius * 0.9, y + radius * 0.7);
    ctx.lineTo(x - radius * 0.9, y + radius * 0.7);
    ctx.closePath();
  }

  drawDiamond(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.moveTo(x, y - radius);
    ctx.lineTo(x + radius, y);
    ctx.lineTo(x, y + radius);
    ctx.lineTo(x - radius, y);
    ctx.closePath();
  }

  hitTest(lon, lat, viewport) {
    const normalizedLon = ((lon + 180) % 360 + 360) % 360 - 180;
    const threshold = Math.max(0.12, 7 / ((viewport.height / 180) * viewport.scale));
    let best = null;
    let bestDistance = Infinity;

    for (const basin of this.basins) {
      const dx = this.lonDistance(normalizedLon, basin.lon);
      const dy = lat - basin.lat;
      const distance = Math.hypot(dx, dy);
      if (distance < threshold && distance < bestDistance) {
        best = basin;
        bestDistance = distance;
      }
    }
    return best;
  }

  lonDistance(a, b) {
    let diff = a - b;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return diff;
  }

  showOverview() {
    const meta = this.data.meta || {};
    const summary = Array.isArray(this.data.leadSummary) ? this.data.leadSummary : [];
    const sourceCounts = meta.latestForecastSourceCounts || {};
    const content = `
      <div class="sf-overview">
        ${this.renderModeButtons()}
        <div class="sf-lead-row">${this.renderLeadButtons()}</div>
        <div class="sf-card-grid">
          ${this.metricCard("Basins", this.formatInt(meta.basinCount || this.basins.length))}
          ${this.metricCard("Fine-tuned", this.formatInt(meta.fineTunedValidatedBasinCount ?? meta.recentValidatedBasinCount))}
          ${this.metricCard("Latest run", this.formatInt(meta.latestStateForecastBasinCount))}
          ${this.metricCard("Fallback rows", this.formatInt(sourceCounts.three_model || sourceCounts.fallback || 0))}
          ${this.metricCard("Prediction only", this.formatInt(meta.predictionOnlyBasinCount))}
        </div>
        <div class="sf-meta-line">
          <span>${this.escape(meta.model || "Forecast model")}</span>
          <span>Issue ${this.escape(meta.latestIssueDate || "pending")}</span>
        </div>
        ${this.renderLeadSummary(summary)}
      </div>
    `;
    this.app.showInspector?.("LSTM Global", content);
    this.bindModeButtons(null);
    this.bindLeadButtons(null);
  }

  showInspector(basin) {
    const metrics = this.metricsForLead(basin);
    const latest = this.latestForLead(basin);
    const content = `
      <div class="sf-basin-panel">
        ${this.renderModeButtons()}
        <div class="sf-lead-row">${this.renderLeadButtons()}</div>
        ${this.statusBanner(basin)}
        <div class="sf-card-grid">
          ${this.metricCard("NSE", this.formatMetric(metrics?.nse, 3))}
          ${this.metricCard("KGE", this.formatMetric(metrics?.kge, 3))}
          ${this.metricCard("RMSE", this.formatMetric(metrics?.rmse, 3))}
          ${this.metricCard("Pairs", this.formatInt(metrics?.n))}
          ${this.metricCard("Latest P50", this.formatFlow(latest?.p50))}
          ${this.metricCard("P05-P95", `${this.formatFlow(latest?.p05)} - ${this.formatFlow(latest?.p95)}`)}
          ${this.metricCard("Forecast source", this.forecastSourceLabel(latest))}
        </div>
        <div class="sf-meta-line">
          <span>${this.escape(basin.country || "unknown")}</span>
          <span>${this.escape(basin.station_id || basin.id)}</span>
          <span>Valid ${this.escape(this.validDate(latest, this.selectedLead))}</span>
        </div>
        <div class="sf-chart-preview" data-sf-open-chart="${this.escape(basin.id)}" role="button" tabindex="0" aria-label="Open basin hydrograph">
          ${this.renderChartSvg(basin, this.selectedLead, 300, 160, { interactive: false, legend: false })}
        </div>
      </div>
    `;
    this.app.showInspector?.(this.basinTitle(basin), content);
    this.bindModeButtons(basin);
    this.bindLeadButtons(basin);
    this.bindChartOpeners();
    this.bindChartInteractions();
  }

  renderModeButtons() {
    if (this.datasetsByMode.size < 2) return "";
    return `
      <div class="sf-mode-row">
        ${Array.from(this.datasetsByMode.entries()).map(([mode, entry]) => {
          const active = mode === this.datasetMode ? "active" : "";
          return `<button class="sf-mode ${active}" type="button" data-sf-mode="${mode}">${this.escape(entry.label)}</button>`;
        }).join("")}
      </div>
    `;
  }

  renderLeadButtons() {
    return Array.from({ length: 7 }, (_, index) => {
      const lead = index + 1;
      const active = lead === this.selectedLead ? "active" : "";
      return `<button class="sf-lead ${active}" type="button" data-sf-lead="${lead}">L${lead}</button>`;
    }).join("");
  }

  bindLeadButtons(basin) {
    document.querySelectorAll("[data-sf-lead]").forEach((button) => {
      button.addEventListener("click", () => {
        this.selectedLead = Number(button.dataset.sfLead) || 1;
        if (basin) this.showInspector(basin);
        else this.showOverview();
        if (this.activeModalBasin) this.renderChartModal(this.activeModalBasin);
        this.app.draw?.();
      });
    });
  }

  bindModeButtons(basin) {
    document.querySelectorAll("[data-sf-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.sfMode || "coverage";
        this.setDatasetMode(mode, basin?.id || null);
      });
    });
  }

  setDatasetMode(mode, selectedId = null) {
    const entry = this.datasetsByMode.get(mode);
    if (!entry || mode === this.datasetMode) return;
    this.datasetMode = mode;
    const keepSelectedId = selectedId || this.selected?.id || null;
    this.setDataPayload(entry.data);
    this.selected = keepSelectedId ? this.byId.get(keepSelectedId) || null : null;
    if (this.selected) this.showInspector(this.selected);
    else this.showOverview();
    if (this.activeModalBasin) {
      this.activeModalBasin = this.selected || this.byId.get(this.activeModalBasin.id) || null;
      if (this.activeModalBasin) this.renderChartModal(this.activeModalBasin);
      else this.closeChartModal();
    }
    this.app.draw?.();
  }

  bindChartOpeners() {
    document.querySelectorAll("[data-sf-open-chart]").forEach((button) => {
      const open = () => {
        const basin = this.byId.get(String(button.dataset.sfOpenChart));
        if (basin) this.openChartModal(basin);
      };
      button.addEventListener("click", open);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  bindChartInteractions(root = document) {
    root.querySelectorAll?.(".sf-chart-shell[data-sf-interactive='1']").forEach((shell) => {
      if (shell.dataset.sfBound === "1") return;
      shell.dataset.sfBound = "1";
      shell.addEventListener("mousemove", (event) => this.handleChartPointer(event, shell));
      shell.addEventListener("mouseleave", () => this.clearChartPointer(shell));
    });
  }

  renderLeadSummary(summary) {
    if (!summary.length) return "";
    const rows = summary.map((item) => `
      <tr>
        <td>L${this.escape(item.lead)}</td>
        <td>${this.formatInt(item.basinCount)}</td>
        <td>${this.formatMetric(item.medianNse, 3)}</td>
        <td>${this.formatMetric(item.medianKge, 3)}</td>
        <td>${this.formatMetric(item.medianRmse, 3)}</td>
      </tr>
    `).join("");
    return `
      <table class="sf-table">
        <thead><tr><th>Lead</th><th>Basins</th><th>NSE</th><th>KGE</th><th>RMSE</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  statusBanner(basin) {
    const label = basin.status === "fine_tuned_validated"
      ? "Fine-tuned validation"
      : basin.status === "supervised_label_available"
        ? "Supervised label only"
        : "Prediction only";
    const cls = basin.status === "fine_tuned_validated"
      ? "validated"
      : basin.status === "supervised_label_available"
        ? "label"
        : "prediction";
    return `
      <div class="sf-status ${cls}">
        <span>${this.escape(label)}</span>
        <strong>${this.escape(basin.id)}</strong>
      </div>
    `;
  }

  metricCard(label, value) {
    return `
      <div class="sf-card">
        <div class="sf-card-value">${this.escape(value)}</div>
        <div class="sf-card-label">${this.escape(label)}</div>
      </div>
    `;
  }

  metricsForLead(basin) {
    return basin.metrics?.[String(this.selectedLead)] || null;
  }

  latestForLead(basin) {
    return basin.latestForecast?.[String(this.selectedLead)] || null;
  }

  latestSourceForLead(basin) {
    return String(basin.latestForecast?.[String(this.selectedLead)]?.rowSource || "");
  }

  forecastSourceLabel(latest) {
    const source = String(latest?.rowSource || "");
    if (!source) return "No latest";
    if (source === "primary") return "Primary";
    if (source === "three_model") return "Fallback";
    return source.replaceAll("_", " ");
  }

  metricValue(basin, key) {
    const value = basin.metrics?.[String(this.selectedLead)]?.[key];
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  skillColor(nse) {
    if (!Number.isFinite(Number(nse))) return "#94a3b8";
    const value = Math.max(0, Math.min(0.8, Number(nse))) / 0.8;
    const stops = [
      [124, 58, 237],
      [37, 99, 235],
      [14, 165, 233],
      [16, 185, 129],
      [245, 158, 11]
    ];
    const scaled = value * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(scaled));
    const t = scaled - index;
    const a = stops[index];
    const b = stops[index + 1];
    const rgb = a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  ensureLegend() {
    this.app.registerLegend?.(this.legendId, {
      title: "Lead NSE",
      html: `
        <div class="sf-legend">
          <div class="sf-gradient"></div>
          <div class="sf-legend-ticks"><span>0 or below</span><span>0.4</span><span>0.8+</span></div>
          <div class="sf-symbol-row"><span class="sf-dot-symbol"></span>Fine-tuned <span class="sf-diamond-symbol"></span>Label only <span class="sf-triangle-symbol"></span>Prediction only <span class="sf-fallback-symbol"></span>Fallback forecast</div>
        </div>
      `
    });
  }

  openChartModal(basin) {
    this.activeModalBasin = basin;
    this.ensureChartModal();
    this.renderChartModal(basin);
    this.chartModal.classList.add("visible");
  }

  ensureChartModal() {
    if (this.chartModal) return;
    const modal = document.createElement("div");
    modal.className = "sf-modal";
    modal.innerHTML = `
      <div class="sf-modal-card">
        <div class="sf-modal-head">
          <div>
            <p class="sf-kicker">Basin hydrograph</p>
            <h2 class="sf-modal-title"></h2>
          </div>
          <button class="sf-modal-close" type="button" aria-label="Close">Close</button>
        </div>
        <div class="sf-modal-body"></div>
      </div>
    `;
    modal.querySelector(".sf-modal-close").addEventListener("click", () => this.closeChartModal());
    modal.addEventListener("click", (event) => {
      if (event.target === modal) this.closeChartModal();
    });
    document.body.appendChild(modal);
    this.chartModal = modal;
  }

  renderChartModal(basin) {
    if (!this.chartModal) return;
    this.chartModal.querySelector(".sf-modal-title").textContent = this.basinTitle(basin);
    this.chartModal.querySelector(".sf-modal-body").innerHTML = `
      <div class="sf-lead-row">${this.renderLeadButtons()}</div>
      <div class="sf-modal-meta">${this.escape(basin.id)} / ${this.escape(basin.country || "unknown")} / lead ${this.selectedLead}</div>
      ${this.renderChartSvg(basin, this.selectedLead, 760, 360, { interactive: true, legend: true })}
    `;
    this.bindLeadButtons(basin);
    this.bindChartInteractions(this.chartModal);
  }

  closeChartModal() {
    this.chartModal?.classList.remove("visible");
    this.activeModalBasin = null;
  }

  renderChartSvg(basin, lead, width, height, options = {}) {
    const interactive = options.interactive === true;
    const showLegend = options.legend !== false;
    const series = this.data.series?.[basin.id]?.[String(lead)];
    if (!series || !Array.isArray(series.valid_date) || !series.valid_date.length) {
      const latest = basin.latestForecast?.[String(lead)];
      return `
        <div class="sf-empty-chart">
          <div>${this.escape(this.formatFlow(latest?.p50))}</div>
          <span>Latest P50 for lead ${lead}</span>
        </div>
      `;
    }

    const margin = { top: 16, right: 18, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const dates = series.valid_date;
    const values = this.chartValues(series);
    if (!values.length) return `<div class="sf-empty-chart"><div>No valid series</div><span>Lead ${lead}</span></div>`;

    const domain = this.chartYDomain(basin);
    const min = domain.min;
    const max = Math.max(domain.max, ...values);
    const span = Math.max(max - min, 1e-6);
    const x = (i) => margin.left + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * plotWidth);
    const y = (value) => margin.top + (1 - ((value - min) / span)) * plotHeight;
    const point = (key, i) => {
      const value = Number(series[key]?.[i]);
      return Number.isFinite(value) && value >= 0 ? `${x(i).toFixed(1)},${y(value).toFixed(1)}` : null;
    };
    const polyline = (key) => dates.map((_, i) => point(key, i)).filter(Boolean).join(" ");
    const bandTop = dates.map((_, i) => point("p95", i)).filter(Boolean);
    const bandBottom = dates.map((_, i) => point("p05", i)).filter(Boolean).reverse();
    const band = [...bandTop, ...bandBottom].join(" ");
    const xTicks = this.indexTicks(dates.length, width >= 600 ? 6 : 4);
    const yTicks = this.yTicks(min, max, 5);
    const xTickMarkup = xTicks.map((index) => {
      const px = x(index);
      const label = dates[index] || "";
      const anchor = index === 0 ? "start" : index === dates.length - 1 ? "end" : "middle";
      return `
        <line class="sf-grid" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${margin.top}" y2="${height - margin.bottom}"></line>
        <text class="sf-axis-label" x="${px.toFixed(1)}" y="${height - 10}" font-size="10" text-anchor="${anchor}">${this.escape(label)}</text>
      `;
    }).join("");
    const yTickMarkup = yTicks.map((value) => {
      const py = y(value);
      return `
        <line class="sf-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}"></line>
        <text class="sf-axis-label" x="${margin.left - 8}" y="${(py + 3).toFixed(1)}" font-size="10" text-anchor="end">${this.formatMetric(value, 2)}</text>
      `;
    }).join("");
    const hoverMarkup = interactive ? `
          <line class="sf-hover-v" x1="0" x2="0" y1="${margin.top}" y2="${height - margin.bottom}"></line>
          <line class="sf-hover-h" x1="${margin.left}" x2="${width - margin.right}" y1="0" y2="0"></line>
          <circle class="sf-hover-dot sf-hover-dot-p50" cx="0" cy="0" r="4"></circle>
          <circle class="sf-hover-dot sf-hover-dot-obs" cx="0" cy="0" r="4"></circle>
          <text class="sf-hover-label sf-hover-label-p50" x="0" y="0"></text>
          <text class="sf-hover-label sf-hover-label-obs" x="0" y="0"></text>
          <text class="sf-hover-label sf-hover-label-band" x="0" y="0"></text>
          <text class="sf-hover-label sf-hover-label-date" x="0" y="0"></text>
    ` : "";
    const legendMarkup = showLegend ? `
        <div class="sf-chart-legend" aria-hidden="true">
          <span><i class="sf-legend-band"></i>P05-P95</span>
          <span><i class="sf-legend-p50"></i>P50</span>
          <span><i class="sf-legend-obs"></i>Observed</span>
        </div>
    ` : "";

    return `
      <div class="sf-chart-shell ${interactive ? "sf-chart-interactive" : "sf-chart-static"}" data-sf-basin-id="${this.escape(basin.id)}" data-sf-lead="${this.escape(lead)}" data-sf-width="${width}" data-sf-height="${height}" data-sf-interactive="${interactive ? "1" : "0"}">
        <svg class="sf-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Streamflow forecast hydrograph">
          <rect class="sf-chart-bg" x="0" y="0" width="${width}" height="${height}" rx="8"></rect>
          ${xTickMarkup}
          ${yTickMarkup}
          <line class="sf-axis" x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}"></line>
          <line class="sf-axis" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}"></line>
          ${band ? `<polygon class="sf-band" points="${band}" stroke="none"></polygon>` : ""}
          <polyline class="sf-line-p50" points="${polyline("p50")}" fill="none" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></polyline>
          <polyline class="sf-line-obs" points="${polyline("obs")}" fill="none" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round"></polyline>
          ${hoverMarkup}
        </svg>
        ${legendMarkup}
      </div>
    `;
  }

  handleChartPointer(event, shell) {
    const svg = shell.querySelector(".sf-chart");
    const basin = this.byId.get(String(shell.dataset.sfBasinId || ""));
    const lead = Number(shell.dataset.sfLead || 1);
    const width = Number(shell.dataset.sfWidth || 0);
    const height = Number(shell.dataset.sfHeight || 0);
    const series = basin ? this.data.series?.[basin.id]?.[String(lead)] : null;
    if (!svg || !basin || !series?.valid_date?.length || !width || !height) return;

    const rect = svg.getBoundingClientRect();
    const margin = { top: 16, right: 18, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const pointerX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const ratio = Math.max(0, Math.min(1, (pointerX - margin.left) / Math.max(1, plotWidth)));
    const index = Math.round(ratio * (series.valid_date.length - 1));
    const domain = this.chartYDomain(basin);
    const min = domain.min;
    const values = this.chartValues(series);
    const max = Math.max(domain.max, ...values);
    const span = Math.max(max - min, 1e-6);
    const x = margin.left + (series.valid_date.length <= 1 ? 0 : (index / (series.valid_date.length - 1)) * plotWidth);
    const y = (value) => margin.top + (1 - ((value - min) / span)) * plotHeight;
    const p50 = this.nonnegative(series.p50?.[index]);
    const obs = this.nonnegative(series.obs?.[index]);
    const p05 = this.nonnegative(series.p05?.[index]);
    const p95 = this.nonnegative(series.p95?.[index]);
    const yAnchor = Number.isFinite(p50) ? y(p50) : Number.isFinite(obs) ? y(obs) : margin.top + plotHeight / 2;

    shell.style.setProperty("--sf-hover-x", x.toFixed(1));
    shell.style.setProperty("--sf-hover-y", yAnchor.toFixed(1));
    const p50Dot = shell.querySelector(".sf-hover-dot-p50");
    const obsDot = shell.querySelector(".sf-hover-dot-obs");
    const dateAnchor = x > width - margin.right - 90 ? "end" : "start";
    const labelX = dateAnchor === "end" ? x - 8 : x + 8;
    if (p50Dot) {
      p50Dot.setAttribute("cx", x.toFixed(1));
      p50Dot.setAttribute("cy", Number.isFinite(p50) ? y(p50).toFixed(1) : "-20");
    }
    if (obsDot) {
      obsDot.setAttribute("cx", x.toFixed(1));
      obsDot.setAttribute("cy", Number.isFinite(obs) ? y(obs).toFixed(1) : "-20");
    }
    this.setHoverText(shell, ".sf-hover-label-p50", Number.isFinite(p50) ? `P50 ${this.formatFlow(p50)}` : "", labelX, Number.isFinite(p50) ? y(p50) - 8 : -20, dateAnchor);
    this.setHoverText(shell, ".sf-hover-label-obs", Number.isFinite(obs) ? `Obs ${this.formatFlow(obs)}` : "", labelX, Number.isFinite(obs) ? y(obs) + 14 : -20, dateAnchor);
    this.setHoverText(shell, ".sf-hover-label-band", Number.isFinite(p05) || Number.isFinite(p95) ? `P05-P95 ${this.formatFlow(p05)}-${this.formatFlow(p95)}` : "", labelX, Math.max(margin.top + 12, yAnchor - 22), dateAnchor);
    this.setHoverText(shell, ".sf-hover-label-date", series.valid_date[index] || "", labelX, height - margin.bottom - 6, dateAnchor);
    shell.classList.add("is-hovering");
  }

  clearChartPointer(shell) {
    shell.classList.remove("is-hovering");
    shell.querySelectorAll(".sf-hover-label").forEach((node) => {
      node.textContent = "";
    });
  }

  setHoverText(shell, selector, text, x, y, anchor = "start") {
    const node = shell.querySelector(selector);
    if (!node) return;
    node.textContent = text;
    node.setAttribute("x", Number.isFinite(x) ? x.toFixed(1) : "0");
    node.setAttribute("y", Number.isFinite(y) ? y.toFixed(1) : "-20");
    node.setAttribute("text-anchor", anchor);
  }

  nonnegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : NaN;
  }

  chartValues(series) {
    const values = [];
    for (const key of ["obs", "p05", "p50", "p95"]) {
      for (const raw of series?.[key] || []) {
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) values.push(value);
      }
    }
    return values;
  }

  chartYDomain(basin) {
    const byLead = this.data.series?.[basin.id] || {};
    const values = [];
    for (let lead = 1; lead <= 7; lead += 1) {
      values.push(...this.chartValues(byLead[String(lead)]));
    }
    const max = values.length ? Math.max(...values) : 1;
    return { min: 0, max: Math.max(max, 1e-6) };
  }

  indexTicks(length, targetCount) {
    if (!length) return [];
    if (length <= targetCount) return Array.from({ length }, (_, index) => index);
    const ticks = new Set();
    const steps = Math.max(1, targetCount - 1);
    for (let step = 0; step <= steps; step += 1) {
      ticks.add(Math.round((step / steps) * (length - 1)));
    }
    return Array.from(ticks).sort((a, b) => a - b);
  }

  yTicks(min, max, targetCount) {
    const low = Number.isFinite(min) ? min : 0;
    const high = Number.isFinite(max) && max > low ? max : low + 1;
    const steps = Math.max(1, targetCount - 1);
    return Array.from({ length: steps + 1 }, (_, index) => low + (index / steps) * (high - low));
  }

  validDate(latest, lead) {
    if (latest?.valid_date) return latest.valid_date;
    if (!latest?.issue_date) return "pending";
    const date = new Date(`${latest.issue_date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return "pending";
    date.setUTCDate(date.getUTCDate() + Number(lead || 0));
    return date.toISOString().slice(0, 10);
  }

  basinTitle(basin) {
    return basin.name ? basin.name : basin.id;
  }

  ensureStyles() {
    if (document.getElementById("streamflow-forecast-styles")) return;
    const style = document.createElement("style");
    style.id = "streamflow-forecast-styles";
    style.textContent = `
      .sf-overview,.sf-basin-panel,.sf-modal{--sf-surface:#fff;--sf-surface-soft:#f8fafc;--sf-surface-chip:#f1f5f9;--sf-border:#e2e8f0;--sf-border-strong:#cbd5e1;--sf-text:#0f172a;--sf-muted:#64748b;--sf-focus:#2563eb;--sf-focus-soft:rgba(37,99,235,.16);--sf-button:#fff;--sf-button-active:#0f172a;--sf-button-active-text:#fff;--sf-chart-bg:#f8fafc;--sf-band:rgba(14,165,233,.18);--sf-p50:#0284c7;--sf-obs:#0f172a;--sf-overlay:rgba(15,23,42,.58);--sf-shadow:0 24px 80px rgba(15,23,42,.35);--sf-readout-bg:rgba(255,255,255,.94)}
      body.theme-dark .sf-overview,body.theme-dark .sf-basin-panel,body.theme-dark .sf-modal{--sf-surface:#111827;--sf-surface-soft:#1f2937;--sf-surface-chip:#182235;--sf-border:#334155;--sf-border-strong:#475569;--sf-text:#e5e7eb;--sf-muted:#94a3b8;--sf-focus:#38bdf8;--sf-focus-soft:rgba(56,189,248,.18);--sf-button:#1f2937;--sf-button-active:#38bdf8;--sf-button-active-text:#082f49;--sf-chart-bg:#0f172a;--sf-band:rgba(56,189,248,.20);--sf-p50:#38bdf8;--sf-obs:#f8fafc;--sf-overlay:rgba(2,6,23,.72);--sf-shadow:0 24px 80px rgba(0,0,0,.58);--sf-readout-bg:rgba(17,24,39,.94)}
      .sf-lead-row{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
      .sf-lead{border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:6px 9px;font-size:12px;font-weight:700;cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease,color .16s ease}
      .sf-lead:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-lead.active{background:var(--sf-button-active);border-color:var(--sf-button-active);color:var(--sf-button-active-text)}
      .sf-mode-row{display:flex;gap:8px;margin:0 0 10px}
      .sf-mode{border:1px solid var(--sf-border-strong);background:var(--sf-surface-muted);color:var(--sf-muted);border-radius:6px;padding:6px 10px;font-size:12px;font-weight:800;cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease,color .16s ease}
      .sf-mode:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-mode.active{background:var(--sf-text);border-color:var(--sf-text);color:var(--sf-surface)}
      .sf-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0 0 14px}
      .sf-card{background:var(--sf-surface-soft);border:1px solid var(--sf-border);border-radius:6px;padding:9px}
      .sf-card-value{font-size:16px;font-weight:800;color:var(--sf-text);line-height:1.2;overflow-wrap:anywhere}
      .sf-card-label{font-size:11px;color:var(--sf-muted);margin-top:3px}
      .sf-meta-line{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px;color:var(--sf-muted);font-size:11px}
      .sf-meta-line span,.sf-modal-meta{background:var(--sf-surface-chip);border:1px solid var(--sf-border);border-radius:999px;padding:4px 8px}
      .sf-table{width:100%;border-collapse:collapse;font-size:11px}
      .sf-table th,.sf-table td{padding:6px;border-bottom:1px solid var(--sf-border);text-align:right;color:var(--sf-text)}
      .sf-table th:first-child,.sf-table td:first-child{text-align:left}
      .sf-status{display:flex;justify-content:space-between;gap:8px;border-radius:6px;padding:9px 10px;margin:0 0 12px;font-size:12px}
      .sf-status.validated{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
      .sf-status.label{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
      .sf-status.prediction{background:var(--sf-surface-soft);color:var(--sf-muted);border:1px solid var(--sf-border-strong)}
      body.theme-dark .sf-status.validated{background:rgba(6,95,70,.24);color:#a7f3d0;border-color:rgba(16,185,129,.48)}
      body.theme-dark .sf-status.label{background:rgba(29,78,216,.22);color:#bfdbfe;border-color:rgba(96,165,250,.45)}
      .sf-chart-preview{cursor:pointer;border:1px solid transparent;border-radius:8px;padding:4px;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease,transform .16s ease}
      .sf-chart-preview:hover,.sf-chart-preview:focus-visible{border-color:var(--sf-focus);background:var(--sf-focus-soft);box-shadow:0 0 0 2px var(--sf-focus-soft),0 12px 28px rgba(15,23,42,.16);transform:translateY(-1px);outline:0}
      .sf-chart-shell{position:relative}
      .sf-chart{width:100%;height:auto;display:block;border:1px solid var(--sf-border);border-radius:8px}
      .sf-chart-bg{fill:var(--sf-chart-bg)}
      .sf-axis{stroke:var(--sf-border-strong)}
      .sf-grid{stroke:var(--sf-border);stroke-width:1;opacity:.58}
      .sf-axis-label{fill:var(--sf-muted)}
      .sf-band{fill:var(--sf-band)}
      .sf-line-p50{stroke:var(--sf-p50)}
      .sf-line-obs{stroke:var(--sf-obs)}
      .sf-hover-v{stroke:var(--sf-muted);stroke-width:1;stroke-dasharray:4 4;opacity:0;transform:translateX(calc(var(--sf-hover-x,0) * 1px))}
      .sf-hover-h{stroke:var(--sf-muted);stroke-width:1;stroke-dasharray:4 4;opacity:0;transform:translateY(calc(var(--sf-hover-y,0) * 1px))}
      .sf-hover-dot{opacity:0;stroke:var(--sf-chart-bg);stroke-width:2}
      .sf-hover-dot-p50{fill:var(--sf-p50)}
      .sf-hover-dot-obs{fill:var(--sf-obs)}
      .sf-hover-label{opacity:0;fill:var(--sf-text);font-size:11px;font-weight:700;paint-order:stroke;stroke:var(--sf-chart-bg);stroke-width:3px;stroke-linejoin:round;pointer-events:none}
      .sf-hover-label-band,.sf-hover-label-date{fill:var(--sf-muted);font-weight:650}
      .sf-hover-label-date{font-size:10px}
      .sf-chart-shell.is-hovering .sf-hover-v,.sf-chart-shell.is-hovering .sf-hover-h,.sf-chart-shell.is-hovering .sf-hover-dot{opacity:1}
      .sf-chart-shell.is-hovering .sf-hover-label{opacity:.78}
      .sf-chart-legend{display:flex;flex-wrap:wrap;gap:10px;margin:7px 0 0;color:var(--sf-muted);font-size:11px}
      .sf-chart-legend span{display:inline-flex;align-items:center;gap:5px}
      .sf-chart-legend i{display:inline-block;width:18px;height:0;border-top:3px solid currentColor;border-radius:999px}
      .sf-legend-band{height:8px!important;border:0!important;background:var(--sf-band);box-shadow:0 0 0 1px var(--sf-border) inset}
      .sf-legend-p50{color:var(--sf-p50)}
      .sf-legend-obs{color:var(--sf-obs)}
      .sf-empty-chart{height:138px;display:grid;place-items:center;background:var(--sf-surface-soft);border:1px solid var(--sf-border);border-radius:8px;text-align:center;color:var(--sf-muted)}
      .sf-empty-chart div{font-size:24px;font-weight:800;color:var(--sf-text)}
      .sf-legend{font-size:11px;color:var(--sf-muted,#475569)}
      body.theme-dark .sf-legend{color:#94a3b8}
      .sf-gradient{height:9px;border-radius:999px;background:linear-gradient(90deg,#7c3aed,#2563eb,#0ea5e9,#10b981,#f59e0b);margin:6px 0}
      .sf-legend-ticks,.sf-symbol-row{display:flex;justify-content:space-between;gap:6px}
      .sf-symbol-row{align-items:center;margin-top:6px}
      .sf-dot-symbol{width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block}
      .sf-diamond-symbol{width:8px;height:8px;background:#60a5fa;display:inline-block;transform:rotate(45deg)}
      .sf-triangle-symbol{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid #94a3b8;display:inline-block}
      .sf-fallback-symbol{width:11px;height:11px;border:2px solid #f59e0b;border-radius:50%;display:inline-block;background:transparent}
      .sf-modal{position:fixed;inset:0;background:var(--sf-overlay);z-index:5000;display:none;align-items:center;justify-content:center;padding:24px}
      .sf-modal.visible{display:flex}
      .sf-modal-card{width:min(900px,96vw);max-height:92vh;overflow:auto;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:8px;box-shadow:var(--sf-shadow);padding:18px}
      .sf-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
      .sf-modal-title{margin:0;color:var(--sf-text);font-size:18px;line-height:1.25}
      .sf-kicker{margin:0 0 4px;color:var(--sf-muted);text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:800}
      .sf-modal-close{border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:7px 10px;font-weight:800;cursor:pointer}
      .sf-modal-close:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-modal-meta{display:inline-block;margin:0 0 12px;color:var(--sf-muted);font-size:12px}
    `;
    document.head.appendChild(style);
  }

  formatInt(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number).toLocaleString() : "NA";
  }

  formatMetric(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "NA";
  }

  formatFlow(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "NA";
    if (Math.abs(number) >= 100) return number.toFixed(0);
    if (Math.abs(number) >= 10) return number.toFixed(1);
    return number.toFixed(3);
  }

  escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
  }
};
