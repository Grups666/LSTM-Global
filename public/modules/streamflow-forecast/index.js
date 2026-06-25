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
    this.data = await this.fetchJson(this.resolve(dataset?.file || "./data/dashboard-data.json"));
    this.basins = (this.data.basins || [])
      .filter((basin) => Number.isFinite(Number(basin.lon)) && Number.isFinite(Number(basin.lat)))
      .map((basin) => ({
        ...basin,
        id: String(basin.id),
        lon: Number(basin.lon),
        lat: Number(basin.lat)
      }));
    this.byId = new Map(this.basins.map((basin) => [basin.id, basin]));
    this.addLayer();
    this.ensureStyles();
    this.ensureLegend();
    this.showOverview();
    Foundation.eventBus.on(Foundation.Events.FEATURE_CLICK, this.handleFeatureClick);
    this.app.draw?.();
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
        const radius = selected ? 6.8 : hovered ? 5.6 : 3.9;
        ctx.globalAlpha = selected ? 0.98 : basin.status === "prediction_only" ? 0.72 : 0.84;
        ctx.fillStyle = this.skillColor(this.metricValue(basin, "nse"));
        ctx.strokeStyle = selected ? "#0f172a" : hovered ? "#1d4ed8" : "rgba(15,23,42,0.34)";
        ctx.lineWidth = selected ? 2.2 : hovered ? 1.8 : 0.7;

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
    const content = `
      <div class="sf-overview">
        <div class="sf-lead-row">${this.renderLeadButtons()}</div>
        <div class="sf-card-grid">
          ${this.metricCard("Basins", this.formatInt(meta.basinCount || this.basins.length))}
          ${this.metricCard("Fine-tuned", this.formatInt(meta.fineTunedValidatedBasinCount ?? meta.recentValidatedBasinCount))}
          ${this.metricCard("Latest run", this.formatInt(meta.latestStateForecastBasinCount))}
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
    this.bindLeadButtons(null);
  }

  showInspector(basin) {
    const metrics = this.metricsForLead(basin);
    const latest = this.latestForLead(basin);
    const content = `
      <div class="sf-basin-panel">
        <div class="sf-lead-row">${this.renderLeadButtons()}</div>
        ${this.statusBanner(basin)}
        <div class="sf-card-grid">
          ${this.metricCard("NSE", this.formatMetric(metrics?.nse, 3))}
          ${this.metricCard("KGE", this.formatMetric(metrics?.kge, 3))}
          ${this.metricCard("RMSE", this.formatMetric(metrics?.rmse, 3))}
          ${this.metricCard("Pairs", this.formatInt(metrics?.n))}
          ${this.metricCard("Latest P50", this.formatFlow(latest?.p50))}
          ${this.metricCard("P05-P95", `${this.formatFlow(latest?.p05)} - ${this.formatFlow(latest?.p95)}`)}
        </div>
        <div class="sf-meta-line">
          <span>${this.escape(basin.country || "unknown")}</span>
          <span>${this.escape(basin.station_id || basin.id)}</span>
          <span>Valid ${this.escape(this.validDate(latest, this.selectedLead))}</span>
        </div>
        <button class="sf-open-chart" type="button" data-sf-open-chart="${this.escape(basin.id)}">Open hydrograph</button>
        <div class="sf-chart-preview" data-sf-open-chart="${this.escape(basin.id)}">
          ${this.renderChartSvg(basin, this.selectedLead, 300, 160)}
        </div>
      </div>
    `;
    this.app.showInspector?.(this.basinTitle(basin), content);
    this.bindLeadButtons(basin);
    this.bindChartOpeners();
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

  bindChartOpeners() {
    document.querySelectorAll("[data-sf-open-chart]").forEach((button) => {
      button.addEventListener("click", () => {
        const basin = this.byId.get(String(button.dataset.sfOpenChart));
        if (basin) this.openChartModal(basin);
      });
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
          <div class="sf-symbol-row"><span class="sf-dot-symbol"></span>Fine-tuned <span class="sf-diamond-symbol"></span>Label only <span class="sf-triangle-symbol"></span>Prediction only</div>
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
      ${this.renderChartSvg(basin, this.selectedLead, 760, 360)}
    `;
    this.bindLeadButtons(basin);
  }

  closeChartModal() {
    this.chartModal?.classList.remove("visible");
    this.activeModalBasin = null;
  }

  renderChartSvg(basin, lead, width, height) {
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
    const firstDate = dates[0] || "";
    const lastDate = dates[dates.length - 1] || "";

    return `
      <svg class="sf-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Streamflow forecast hydrograph">
        <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#f8fafc"></rect>
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="#cbd5e1"></line>
        <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#cbd5e1"></line>
        <text x="${margin.left}" y="${height - 10}" fill="#64748b" font-size="10">${this.escape(firstDate)}</text>
        <text x="${width - margin.right}" y="${height - 10}" fill="#64748b" font-size="10" text-anchor="end">${this.escape(lastDate)}</text>
        <text x="${margin.left - 8}" y="${margin.top + 8}" fill="#64748b" font-size="10" text-anchor="end">${this.formatMetric(max, 2)}</text>
        <text x="${margin.left - 8}" y="${height - margin.bottom}" fill="#64748b" font-size="10" text-anchor="end">${this.formatMetric(min, 2)}</text>
        ${band ? `<polygon points="${band}" fill="rgba(14,165,233,0.18)" stroke="none"></polygon>` : ""}
        <polyline points="${polyline("p50")}" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></polyline>
        <polyline points="${polyline("obs")}" fill="none" stroke="#0f172a" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round"></polyline>
      </svg>
    `;
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
      .sf-lead-row{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
      .sf-lead{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:6px;padding:6px 9px;font-size:12px;font-weight:700;cursor:pointer}
      .sf-lead.active{background:#0f172a;border-color:#0f172a;color:#fff}
      .sf-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0 0 14px}
      .sf-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:9px}
      .sf-card-value{font-size:16px;font-weight:800;color:#0f172a;line-height:1.2;overflow-wrap:anywhere}
      .sf-card-label{font-size:11px;color:#64748b;margin-top:3px}
      .sf-meta-line{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px;color:#64748b;font-size:11px}
      .sf-meta-line span,.sf-modal-meta{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:4px 8px}
      .sf-table{width:100%;border-collapse:collapse;font-size:11px}
      .sf-table th,.sf-table td{padding:6px;border-bottom:1px solid #e2e8f0;text-align:right}
      .sf-table th:first-child,.sf-table td:first-child{text-align:left}
      .sf-status{display:flex;justify-content:space-between;gap:8px;border-radius:6px;padding:9px 10px;margin:0 0 12px;font-size:12px}
      .sf-status.validated{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
      .sf-status.label{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
      .sf-status.prediction{background:#f8fafc;color:#475569;border:1px solid #cbd5e1}
      .sf-open-chart{width:100%;height:34px;border:1px solid #0f172a;background:#0f172a;color:#fff;border-radius:6px;font-size:12px;font-weight:800;cursor:pointer;margin:2px 0 10px}
      .sf-chart-preview{cursor:pointer}
      .sf-chart{width:100%;height:auto;display:block;border:1px solid #e2e8f0;border-radius:8px}
      .sf-empty-chart{height:138px;display:grid;place-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;text-align:center;color:#64748b}
      .sf-empty-chart div{font-size:24px;font-weight:800;color:#0f172a}
      .sf-legend{font-size:11px;color:#475569}
      .sf-gradient{height:9px;border-radius:999px;background:linear-gradient(90deg,#7c3aed,#2563eb,#0ea5e9,#10b981,#f59e0b);margin:6px 0}
      .sf-legend-ticks,.sf-symbol-row{display:flex;justify-content:space-between;gap:6px}
      .sf-symbol-row{align-items:center;margin-top:6px}
      .sf-dot-symbol{width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block}
      .sf-diamond-symbol{width:8px;height:8px;background:#60a5fa;display:inline-block;transform:rotate(45deg)}
      .sf-triangle-symbol{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid #94a3b8;display:inline-block}
      .sf-modal{position:fixed;inset:0;background:rgba(15,23,42,.58);z-index:5000;display:none;align-items:center;justify-content:center;padding:24px}
      .sf-modal.visible{display:flex}
      .sf-modal-card{width:min(900px,96vw);max-height:92vh;overflow:auto;background:#fff;border-radius:8px;box-shadow:0 24px 80px rgba(15,23,42,.35);padding:18px}
      .sf-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
      .sf-modal-title{margin:0;color:#0f172a;font-size:18px;line-height:1.25}
      .sf-kicker{margin:0 0 4px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:800}
      .sf-modal-close{border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:6px;padding:7px 10px;font-weight:800;cursor:pointer}
      .sf-modal-meta{display:inline-block;margin:0 0 12px;color:#64748b;font-size:12px}
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
