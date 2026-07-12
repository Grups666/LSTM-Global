import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "public", "modules", "streamflow-forecast", "obs-skill.js");
const modulePath = path.join(root, "public", "modules", "streamflow-forecast", "index.js");
const dataPath = path.join(root, "public", "modules", "streamflow-forecast", "api", "observations", "basins.json");
const rootManifestPath = path.join(root, "module.json");
const publicManifestPath = path.join(root, "public", "modules", "streamflow-forecast", "module.json");

const context = { globalThis: {}, console };
context.globalThis = context;
context.window = context;
vm.createContext(context);
const helperSource = fs.readFileSync(helperPath, "utf8");
const moduleSource = fs.readFileSync(modulePath, "utf8");
vm.runInContext(helperSource, context, { filename: helperPath });
vm.runInContext(moduleSource, context, { filename: modulePath });

const skill = context.StreamflowForecastObsSkill;
if (!skill) throw new Error("StreamflowForecastObsSkill was not registered");
const ForecastModule = context.StreamflowForecastModule;
if (!ForecastModule) throw new Error("StreamflowForecastModule was not registered");

const payload = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, "utf8"));
const publicManifest = JSON.parse(fs.readFileSync(publicManifestPath, "utf8"));
if (rootManifest.assetVersion !== publicManifest.assetVersion) {
  throw new Error(`Root/public module assetVersion mismatch: ${rootManifest.assetVersion} !== ${publicManifest.assetVersion}`);
}
const basin = payload.basins.find((item) => item.id === "hysets_09253000");
if (!basin) throw new Error("Expected fixture basin hysets_09253000 in observations/basins.json");

basin.candidateMetrics = {
  byLead: {
    "1": {
      nse: 0.65
    }
  }
};
const obsLead1 = skill.metricValue(basin, "nse", "1");
const candidateLead1 = Number(basin.candidateMetrics?.byLead?.["1"]?.nse);
if (!(obsLead1 < 0)) {
  throw new Error(`Expected recent obs L1 NSE to be negative, got ${obsLead1}`);
}
if (!(candidateLead1 > 0.4)) {
  throw new Error(`Expected fixture candidate L1 NSE to be >0.4, got ${candidateLead1}`);
}
if (skill.metricValue(basin, "nse", "1") === candidateLead1) {
  throw new Error("Recent obs skill metric must not read candidateMetrics");
}

const summary = skill.summarize(payload.basins, "nse", "1");
if (summary.gt04 >= payload.basins.length / 2) {
  throw new Error(`Unexpectedly high recent obs L1 NSE >0.4 count: ${summary.gt04}`);
}
if (skill.filterLabel("nse", "1") !== "L1 obs NSE") {
  throw new Error("Unexpected L1 filter label");
}

const module = new ForecastModule({});
if (module.accuracyFilter.minNse !== 0) {
  throw new Error(`Default overview NSE threshold must be >0, got ${module.accuracyFilter.minNse}`);
}
if (!moduleSource.includes("visible: true")) {
  throw new Error("Overview layer should be visible by default so the overview opens on load");
}
if (!moduleSource.includes("window.setTimeout?.(scheduleOverviewOpen, 0)")) {
  throw new Error("Overview should be reopened after module/list initialization so it appears on page load");
}
if (!fs.readFileSync(path.join(root, "public", "index.html"), "utf8").includes("data-click-action=\"${clickAction}\"")) {
  throw new Error("Layer rows should expose click action so show-only rows use full-row activation");
}
if (moduleSource.includes("candidate.basinCount")) {
  throw new Error("Overview render must not reference undefined candidate.basinCount");
}
if (Number.isFinite(module.chartNumber(null))) {
  throw new Error("Null observed values must not be coerced to zero in charts");
}
if (Number.isFinite(module.nonnegative(null))) {
  throw new Error("Missing observed values must not produce a zero-valued hydrograph point");
}
const chartValues = module.chartValues({ obs: [null, 0.25], p05: [0], p50: [1], p95: [2] });
if (chartValues.includes(0) === false || chartValues.includes(0.25) === false || chartValues.length !== 4) {
  throw new Error(`Unexpected chart value extraction: ${JSON.stringify(chartValues)}`);
}

console.log(JSON.stringify({
  basin: basin.id,
  obsLead1,
  candidateLead1,
  lead1Gt04: summary.gt04,
  label: skill.filterLabel("nse", "1"),
  nullObsChartNumberFinite: Number.isFinite(module.chartNumber(null))
}, null, 2));
