const state = {
  data: null,
  selectedLead: 7,
  selectedBasinId: null,
  hoveredBasinId: null,
  basinPoints: [],
};

const mapCanvas = document.querySelector("#mapCanvas");
const mapCtx = mapCanvas.getContext("2d");
const seriesCanvas = document.querySelector("#seriesCanvas");
const seriesCtx = seriesCanvas.getContext("2d");
const leadButtons = document.querySelector("#leadButtons");
const summaryGrid = document.querySelector("#summaryGrid");
const basinSearch = document.querySelector("#basinSearch");
const resetSelection = document.querySelector("#resetSelection");
const basinTitle = document.querySelector("#basinTitle");
const basinSubtitle = document.querySelector("#basinSubtitle");
const basinMetrics = document.querySelector("#basinMetrics");
const chartCaption = document.querySelector("#chartCaption");
const tooltip = document.querySelector("#tooltip");
const loading = document.querySelector("#loading");

const nseStops = [
  { at: 0.0, color: [139, 30, 63] },
  { at: 0.35, color: [215, 111, 44] },
  { at: 0.58, color: [209, 179, 52] },
  { at: 0.78, color: [43, 157, 103] },
  { at: 1.0, color: [30, 120, 184] },
];

init().catch((error) => {
  loading.textContent = `Failed to load dashboard data: ${error.message}`;
  console.error(error);
});

async function init() {
  createLeadButtons();
  const response = await fetch("data/dashboard-data.json");
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  state.data = await response.json();
  state.selectedBasinId = pickRepresentativeBasin();
  basinSearch.value = state.selectedBasinId;
  loading.hidden = true;

  window.addEventListener("resize", () => {
    drawMap();
    drawSeries();
  });
  mapCanvas.addEventListener("mousemove", onMapMove);
  mapCanvas.addEventListener("mouseleave", () => {
    state.hoveredBasinId = null;
    tooltip.hidden = true;
    drawMap();
  });
  mapCanvas.addEventListener("click", onMapClick);
  mapCanvas.addEventListener("touchstart", onMapTouch, { passive: true });
  basinSearch.addEventListener("change", onSearchChange);
  basinSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") onSearchChange();
  });
  resetSelection.addEventListener("click", () => {
    state.selectedBasinId = pickRepresentativeBasin();
    basinSearch.value = state.selectedBasinId;
    render();
  });

  render();
}

function createLeadButtons() {
  for (let lead = 1; lead <= 7; lead += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(lead);
    button.dataset.lead = String(lead);
    button.title = `Show lead day ${lead}`;
    button.addEventListener("click", () => {
      state.selectedLead = lead;
      render();
    });
    leadButtons.appendChild(button);
  }
}

function render() {
  updateLeadButtons();
  updateSummary();
  updateDetail();
  drawMap();
  drawSeries();
}

function updateLeadButtons() {
  leadButtons.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.lead) === state.selectedLead);
  });
}

function updateSummary() {
  const summary = leadSummary();
  const items = [
    ["Median NSE", formatNumber(summary.medianNse, 3)],
    ["Median KGE", formatNumber(summary.medianKge, 3)],
    ["Median RMSE", formatNumber(summary.medianRmse, 3)],
    ["NSE > 0.5", formatPercent(summary.nseGt05)],
  ];
  summaryGrid.innerHTML = items.map(([label, value]) => metric(label, value)).join("");
}

function updateDetail() {
  const basin = selectedBasin();
  const metrics = basin.metrics[String(state.selectedLead)];
  basinTitle.textContent = basin.id;
  basinSubtitle.textContent = `Lat ${formatNumber(basin.lat, 3)}, lon ${formatNumber(basin.lon, 3)}. Metrics use the full 2015-2019 test period.`;
  basinMetrics.innerHTML = [
    ["Lead", `Day ${state.selectedLead}`],
    ["NSE", formatNumber(metrics.nse, 3)],
    ["KGE", formatNumber(metrics.kge, 3)],
    ["RMSE", formatNumber(metrics.rmse, 3)],
  ].map(([label, value]) => metric(label, value)).join("");
  chartCaption.textContent = `${state.data.meta.dateRange[0]} to ${state.data.meta.dateRange[1]}, observed GRDC-Caravan discharge vs sampled CMAL forecast.`;
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function drawMap() {
  if (!state.data) return;

  const rect = mapCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  mapCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  mapCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapCtx.clearRect(0, 0, rect.width, rect.height);

  const plot = mapLayout(rect.width, rect.height);
  drawOcean(rect.width, rect.height);
  drawLand(plot);
  drawGraticule(plot);
  drawBasins(plot);
}

function drawOcean(width, height) {
  const gradient = mapCtx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#f9fbfc");
  gradient.addColorStop(1, "#e1ebef");
  mapCtx.fillStyle = gradient;
  mapCtx.fillRect(0, 0, width, height);
}

function drawLand(plot) {
  const land = window.WORLD_LAND || [];
  mapCtx.save();
  mapCtx.fillStyle = "rgba(205, 217, 209, 0.78)";
  mapCtx.strokeStyle = "rgba(128, 148, 151, 0.34)";
  mapCtx.lineWidth = 0.7;
  for (const polygon of land) {
    if (!polygon.length) continue;
    mapCtx.beginPath();
    polygon.forEach(([lon, lat], index) => {
      const point = project(lon, lat, plot);
      if (index === 0) mapCtx.moveTo(point.x, point.y);
      else mapCtx.lineTo(point.x, point.y);
    });
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.stroke();
  }
  mapCtx.restore();
}

function drawGraticule(plot) {
  mapCtx.save();
  mapCtx.strokeStyle = "rgba(70, 96, 113, 0.13)";
  mapCtx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 60) {
    const a = project(lon, -70, plot);
    const b = project(lon, 80, plot);
    mapCtx.beginPath();
    mapCtx.moveTo(a.x, a.y);
    mapCtx.lineTo(b.x, b.y);
    mapCtx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const a = project(-180, lat, plot);
    const b = project(180, lat, plot);
    mapCtx.beginPath();
    mapCtx.moveTo(a.x, a.y);
    mapCtx.lineTo(b.x, b.y);
    mapCtx.stroke();
  }
  mapCtx.restore();
}

function drawBasins(plot) {
  state.basinPoints = state.data.basins.map((basin) => {
    const point = project(basin.lon, basin.lat, plot);
    return { basin, x: point.x, y: point.y };
  });

  const selected = state.selectedBasinId;
  const hovered = state.hoveredBasinId;

  mapCtx.save();
  for (const point of state.basinPoints) {
    const metrics = point.basin.metrics[String(state.selectedLead)];
    const radius = point.basin.id === selected ? 6.5 : point.basin.id === hovered ? 6 : 4.2;
    mapCtx.beginPath();
    mapCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    mapCtx.fillStyle = nseColor(metrics?.nse);
    mapCtx.fill();
    mapCtx.strokeStyle = point.basin.id === selected ? "#102333" : "rgba(255, 255, 255, 0.92)";
    mapCtx.lineWidth = point.basin.id === selected ? 2.2 : 1.2;
    mapCtx.stroke();
  }
  mapCtx.restore();
}

function drawSeries() {
  if (!state.data) return;
  const basin = selectedBasin();
  const series = state.data.series[basin.id][String(state.selectedLead)];
  const dates = state.data.dates;
  const rect = seriesCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  seriesCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  seriesCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  seriesCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  seriesCtx.clearRect(0, 0, rect.width, rect.height);

  const padding = { left: 52, right: 18, top: 20, bottom: 38 };
  const width = rect.width - padding.left - padding.right;
  const height = rect.height - padding.top - padding.bottom;
  const values = [...series.obs, ...series.p05, ...series.p95].filter((value) => Number.isFinite(value));
  const max = Math.max(...values, 1);
  const min = Math.min(0, ...values);
  const yMax = max + (max - min || 1) * 0.1;
  const yMin = min;

  const x = (index) => padding.left + (index / Math.max(1, dates.length - 1)) * width;
  const y = (value) => padding.top + (1 - (value - yMin) / (yMax - yMin || 1)) * height;

  drawChartFrame(padding, width, height, yMin, yMax);

  seriesCtx.save();
  seriesCtx.beginPath();
  series.p95.forEach((value, index) => {
    const px = x(index);
    const py = y(value);
    if (index === 0) seriesCtx.moveTo(px, py);
    else seriesCtx.lineTo(px, py);
  });
  for (let index = series.p05.length - 1; index >= 0; index -= 1) {
    seriesCtx.lineTo(x(index), y(series.p05[index]));
  }
  seriesCtx.closePath();
  seriesCtx.fillStyle = "rgba(15, 111, 182, 0.18)";
  seriesCtx.fill();
  seriesCtx.restore();

  drawLine(series.mean, x, y, "rgba(15, 111, 182, 0.45)", 1.5, [5, 5]);
  drawLine(series.p50, x, y, "#0f6fb6", 2.6);
  drawLine(series.obs, x, y, "#102333", 2.6);

  seriesCtx.save();
  seriesCtx.fillStyle = "#60707c";
  seriesCtx.font = "12px Segoe UI, system-ui, sans-serif";
  seriesCtx.textAlign = "left";
  seriesCtx.fillText(dates[0].slice(5), padding.left, rect.height - 14);
  seriesCtx.textAlign = "right";
  seriesCtx.fillText(dates.at(-1).slice(5), padding.left + width, rect.height - 14);
  seriesCtx.restore();
}

function drawChartFrame(padding, width, height, yMin, yMax) {
  seriesCtx.save();
  seriesCtx.strokeStyle = "rgba(26, 40, 52, 0.12)";
  seriesCtx.fillStyle = "#60707c";
  seriesCtx.font = "12px Segoe UI, system-ui, sans-serif";
  seriesCtx.textAlign = "right";
  seriesCtx.textBaseline = "middle";
  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4;
    const y = padding.top + ratio * height;
    const value = yMax - ratio * (yMax - yMin);
    seriesCtx.beginPath();
    seriesCtx.moveTo(padding.left, y);
    seriesCtx.lineTo(padding.left + width, y);
    seriesCtx.stroke();
    seriesCtx.fillText(formatNumber(value, 2), padding.left - 8, y);
  }
  seriesCtx.textAlign = "left";
  seriesCtx.textBaseline = "top";
  seriesCtx.fillText("streamflow", padding.left, 5);
  seriesCtx.restore();
}

function drawLine(values, x, y, strokeStyle, lineWidth, dash = []) {
  seriesCtx.save();
  seriesCtx.beginPath();
  values.forEach((value, index) => {
    const px = x(index);
    const py = y(value);
    if (index === 0) seriesCtx.moveTo(px, py);
    else seriesCtx.lineTo(px, py);
  });
  seriesCtx.strokeStyle = strokeStyle;
  seriesCtx.lineWidth = lineWidth;
  seriesCtx.setLineDash(dash);
  seriesCtx.lineJoin = "round";
  seriesCtx.lineCap = "round";
  seriesCtx.stroke();
  seriesCtx.restore();
}

function onMapMove(event) {
  const nearest = nearestBasin(event.offsetX, event.offsetY);
  const nextId = nearest && nearest.distance < 13 ? nearest.point.basin.id : null;
  if (state.hoveredBasinId !== nextId) {
    state.hoveredBasinId = nextId;
    drawMap();
  }
  if (!nextId) {
    tooltip.hidden = true;
    return;
  }
  showTooltip(event.clientX, event.clientY, nearest.point.basin);
}

function onMapClick(event) {
  const nearest = nearestBasin(event.offsetX, event.offsetY);
  if (nearest && nearest.distance < 14) {
    state.selectedBasinId = nearest.point.basin.id;
    basinSearch.value = state.selectedBasinId;
    render();
  }
}

function onMapTouch(event) {
  const touch = event.touches[0];
  if (!touch) return;
  const rect = mapCanvas.getBoundingClientRect();
  const nearest = nearestBasin(touch.clientX - rect.left, touch.clientY - rect.top);
  if (nearest && nearest.distance < 18) {
    state.selectedBasinId = nearest.point.basin.id;
    basinSearch.value = state.selectedBasinId;
    render();
  }
}

function onSearchChange() {
  const query = basinSearch.value.trim().toUpperCase();
  const match = state.data.basins.find((basin) => basin.id.toUpperCase() === query);
  if (!match) {
    basinSearch.value = state.selectedBasinId;
    return;
  }
  state.selectedBasinId = match.id;
  render();
}

function showTooltip(clientX, clientY, basin) {
  const metrics = basin.metrics[String(state.selectedLead)];
  tooltip.innerHTML = `
    <strong>${basin.id}</strong>
    Lead ${state.selectedLead}: NSE ${formatNumber(metrics.nse, 3)}, KGE ${formatNumber(metrics.kge, 3)}<br>
    Lat ${formatNumber(basin.lat, 2)}, lon ${formatNumber(basin.lon, 2)}
  `;
  tooltip.hidden = false;
  const offset = 14;
  const appRect = document.querySelector(".app-shell").getBoundingClientRect();
  tooltip.style.left = `${Math.min(clientX - appRect.left + offset, appRect.width - 250)}px`;
  tooltip.style.top = `${Math.max(10, clientY - appRect.top + offset)}px`;
}

function nearestBasin(x, y) {
  let best = null;
  for (const point of state.basinPoints) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (!best || distance < best.distance) {
      best = { point, distance };
    }
  }
  return best;
}

function project(lon, lat, plot) {
  return {
    x: plot.left + ((lon + 180) / 360) * plot.width,
    y: plot.top + ((80 - lat) / 150) * plot.height,
  };
}

function mapLayout(width, height) {
  const detailSpace = width > 980 ? 520 : 0;
  const leftSpace = width > 980 ? 390 : 0;
  const availableWidth = Math.max(320, width - leftSpace - detailSpace - 36);
  const mapWidth = Math.min(availableWidth, height * 2.15);
  const mapHeight = Math.min(height - 36, mapWidth / 2.15);
  return {
    left: width > 980 ? leftSpace + Math.max(18, (availableWidth - mapWidth) / 2) : Math.max(12, (width - mapWidth) / 2),
    top: Math.max(18, (height - mapHeight) / 2),
    width: mapWidth,
    height: mapHeight,
  };
}

function nseColor(value) {
  const clamped = Math.max(0, Math.min(0.82, Number.isFinite(value) ? value : 0)) / 0.82;
  let lower = nseStops[0];
  let upper = nseStops.at(-1);
  for (let index = 1; index < nseStops.length; index += 1) {
    if (clamped <= nseStops[index].at) {
      lower = nseStops[index - 1];
      upper = nseStops[index];
      break;
    }
  }
  const span = upper.at - lower.at || 1;
  const ratio = (clamped - lower.at) / span;
  const color = lower.color.map((channel, index) => Math.round(channel + (upper.color[index] - channel) * ratio));
  return `rgb(${color.join(",")})`;
}

function selectedBasin() {
  return state.data.basins.find((basin) => basin.id === state.selectedBasinId) || state.data.basins[0];
}

function leadSummary() {
  return state.data.leadSummary.find((item) => item.lead === state.selectedLead);
}

function pickRepresentativeBasin() {
  const lead = String(state.selectedLead);
  const target = leadSummary()?.medianNse ?? 0.61;
  return state.data.basins
    .filter((basin) => Number.isFinite(basin.metrics[lead]?.nse))
    .sort((a, b) => Math.abs(a.metrics[lead].nse - target) - Math.abs(b.metrics[lead].nse - target))[0].id;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "NA";
  return value.toFixed(digits);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "NA";
  return `${Math.round(value * 100)}%`;
}
