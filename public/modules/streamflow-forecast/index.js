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
    this.overviewLayerId = `${this.layerId}-validation-overview`;
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
    this.historyIndex = null;
    this.historyIndexPromise = null;
    this.historyShardCache = new Map();
    this.historyShardPromises = new Map();
    this.historyByBasin = new Map();
    this.historyLoadingBasins = new Set();
    this.historyFailedBasins = new Set();
    this.historyRefreshRequests = new Map();
    this.historyVersionToken = null;
    this.obsSummary = null;
    this.obsBasinMeta = new Map();
    this.obsIndex = null;
    this.obsIndexPromise = null;
    this.obsShardCache = new Map();
    this.obsShardPromises = new Map();
    this.obsByBasin = new Map();
    this.obsLoadingBasins = new Set();
    this.obsFailedBasins = new Set();
    this.obsRefreshRequests = new Map();
    this.overviewModal = null;
    this.accuracyFilter = {
      metric: "nse",
      minNse: -Infinity,
      lead: "all",
      observedOnly: false
    };
    this.handleFeatureClick = (payload) => {
      if (payload.layer?.id !== this.layerId || payload.layer?.moduleId !== this.manifest.id) return;
      this.selected = payload.feature;
      this.showInspector(payload.feature);
      this.app.draw?.();
    };
    this.handleLayerToggle = (payload) => {
      if (payload.layerId !== this.overviewLayerId) return;
      if (payload.visible) this.showOverview();
      else this.closeOverview();
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
    try {
      this.obsSummary = await this.fetchJson(this.resolve("./api/observations/latest.json"), { cache: "no-cache" });
      const obsBasins = await this.fetchJson(this.resolve("./api/observations/basins.json"), { cache: "no-cache" });
      this.obsBasinMeta = new Map((obsBasins.basins || []).map((basin) => [String(basin.id), basin]));
    } catch (error) {
      console.warn("Observed streamflow validation API unavailable", error);
    }
    this.setDataPayload(this.datasetsByMode.get(this.datasetMode).data);
    this.addLayer();
    this.ensureStyles();
    this.ensureLegend();
    this.showOverview();
    Foundation.eventBus.on(Foundation.Events.FEATURE_CLICK, this.handleFeatureClick);
    Foundation.eventBus.on(Foundation.Events.LAYER_TOGGLE, this.handleLayerToggle);
    this.app.draw?.();
  }

  setDataPayload(data) {
    this.data = data;
    const nextHistoryVersion = this.data?.meta?.latestIssueDate || this.data?.meta?.generatedAt || "current";
    if (this.historyVersionToken && this.historyVersionToken !== nextHistoryVersion) {
      this.historyIndex = null;
      this.historyIndexPromise = null;
      this.historyShardCache.clear();
      this.historyShardPromises.clear();
      this.historyByBasin.clear();
      this.historyLoadingBasins.clear();
      this.historyFailedBasins.clear();
      this.historyRefreshRequests.clear();
    }
    this.historyVersionToken = nextHistoryVersion;
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
    this.app.layerManager.removeLayer(this.overviewLayerId);
    this.app.unregisterLegend?.(this.legendId);
    Foundation.eventBus.off(Foundation.Events.FEATURE_CLICK, this.handleFeatureClick);
    Foundation.eventBus.off(Foundation.Events.LAYER_TOGGLE, this.handleLayerToggle);
    this.closeChartModal();
    this.destroyOverviewModal();
    this.selected = null;
  }

  getLayerIds() {
    return [this.layerId, this.overviewLayerId];
  }

  resolve(path) {
    if (/^https?:\/\//i.test(path) || path.startsWith("/")) return path;
    return this.basePath + path.replace(/^\.\//, "");
  }

  async fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    return response.json();
  }

  historyResolve(path) {
    const url = this.resolve(path);
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}v=${encodeURIComponent(this.historyVersionToken || "current")}`;
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
    this.app.layerManager.addLayer({
      id: this.overviewLayerId,
      name: "Overview",
      type: "overlay",
      visible: false,
      interactive: false,
      moduleId: this.manifest.id,
      metadata: { removable: false },
      renderer: () => {}
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
        if (!this.passesAccuracyFilter(basin)) continue;
        const x = width / 2 + (basin.lon + lonOffset) * base + offsetX;
        const y = height / 2 - basin.lat * base + offsetY;
        if (x < -18 || x > width + 18 || y < -18 || y > height + 18) continue;

        const selected = this.selected?.id === basin.id;
        const hovered = this.app.hoveredLayer?.id === this.layerId && this.app.hoveredFeatureId === basin.id;
        const targetedAdapter = Boolean(basin.targetedAdapterCandidate);
        const radius = selected ? 6.8 : hovered ? 5.6 : 3.9;
        ctx.globalAlpha = selected ? 0.98 : basin.status === "prediction_only" ? 0.72 : 0.84;
        ctx.fillStyle = this.skillColor(this.metricValue(basin, "nse"));
        ctx.strokeStyle = targetedAdapter ? "#a855f7" : selected ? "#0f172a" : hovered ? "#1d4ed8" : "rgba(15,23,42,0.30)";
        ctx.lineWidth = targetedAdapter ? (selected || hovered ? 2.4 : 1.5) : selected ? 2.2 : hovered ? 1.8 : 0.7;

        if (basin.status === "supervised_label_available") {
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
      if (!this.passesAccuracyFilter(basin)) continue;
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
    const obs = this.obsSummary || {};
    const obsMetrics = obs.metrics || {};
    const candidate = obs.candidateMetrics || {};
    const layer = this.app.layerManager.getLayer?.(this.overviewLayerId);
    if (layer && !layer.visible) return;
    this.ensureOverviewModal();
    this.overviewModal.querySelector(".sf-overview-body").innerHTML = `
      <section>
        <p class="sf-overview-lead">
          ${this.escape(this.overviewText())}
        </p>
        ${this.renderAccuracyFilterControls()}
        <div class="sf-overview-metrics">
          ${this.metricCard("Forecast basins", this.formatInt(meta.basinCount || this.basins.length))}
          ${this.metricCard("Obs matched", this.formatInt(obs.strictMatchedRecentBasins))}
          ${this.metricCard("Validation rows", this.formatInt(obs.validationRows))}
          ${this.metricCard("Overall NSE", this.formatMetric(obsMetrics.nse, 3))}
          ${this.metricCard("Overall KGE", this.formatMetric(obsMetrics.kge, 3))}
          ${this.metricCard("MAE mm/day", this.formatFlow(obsMetrics.mae_mm_day))}
          ${this.metricCard("Eval basins", this.formatInt(candidate.basinCount))}
          ${this.metricCard("L1-2 median NSE", this.formatMetric(candidate.lead12MedianNse, 3))}
          ${this.metricCard("L1-2 NSE >= 0.4", this.formatInt(candidate.lead12NseGt04))}
          ${this.metricCard("L1-2 NSE >= 0.5", this.formatInt(candidate.lead12NseGt05))}
        </div>
        ${this.renderObservationLeadSummary(obs.byLead || [])}
        ${this.renderCandidateLeadSummary(candidate)}
      </section>
      <section>
        <h3>Validation contract</h3>
        <p>
          Observed streamflow is used only for verification. A basin enters this overview only when the public gauge id, station metadata, station name, coordinates, and recent daily observations pass strict correspondence checks.
        </p>
        <p>
          Current public observations come from USGS daily mean discharge and cover ${this.escape(obs.startDate || "pending")} to ${this.escape(obs.endDate || "pending")}. Forecast inputs remain GFS forcing, static basin attributes, and product availability masks.
        </p>
      </section>
      <section>
        <h3>Forecast product</h3>
        <p>
          Issue ${this.escape(meta.latestIssueDate || "pending")} contains ${this.formatInt(meta.rowCount)} lead-wise P05/P50/P95 rows. The table below is the original forecast summary; the table above is the observed-streamflow validation summary.
        </p>
        ${this.renderLeadSummary(summary)}
      </section>
    `;
    this.bindAccuracyFilterControls();
    this.overviewModal.classList.add("visible");
  }

  showInspector(basin) {
    this.requestHistoryForBasin(basin, { refreshInspector: true, prefetchNeighbors: true });
    this.requestObsForBasin(basin, { refreshInspector: true });
    const metrics = this.metricsForLead(basin);
    const latest = this.latestForLead(basin);
    const historyState = this.historyState(basin.id);
    const obsState = this.obsState(basin.id);
    const obsMetrics = this.obsMetricsForLead(basin, this.selectedLead);
    const candidateMetrics = this.candidateMetricsForLead(basin, this.selectedLead);
    const content = `
      <div class="sf-basin-panel">
        ${this.renderModeButtons()}
        <div class="sf-lead-row">${this.renderLeadButtons()}</div>
        ${this.statusBanner(basin)}
        <div class="sf-card-grid">
          ${this.metricCard("Obs NSE", this.formatMetric(obsMetrics?.nse, 3))}
          ${this.metricCard("Obs KGE", this.formatMetric(obsMetrics?.kge, 3))}
          ${this.metricCard("Obs MAE", this.formatFlow(obsMetrics?.mae))}
          ${this.metricCard("Obs pairs", this.formatInt(obsMetrics?.n))}
          ${this.metricCard("Posttrain NSE", this.formatMetric(candidateMetrics?.nse, 3))}
          ${this.metricCard("Posttrain KGE", this.formatMetric(candidateMetrics?.kge, 3))}
          ${this.metricCard("Skill class", this.skillClassLabel(candidateMetrics?.skillClass))}
          ${this.metricCard("Latest P50", this.formatFlow(latest?.p50))}
          ${this.metricCard("P05-P95", `${this.formatFlow(latest?.p05)} - ${this.formatFlow(latest?.p95)}`)}
          ${this.metricCard("Primary input", "GFS forecast")}
          ${this.metricCard("Input horizon", "1-7 days")}
          ${this.metricCard("Product masks", this.formatInt(latest?.missingProductCount))}
        </div>
        ${this.renderInputNote(latest)}
        <div class="sf-meta-line">
          <span>${this.escape(basin.country || "unknown")}</span>
          <span>${this.escape(basin.station_id || basin.id)}</span>
          <span>Valid ${this.escape(this.validDate(latest, this.selectedLead))}</span>
          <span>${this.escape(obsState.label)}</span>
        </div>
        <div class="sf-chart-preview ${historyState.className}" data-sf-open-chart="${this.escape(basin.id)}" role="button" tabindex="0" aria-label="Open basin hydrograph">
          ${this.renderChartSvg(basin, this.selectedLead, 300, 160, { interactive: false, legend: false })}
          ${historyState.overlay || obsState.overlay}
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

  renderOverviewNote() {
    const matched = this.formatInt(this.obsSummary?.strictMatchedRecentBasins);
    const total = this.formatInt(this.obsSummary?.totalForecastBasins);
    const visibleObs = this.formatInt(this.filteredObservedBasinCount());
    const range = this.obsSummary?.startDate && this.obsSummary?.endDate
      ? `${this.obsSummary.startDate} to ${this.obsSummary.endDate}`
      : "latest 30-day window";
    return `
      <div class="sf-overview-note">
        <div class="sf-overview-note-title">Observed validation overview</div>
        <span>${matched} of ${total} forecast basins have strict public observed-streamflow matches for ${this.escape(range)}.</span>
        <span>${visibleObs} strict observed matches are visible under the current reliability filter. Observations are validation-only and never feed inference.</span>
      </div>
    `;
  }

  renderAccuracyFilterControls() {
    const count = this.filteredBasinCount();
    const observedCount = this.filteredObservedBasinCount();
    const leadOptions = ["all", "1", "2", "3", "4", "5", "6", "7"].map((lead) => {
      const selected = String(this.accuracyFilter.lead) === lead ? "selected" : "";
      return `<option value="${lead}" ${selected}>${lead === "all" ? "All leads" : `Lead ${lead}`}</option>`;
    }).join("");
    const threshold = Number.isFinite(Number(this.accuracyFilter.minNse)) ? Number(this.accuracyFilter.minNse) : -1;
    return `
      <div class="sf-filter-panel">
        <div class="sf-filter-title">Reliability filter</div>
        <div class="sf-filter-grid">
          <label class="sf-filter-field">
            <span>Metric</span>
            <select data-sf-filter-metric aria-label="Reliability metric">
              <option value="nse"${this.accuracyFilter.metric === "nse" ? " selected" : ""}>NSE</option>
              <option value="kge"${this.accuracyFilter.metric === "kge" ? " selected" : ""}>KGE</option>
            </select>
          </label>
          <label class="sf-filter-field">
            <span>Lead</span>
            <select data-sf-filter-lead aria-label="Validation lead">${leadOptions}</select>
          </label>
          <label class="sf-filter-field">
            <span>Minimum</span>
            <input data-sf-filter-threshold type="number" min="-1" max="1" step="0.05" value="${this.formatMetric(threshold, 2)}" aria-label="Minimum reliability threshold">
          </label>
          <label class="sf-filter-field sf-filter-slider">
            <span>Threshold</span>
            <input data-sf-filter-range type="range" min="-1" max="1" step="0.05" value="${this.formatMetric(threshold, 2)}" aria-label="Minimum reliability threshold slider">
          </label>
        </div>
        <label class="sf-filter-check"><input type="checkbox" data-sf-observed-only ${this.accuracyFilter.observedOnly ? "checked" : ""}> Show strict observed matches only</label>
        <div class="sf-filter-count">${this.formatInt(count)} forecast basins visible; ${this.formatInt(observedCount)} strict observed matches included under the current reliability filter</div>
      </div>
    `;
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

  overviewText() {
    const obs = this.obsSummary || {};
    const matched = this.formatInt(obs.strictMatchedRecentBasins);
    const total = this.formatInt(obs.totalForecastBasins);
    const range = obs.startDate && obs.endDate ? `${obs.startDate} to ${obs.endDate}` : "the latest 30-day window";
    return `${matched} of ${total} forecast basins have strict public observed-streamflow matches for ${range}. Use the reliability filter to focus the map on basins whose recent validation skill meets the selected metric threshold.`;
  }

  ensureOverviewModal() {
    if (this.overviewModal) return;
    this.overviewModal = document.createElement("div");
    this.overviewModal.className = "sf-overview-modal";
    this.overviewModal.innerHTML = `
      <div class="sf-overview-dialog" role="dialog" aria-label="Streamflow forecast overview">
        <div class="sf-overview-header">
          <div>
            <div class="sf-overview-title">Overview</div>
            <div class="sf-overview-subtitle">Observed validation and reliability filter</div>
          </div>
          <button class="sf-overview-close" type="button" aria-label="Close"></button>
        </div>
        <div class="sf-overview-body"></div>
      </div>
    `;
    this.overviewModal.querySelector(".sf-overview-close").onclick = () => {
      this.app.layerManager.setVisibility(this.overviewLayerId, false);
      this.closeOverview();
      this.app.updateLayerList?.();
    };
    document.body.appendChild(this.overviewModal);
  }

  closeOverview() {
    this.overviewModal?.classList.remove("visible");
  }

  destroyOverviewModal() {
    this.overviewModal?.remove();
    this.overviewModal = null;
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

  bindAccuracyFilterControls() {
    const root = this.overviewModal?.querySelector(".sf-filter-panel") || document;
    const applyThreshold = (value) => {
      const threshold = Number(value);
      this.accuracyFilter.minNse = Number.isFinite(threshold) ? threshold : -Infinity;
      this.showOverview();
      this.app.draw?.();
    };
    root.querySelectorAll("[data-sf-filter-metric]").forEach((select) => {
      select.addEventListener("change", () => {
        this.accuracyFilter.metric = select.value === "kge" ? "kge" : "nse";
        this.showOverview();
        this.app.draw?.();
      });
    });
    root.querySelectorAll("[data-sf-filter-lead]").forEach((select) => {
      select.addEventListener("change", () => {
        this.accuracyFilter.lead = select.value || "all";
        this.showOverview();
        this.app.draw?.();
      });
    });
    root.querySelectorAll("[data-sf-filter-threshold]").forEach((input) => {
      input.addEventListener("change", () => applyThreshold(input.value));
    });
    root.querySelectorAll("[data-sf-filter-range]").forEach((input) => {
      input.addEventListener("input", () => applyThreshold(input.value));
    });
    root.querySelectorAll("[data-sf-observed-only]").forEach((input) => {
      input.addEventListener("change", () => {
        this.accuracyFilter.observedOnly = Boolean(input.checked);
        this.showOverview();
        this.app.draw?.();
      });
    });
  }

  renderObservationLeadSummary(summary) {
    if (!summary.length) return "";
    const rows = summary.map((item) => `
      <tr>
        <td>L${this.escape(item.lead_time)}</td>
        <td>${this.formatInt(item.n)}</td>
        <td>${this.formatMetric(item.nse, 3)}</td>
        <td>${this.formatMetric(item.kge, 3)}</td>
        <td>${this.formatFlow(item.mae_mm_day)}</td>
        <td>${this.formatMetric(Number(item.p05_p95_coverage) * 100, 1)}%</td>
      </tr>
    `).join("");
    return `
      <table class="sf-table sf-obs-table">
        <thead><tr><th>Obs lead</th><th>Pairs</th><th>NSE</th><th>KGE</th><th>MAE</th><th>P05-P95</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  renderCandidateLeadSummary(candidate) {
    const summary = Array.isArray(candidate?.byLead) ? candidate.byLead : [];
    if (!summary.length) return "";
    const rows = summary.slice(0, 7).map((item) => `
      <tr>
        <td>L${this.escape(item.leadTime)}</td>
        <td>${this.formatInt(item.basins)}</td>
        <td>${this.formatMetric(item.medianNse, 3)}</td>
        <td>${this.formatInt(item.nseGt0)}</td>
        <td>${this.formatInt(item.nseGt04)}</td>
        <td>${this.formatInt(item.nseGt05)}</td>
      </tr>
    `).join("");
    return `
      <table class="sf-table sf-obs-table">
        <thead><tr><th>Posttrain lead</th><th>Basins</th><th>Median NSE</th><th>NSE &gt; 0</th><th>NSE &gt; 0.4</th><th>NSE &gt; 0.5</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  statusBanner(basin) {
    const hasObs = this.obsByBasin.has(basin.id);
    const label = hasObs ? "Strict observed streamflow match" : "OpenHydroNet forecast";
    const cls = hasObs ? "validated" : "prediction";
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

  obsMetricsForLead(basin, lead) {
    const rows = this.obsByBasin.get(basin.id)?.validation?.[String(lead)] || [];
    if (!rows.length) return null;
    const obs = [];
    const pred = [];
    for (const row of rows) {
      const observed = Number(row[5]);
      const forecast = Number(row[3]);
      if (Number.isFinite(observed) && Number.isFinite(forecast)) {
        obs.push(observed);
        pred.push(forecast);
      }
    }
    if (!obs.length) return null;
    const n = obs.length;
    const meanObs = obs.reduce((sum, value) => sum + value, 0) / n;
    const meanPred = pred.reduce((sum, value) => sum + value, 0) / n;
    const errors = pred.map((value, index) => value - obs[index]);
    const denominator = obs.reduce((sum, value) => sum + (value - meanObs) ** 2, 0);
    const nse = denominator > 0 ? 1 - errors.reduce((sum, value) => sum + value ** 2, 0) / denominator : NaN;
    const r = this.correlation(pred, obs);
    const stdPred = this.stddev(pred);
    const stdObs = this.stddev(obs);
    const alpha = stdObs > 0 ? stdPred / stdObs : NaN;
    const beta = meanObs !== 0 ? meanPred / meanObs : NaN;
    const kge = [r, alpha, beta].every(Number.isFinite) ? 1 - Math.hypot(r - 1, alpha - 1, beta - 1) : NaN;
    return {
      n,
      mae: errors.reduce((sum, value) => sum + Math.abs(value), 0) / n,
      nse,
      kge
    };
  }

  candidateMetricsForLead(basin, lead) {
    const meta = this.obsBasinMeta.get(String(basin.id));
    const candidate = meta?.candidateMetrics;
    if (!candidate) return null;
    const byLead = candidate.byLead?.[String(lead)] || meta.candidateByLead?.[String(lead)] || {};
    return {
      ...byLead,
      lead12MeanNse: candidate.lead12MeanNse,
      skillClass: candidate.skillClass
    };
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

  effectivenessLabel(basin) {
    const status = String(basin.effectivenessStatus || "unknown");
    const labels = {
      priority_effective: "Priority effective",
      proven_effective: "Proven effective",
      adapter_candidate: "Adapter candidate",
      unproven: "Unproven",
      insufficient_data: "Insufficient data",
      unknown: "Unknown"
    };
    return labels[status] || status.replaceAll("_", " ");
  }

  bestRouteLabel(basin) {
    const route = String(basin.bestEffectivenessCandidate || "");
    if (!route) return "No probe";
    return route.replaceAll("_", " ");
  }

  metricValue(basin, key) {
    const value = basin.metrics?.[String(this.selectedLead)]?.[key];
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  filterMetricValue(basinId) {
    const meta = this.obsBasinMeta.get(String(basinId));
    if (!meta) return NaN;
    const metric = this.accuracyFilter.metric === "kge" ? "kge" : "nse";
    const lead = String(this.accuracyFilter.lead);
    if (lead === "all") {
      const candidateValue = metric === "nse" ? Number(meta.candidateMetrics?.lead12MeanNse) : NaN;
      return Number.isFinite(candidateValue) ? candidateValue : Number(meta[metric]);
    }
    const candidateValue = Number(meta.candidateMetrics?.byLead?.[lead]?.[metric] ?? meta.candidateByLead?.[lead]?.[metric]);
    if (Number.isFinite(candidateValue)) return candidateValue;
    return Number(meta.byLead?.[lead]?.[metric]);
  }

  skillClassLabel(skillClass) {
    const labels = {
      strong_ge_0_5: ">= 0.5",
      usable_ge_0_4: "0.4-0.5",
      positive_but_below_0_4: "0-0.4",
      low_negative_ge_minus_0_5: "-0.5-0",
      poor_lt_minus_0_5: "< -0.5",
      nse_missing_or_constant_obs: "No NSE"
    };
    return labels[String(skillClass || "")] || "Pending";
  }

  passesAccuracyFilter(basin) {
    if (!basin?.id) return false;
    const hasObs = this.obsBasinMeta.has(basin.id);
    if (this.accuracyFilter.observedOnly && !hasObs) return false;
    const minNse = Number(this.accuracyFilter.minNse);
    if (!Number.isFinite(minNse)) return true;
    const nse = this.filterMetricValue(basin.id);
    return Number.isFinite(nse) && nse > minNse;
  }

  filteredBasinCount() {
    return this.basins.reduce((count, basin) => count + (this.passesAccuracyFilter(basin) ? 1 : 0), 0);
  }

  filteredObservedBasinCount() {
    return this.basins.reduce((count, basin) => {
      const hasObs = this.obsBasinMeta.has(String(basin.id));
      return count + (hasObs && this.passesAccuracyFilter(basin) ? 1 : 0);
    }, 0);
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
          <div class="sf-symbol-row"><span class="sf-dot-symbol"></span>OpenHydroNet basin forecast</div>
          <div class="sf-legend-note">Input product availability is encoded with masks for each forecast row.</div>
        </div>
      `
    });
  }

  openChartModal(basin) {
    this.activeModalBasin = basin;
    this.ensureChartModal();
    this.renderChartModal(basin);
    this.chartModal.classList.add("visible");
    this.requestHistoryForBasin(basin, { refreshModal: true, prefetchNeighbors: true });
    this.requestObsForBasin(basin, { refreshModal: true });
  }

  renderInputNote(latest) {
    const missing = Number(latest?.missingProductCount);
    const missingText = Number.isFinite(missing) && missing > 0
      ? `${missing} optional product groups are recorded in the availability mask.`
      : "All configured product groups are available for this row.";
    return `
      <div class="sf-input-note">
        <strong>Input</strong>
        <span>Forecasts use GFS 1-7 day meteorological forcing and static basin attributes. ${this.escape(missingText)}</span>
      </div>
    `;
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
          <button class="sf-modal-close" type="button" aria-label="Close"><span aria-hidden="true"></span></button>
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
    const historyState = this.historyState(basin.id);
    this.chartModal.querySelector(".sf-modal-title").textContent = this.basinTitle(basin);
    this.chartModal.querySelector(".sf-modal-body").innerHTML = `
      <div class="sf-lead-row">${this.renderLeadButtons()}</div>
      <div class="sf-modal-meta">${this.escape(basin.id)} / ${this.escape(basin.country || "unknown")} / lead ${this.selectedLead} / ${historyState.label}</div>
      <div class="sf-modal-chart-wrap ${historyState.className}">
        ${this.renderChartSvg(basin, this.selectedLead, 760, 360, { interactive: true, legend: true })}
        ${historyState.overlay}
      </div>
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
    const series = this.seriesForLead(basin, lead);
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
    const series = basin ? this.seriesForLead(basin, lead) : null;
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

  correlation(xs, ys) {
    if (xs.length < 2 || xs.length !== ys.length) return NaN;
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const varX = xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
    const varY = ys.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
    if (varX <= 0 || varY <= 0) return NaN;
    const cov = xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index] - meanY), 0);
    return cov / Math.sqrt(varX * varY);
  }

  stddev(values) {
    if (!values.length) return NaN;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
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

  seriesForLead(basin, lead) {
    const obsRows = this.obsByBasin.get(basin.id)?.validation?.[String(lead)] || [];
    const obsByDate = new Map(obsRows.map((row) => [row[1], row[5]]));
    const history = this.historyByBasin.get(basin.id)?.[String(lead)];
    if (history?.valid_date?.length) {
      return {
        ...history,
        obs: history.valid_date.map((date) => obsByDate.has(date) ? obsByDate.get(date) : null)
      };
    }
    if (obsRows.length) {
      return {
        valid_date: obsRows.map((row) => row[1]),
        p05: obsRows.map((row) => row[2]),
        p50: obsRows.map((row) => row[3]),
        p95: obsRows.map((row) => row[4]),
        obs: obsRows.map((row) => row[5])
      };
    }
    const existing = this.data.series?.[basin.id]?.[String(lead)];
    if (existing?.valid_date?.length) return existing;
    const latest = basin.latestForecast?.[String(lead)];
    if (!latest) return null;
    return {
      valid_date: [this.validDate(latest, lead)],
      p05: [latest.p05],
      p50: [latest.p50],
      p95: [latest.p95],
      obs: [null]
    };
  }

  async ensureHistoryIndex() {
    if (this.historyIndex) return this.historyIndex;
    if (!this.historyIndexPromise) {
      this.historyIndexPromise = this.fetchJson(this.historyResolve("./api/history/index.json"))
        .then((payload) => {
          this.historyIndex = payload;
          return payload;
        });
    }
    return this.historyIndexPromise;
  }

  historyState(basinId) {
    if (this.historyByBasin.has(basinId)) {
      return { className: "is-history-ready", label: "rolling 30-day history", overlay: "" };
    }
    if (this.historyLoadingBasins.has(basinId)) {
      return {
        className: "is-history-loading",
        label: "loading rolling 30-day history",
        overlay: `<div class="sf-history-overlay" aria-live="polite">Loading 30-day curve</div>`
      };
    }
    if (this.historyFailedBasins.has(basinId)) {
      return { className: "is-history-failed", label: "latest issue", overlay: "" };
    }
    return { className: "is-history-pending", label: "latest issue", overlay: "" };
  }

  requestHistoryForBasin(basin, options = {}) {
    if (!basin?.id || this.historyByBasin.has(basin.id) || this.historyFailedBasins.has(basin.id)) return;
    const basinId = basin.id;
    const existing = this.historyRefreshRequests.get(basinId) || {};
    this.historyRefreshRequests.set(basinId, {
      refreshInspector: Boolean(existing.refreshInspector || options.refreshInspector),
      refreshModal: Boolean(existing.refreshModal || options.refreshModal),
      prefetchNeighbors: Boolean(existing.prefetchNeighbors || options.prefetchNeighbors)
    });
    if (this.historyLoadingBasins.has(basinId)) return;
    this.historyLoadingBasins.add(basinId);
    this.loadHistoryForBasin(basinId)
      .then((loaded) => {
        if (!loaded) this.historyFailedBasins.add(basinId);
        const refreshOptions = this.historyRefreshRequests.get(basinId) || {};
        if (loaded && refreshOptions.prefetchNeighbors) this.prefetchNeighborHistoryShards(basinId);
      })
      .catch((error) => {
        this.historyFailedBasins.add(basinId);
        console.warn("OpenHydroNet history unavailable", error);
      })
      .finally(() => {
        const refreshOptions = this.historyRefreshRequests.get(basinId) || {};
        this.historyRefreshRequests.delete(basinId);
        this.historyLoadingBasins.delete(basinId);
        if (refreshOptions.refreshInspector && this.selected?.id === basinId) this.showInspector(this.selected);
        if (refreshOptions.refreshModal && this.activeModalBasin?.id === basinId) this.renderChartModal(this.activeModalBasin);
      });
  }

  async loadHistoryForBasin(basinId) {
    if (this.historyByBasin.has(basinId)) return true;
    const index = await this.ensureHistoryIndex();
    const shardFile = index.basinShard?.[basinId];
    if (!shardFile) return false;
    await this.loadHistoryShard(shardFile);
    return this.historyByBasin.has(basinId);
  }

  async loadHistoryShard(shardFile) {
    if (this.historyShardCache.has(shardFile)) return this.historyShardCache.get(shardFile);
    if (!this.historyShardPromises.has(shardFile)) {
      const promise = this.fetchJson(this.historyResolve(`./api/history/${shardFile}`))
        .then((shard) => {
          this.historyShardCache.set(shardFile, shard);
          for (const [id, leads] of Object.entries(shard.basins || {})) {
            this.historyByBasin.set(id, this.convertHistoryLeads(leads, shard.issueDates || []));
          }
          return shard;
        })
        .finally(() => {
          this.historyShardPromises.delete(shardFile);
        });
      this.historyShardPromises.set(shardFile, promise);
    }
    return this.historyShardPromises.get(shardFile);
  }

  async prefetchNeighborHistoryShards(basinId) {
    try {
      const index = await this.ensureHistoryIndex();
      const shardFile = index.basinShard?.[basinId];
      const shardFiles = Array.isArray(index.shardFiles) ? index.shardFiles : [];
      const shardIndex = shardFiles.indexOf(shardFile);
      if (shardIndex < 0) return;
      const neighbors = [shardFiles[shardIndex - 1], shardFiles[shardIndex + 1]].filter(Boolean);
      const schedule = window.requestIdleCallback || ((callback) => window.setTimeout(callback, 350));
      schedule(() => {
        neighbors.forEach((file) => {
          if (!this.historyShardCache.has(file) && !this.historyShardPromises.has(file)) {
            this.loadHistoryShard(file).catch(() => {});
          }
        });
      });
    } catch {
      // Best-effort prefetch only.
    }
  }

  convertHistoryLeads(leads, issueDates) {
    const converted = {};
    for (const [lead, rows] of Object.entries(leads || {})) {
      const leadNumber = Number(lead);
      const validDates = issueDates.map((issueDate) => this.validDate({ issue_date: issueDate }, leadNumber));
      converted[lead] = {
        valid_date: validDates,
        p05: rows.map((row) => Array.isArray(row) ? row[0] : null),
        p50: rows.map((row) => Array.isArray(row) ? row[1] : null),
        p95: rows.map((row) => Array.isArray(row) ? row[2] : null),
        obs: rows.map(() => null)
      };
    }
    return converted;
  }

  async ensureObsIndex() {
    if (this.obsIndex) return this.obsIndex;
    if (!this.obsIndexPromise) {
      this.obsIndexPromise = this.fetchJson(this.historyResolve("./api/observations/index.json"))
        .then((payload) => {
          this.obsIndex = payload;
          return payload;
        });
    }
    return this.obsIndexPromise;
  }

  obsState(basinId) {
    if (this.obsByBasin.has(basinId)) return { label: "obs loaded", overlay: "" };
    if (this.obsLoadingBasins.has(basinId)) {
      return { label: "loading obs", overlay: `<div class="sf-history-overlay" aria-live="polite">Loading observed streamflow</div>` };
    }
    if (this.obsFailedBasins.has(basinId)) return { label: "no strict obs match", overlay: "" };
    return { label: "obs pending", overlay: "" };
  }

  requestObsForBasin(basin, options = {}) {
    if (!basin?.id || this.obsByBasin.has(basin.id) || this.obsFailedBasins.has(basin.id)) return;
    const basinId = basin.id;
    const existing = this.obsRefreshRequests.get(basinId) || {};
    this.obsRefreshRequests.set(basinId, {
      refreshInspector: Boolean(existing.refreshInspector || options.refreshInspector),
      refreshModal: Boolean(existing.refreshModal || options.refreshModal)
    });
    if (this.obsLoadingBasins.has(basinId)) return;
    this.obsLoadingBasins.add(basinId);
    this.loadObsForBasin(basinId)
      .then((loaded) => {
        if (!loaded) this.obsFailedBasins.add(basinId);
      })
      .catch((error) => {
        this.obsFailedBasins.add(basinId);
        console.warn("Observed streamflow shard unavailable", error);
      })
      .finally(() => {
        const refreshOptions = this.obsRefreshRequests.get(basinId) || {};
        this.obsRefreshRequests.delete(basinId);
        this.obsLoadingBasins.delete(basinId);
        if (refreshOptions.refreshInspector && this.selected?.id === basinId) this.showInspector(this.selected);
        if (refreshOptions.refreshModal && this.activeModalBasin?.id === basinId) this.renderChartModal(this.activeModalBasin);
      });
  }

  async loadObsForBasin(basinId) {
    if (this.obsByBasin.has(basinId)) return true;
    const index = await this.ensureObsIndex();
    const shardFile = index.basinShard?.[basinId];
    if (!shardFile) return false;
    await this.loadObsShard(shardFile);
    return this.obsByBasin.has(basinId);
  }

  async loadObsShard(shardFile) {
    if (this.obsShardCache.has(shardFile)) return this.obsShardCache.get(shardFile);
    if (!this.obsShardPromises.has(shardFile)) {
      const promise = this.fetchJson(this.historyResolve(`./api/observations/${shardFile}`))
        .then((shard) => {
          this.obsShardCache.set(shardFile, shard);
          for (const [id, payload] of Object.entries(shard.basins || {})) {
            this.obsByBasin.set(id, payload);
          }
          return shard;
        })
        .finally(() => {
          this.obsShardPromises.delete(shardFile);
        });
      this.obsShardPromises.set(shardFile, promise);
    }
    return this.obsShardPromises.get(shardFile);
  }

  chartYDomain(basin) {
    const values = [];
    for (let lead = 1; lead <= 7; lead += 1) {
      values.push(...this.chartValues(this.seriesForLead(basin, lead)));
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
      .sf-overview,.sf-overview-modal,.sf-overview-dialog,.sf-basin-panel,.sf-modal{--sf-surface:#fff;--sf-surface-soft:#f8fafc;--sf-surface-chip:#f1f5f9;--sf-border:#e2e8f0;--sf-border-strong:#cbd5e1;--sf-text:#0f172a;--sf-muted:#64748b;--sf-focus:#2563eb;--sf-focus-soft:rgba(37,99,235,.16);--sf-button:#fff;--sf-button-active:#0f172a;--sf-button-active-text:#fff;--sf-chart-bg:#f8fafc;--sf-band:rgba(14,165,233,.18);--sf-p50:#0284c7;--sf-obs:#0f172a;--sf-overlay:rgba(15,23,42,.58);--sf-shadow:0 24px 80px rgba(15,23,42,.35);--sf-readout-bg:rgba(255,255,255,.94)}
      body.theme-dark .sf-overview,body.theme-dark .sf-overview-modal,body.theme-dark .sf-overview-dialog,body.theme-dark .sf-basin-panel,body.theme-dark .sf-modal{--sf-surface:#111827;--sf-surface-soft:#1f2937;--sf-surface-chip:#182235;--sf-border:#334155;--sf-border-strong:#475569;--sf-text:#e5e7eb;--sf-muted:#94a3b8;--sf-focus:#38bdf8;--sf-focus-soft:rgba(56,189,248,.18);--sf-button:#1f2937;--sf-button-active:#38bdf8;--sf-button-active-text:#082f49;--sf-chart-bg:#0f172a;--sf-band:rgba(56,189,248,.20);--sf-p50:#38bdf8;--sf-obs:#f8fafc;--sf-overlay:rgba(2,6,23,.72);--sf-shadow:0 24px 80px rgba(0,0,0,.58);--sf-readout-bg:rgba(17,24,39,.94)}
      .sf-lead-row{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
      .sf-lead{border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:6px 9px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease,color .16s ease}
      .sf-lead:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-lead.active{background:var(--sf-button-active);border-color:var(--sf-button-active);color:var(--sf-button-active-text);font-weight:600}
      .sf-mode-row{display:flex;gap:8px;margin:0 0 10px}
      .sf-mode{border:1px solid var(--sf-border-strong);background:var(--sf-surface-muted);color:var(--sf-muted);border-radius:6px;padding:6px 10px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease,color .16s ease}
      .sf-mode:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-mode.active{background:var(--sf-text);border-color:var(--sf-text);color:var(--sf-surface);font-weight:600}
      .sf-overview-modal{position:fixed;inset:0;background:var(--sf-overlay);z-index:4900;display:none;align-items:flex-start;justify-content:center;padding:28px 18px;overflow:auto}
      .sf-overview-modal.visible{display:flex}
      .sf-overview-dialog{width:min(860px,96vw);max-height:calc(100vh - 56px);overflow:auto;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:8px;box-shadow:var(--sf-shadow)}
      .sf-overview-header{position:sticky;top:0;z-index:1;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;background:var(--sf-surface);border-bottom:1px solid var(--sf-border);padding:16px 18px}
      .sf-overview-title{color:var(--sf-text);font-size:18px;font-weight:600;line-height:1.2}
      .sf-overview-subtitle{color:var(--sf-muted);font-size:12px;margin-top:3px}
      .sf-overview-close{position:relative;display:inline-grid;place-items:center;flex:0 0 34px;width:34px;height:34px;aspect-ratio:1/1;border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:0;cursor:pointer}
      .sf-overview-close::before,.sf-overview-close::after{content:"";position:absolute;left:50%;top:50%;width:15px;height:2px;background:currentColor;border-radius:999px;transform-origin:center}
      .sf-overview-close::before{transform:translate(-50%,-50%) rotate(45deg)}
      .sf-overview-close::after{transform:translate(-50%,-50%) rotate(-45deg)}
      .sf-overview-close:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-overview-body{display:grid;gap:18px;padding:18px;color:var(--sf-text);font-size:13px;line-height:1.5}
      .sf-overview-body section{display:grid;gap:12px}
      .sf-overview-body h3{margin:0;color:var(--sf-text);font-size:14px;font-weight:600;line-height:1.3}
      .sf-overview-body p{margin:0;color:var(--sf-muted)}
      .sf-overview-lead{font-size:13px;color:var(--sf-text)!important}
      .sf-overview-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
      .sf-overview-note{display:grid;gap:4px;background:var(--sf-surface-soft);border:1px solid var(--sf-border);border-radius:6px;padding:10px;margin:0 0 12px;color:var(--sf-muted);font-size:12px;line-height:1.4}
      .sf-overview-note strong{color:var(--sf-text);font-size:13px}
      .sf-filter-panel{display:grid;gap:10px;background:var(--sf-surface-soft);border:1px solid var(--sf-border);border-radius:6px;padding:12px;margin:0}
      .sf-filter-title{color:var(--sf-text);font-size:13px;font-weight:600}
      .sf-filter-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;align-items:end}
      .sf-filter-field{display:grid;gap:5px;color:var(--sf-muted);font-size:11px}
      .sf-filter-field span{color:var(--sf-muted)}
      .sf-filter-field select,.sf-filter-field input[type="number"]{width:100%;box-sizing:border-box;border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:7px 8px;font-size:12px;font-weight:400}
      .sf-filter-slider input{width:100%;accent-color:var(--sf-focus)}
      .sf-filter-check{display:inline-flex;align-items:center;gap:7px;color:var(--sf-text);font-size:12px;font-weight:400}
      .sf-filter-check input{width:15px;height:15px;accent-color:var(--sf-focus)}
      .sf-filter-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .sf-filter{border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:6px 9px;font-size:12px;font-weight:500;cursor:pointer}
      .sf-filter:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-filter.active{background:var(--sf-button-active);border-color:var(--sf-button-active);color:var(--sf-button-active-text);font-weight:600}
      .sf-toggle,.sf-select-label{display:inline-flex;align-items:center;gap:6px;color:var(--sf-text);font-size:12px;font-weight:500}
      .sf-toggle input{width:15px;height:15px;accent-color:var(--sf-focus)}
      .sf-select-label select{border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:5px 8px;font-size:12px}
      .sf-filter-count{color:var(--sf-muted);font-size:11px}
      .sf-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0 0 14px}
      .sf-card{background:var(--sf-surface-soft);border:1px solid var(--sf-border);border-radius:6px;padding:9px}
      .sf-card-value{font-size:16px;font-weight:550;color:var(--sf-text);line-height:1.2;overflow-wrap:anywhere}
      .sf-card-label{font-size:11px;color:var(--sf-muted);margin-top:3px}
      .sf-input-note{display:grid;gap:3px;background:var(--sf-surface-soft);border:1px solid var(--sf-border);border-radius:6px;padding:9px 10px;margin:0 0 12px;color:var(--sf-muted);font-size:11px;line-height:1.38}
      .sf-input-note strong{color:var(--sf-text);font-size:12px}
      .sf-meta-line{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px;color:var(--sf-muted);font-size:11px}
      .sf-meta-line span,.sf-modal-meta{background:var(--sf-surface-chip);border:1px solid var(--sf-border);border-radius:999px;padding:4px 8px}
      .sf-table{width:100%;border-collapse:collapse;font-size:11px}
      .sf-table th,.sf-table td{padding:6px;border-bottom:1px solid var(--sf-border);text-align:right;color:var(--sf-text)}
      .sf-table th{font-weight:500;color:var(--sf-muted)}
      .sf-table th:first-child,.sf-table td:first-child{text-align:left}
      .sf-status{display:flex;justify-content:space-between;gap:8px;border-radius:6px;padding:9px 10px;margin:0 0 12px;font-size:12px}
      .sf-status.validated{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
      .sf-status.adapter{background:#faf5ff;color:#7e22ce;border:1px solid #e9d5ff}
      .sf-status.label{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
      .sf-status.prediction{background:var(--sf-surface-soft);color:var(--sf-muted);border:1px solid var(--sf-border-strong)}
      body.theme-dark .sf-status.validated{background:rgba(6,95,70,.24);color:#a7f3d0;border-color:rgba(16,185,129,.48)}
      body.theme-dark .sf-status.adapter{background:rgba(88,28,135,.26);color:#e9d5ff;border-color:rgba(192,132,252,.45)}
      body.theme-dark .sf-status.label{background:rgba(29,78,216,.22);color:#bfdbfe;border-color:rgba(96,165,250,.45)}
      .sf-chart-preview{position:relative;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:4px;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease,transform .16s ease}
      .sf-chart-preview:hover,.sf-chart-preview:focus-visible{border-color:var(--sf-focus);background:var(--sf-focus-soft);box-shadow:0 0 0 2px var(--sf-focus-soft),0 12px 28px rgba(15,23,42,.16);transform:translateY(-1px);outline:0}
      .sf-chart-preview.is-history-loading{border-color:var(--sf-focus-soft);background:var(--sf-surface-soft)}
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
      .sf-hover-label{opacity:0;fill:var(--sf-text);font-size:11px;font-weight:500;paint-order:stroke;stroke:var(--sf-chart-bg);stroke-width:3px;stroke-linejoin:round;pointer-events:none}
      .sf-hover-label-band,.sf-hover-label-date{fill:var(--sf-muted);font-weight:500}
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
      .sf-empty-chart div{font-size:24px;font-weight:500;color:var(--sf-text)}
      .sf-history-overlay{position:absolute;right:10px;top:10px;z-index:2;background:var(--sf-readout-bg);border:1px solid var(--sf-border);border-radius:6px;padding:4px 7px;color:var(--sf-muted);font-size:11px;font-weight:500;box-shadow:0 8px 20px rgba(15,23,42,.12);pointer-events:none}
      .sf-legend{font-size:11px;color:var(--sf-muted,#475569)}
      body.theme-dark .sf-legend{color:#94a3b8}
      .sf-gradient{height:9px;border-radius:999px;background:linear-gradient(90deg,#7c3aed,#2563eb,#0ea5e9,#10b981,#f59e0b);margin:6px 0}
      .sf-legend-ticks,.sf-symbol-row{display:flex;justify-content:space-between;gap:6px}
      .sf-symbol-row{align-items:center;margin-top:6px}
      .sf-legend-note{margin-top:7px;line-height:1.35;color:var(--sf-muted,#64748b)}
      .sf-dot-symbol{width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block}
      .sf-diamond-symbol{width:8px;height:8px;background:#60a5fa;display:inline-block;transform:rotate(45deg)}
      .sf-triangle-symbol{width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid #94a3b8;display:inline-block}
      .sf-adapter-symbol{width:11px;height:11px;border:2px solid #a855f7;border-radius:50%;display:inline-block;background:transparent}
      .sf-fallback-symbol{width:11px;height:11px;border:2px solid #f59e0b;border-radius:50%;display:inline-block;background:transparent}
      .sf-modal{position:fixed;inset:0;background:var(--sf-overlay);z-index:5000;display:none;align-items:center;justify-content:center;padding:24px}
      .sf-modal.visible{display:flex}
      .sf-modal-card{width:min(900px,96vw);max-height:92vh;overflow:auto;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:8px;box-shadow:var(--sf-shadow);padding:18px}
      .sf-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
      .sf-modal-title{margin:0;color:var(--sf-text);font-size:18px;line-height:1.25}
      .sf-kicker{margin:0 0 4px;color:var(--sf-muted);text-transform:uppercase;letter-spacing:.06em;font-size:11px;font-weight:500}
      .sf-modal-chart-wrap{position:relative}
      .sf-modal-close{display:inline-grid;place-items:center;flex:0 0 34px;width:34px;height:34px;aspect-ratio:1/1;border:1px solid var(--sf-border-strong);background:var(--sf-button);color:var(--sf-text);border-radius:6px;padding:0;cursor:pointer}
      .sf-modal-close span{position:relative;display:block;width:16px;height:16px;aspect-ratio:1/1}
      .sf-modal-close span::before,.sf-modal-close span::after{content:"";position:absolute;left:50%;top:50%;width:16px;height:2px;background:currentColor;border-radius:999px;transform-origin:center}
      .sf-modal-close span::before{transform:translate(-50%,-50%) rotate(45deg)}
      .sf-modal-close span::after{transform:translate(-50%,-50%) rotate(-45deg)}
      .sf-modal-close:hover{border-color:var(--sf-focus);box-shadow:0 0 0 2px var(--sf-focus-soft)}
      .sf-modal-meta{display:inline-block;margin:0 0 12px;color:var(--sf-muted);font-size:12px}
      @media (max-width:720px){.sf-overview-modal{padding:14px 10px}.sf-overview-dialog{width:100%;max-height:calc(100vh - 28px)}.sf-overview-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.sf-filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media (max-width:460px){.sf-overview-metrics,.sf-filter-grid{grid-template-columns:1fr}.sf-overview-header{padding:14px}.sf-overview-body{padding:14px}}
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

