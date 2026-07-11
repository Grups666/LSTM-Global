const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "public", "modules", "streamflow-forecast", "obs-skill.js");
const dataPath = path.join(root, "public", "modules", "streamflow-forecast", "api", "observations", "basins.json");

const context = { globalThis: {} };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(helperPath, "utf8"), context, { filename: helperPath });

const skill = context.StreamflowForecastObsSkill;
if (!skill) throw new Error("StreamflowForecastObsSkill was not registered");

const payload = JSON.parse(fs.readFileSync(dataPath, "utf8"));
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

console.log(JSON.stringify({
  basin: basin.id,
  obsLead1,
  candidateLead1,
  lead1Gt04: summary.gt04,
  label: skill.filterLabel("nse", "1")
}, null, 2));
