(function registerStreamflowForecastObsSkill(global) {
  function normalizedMetric(metricKey) {
    return metricKey === "kge" ? "kge" : "nse";
  }

  function metricValue(meta, metricKey, lead) {
    if (!meta) return NaN;
    const metric = normalizedMetric(metricKey);
    const leadKey = String(lead || "all");
    const raw = leadKey === "all"
      ? meta.metrics?.[metric] ?? meta[metric]
      : meta.byLead?.[leadKey]?.[metric];
    const value = Number(raw);
    return Number.isFinite(value) ? value : NaN;
  }

  function filterLabel(metricKey, lead) {
    const metric = normalizedMetric(metricKey).toUpperCase();
    const leadKey = String(lead || "all");
    return leadKey === "all" ? `30-day obs ${metric}` : `L${leadKey} obs ${metric}`;
  }

  function summarize(metaIterable, metricKey, lead) {
    const values = [];
    for (const meta of metaIterable || []) {
      const value = metricValue(meta, metricKey, lead);
      if (Number.isFinite(value)) values.push(value);
    }
    values.sort((a, b) => a - b);
    const leadKey = String(lead || "all");
    const median = values.length ? values[Math.floor((values.length - 1) / 2)] : NaN;
    return {
      label: leadKey === "all" ? "30-day obs" : `L${leadKey} obs`,
      count: values.length,
      median,
      gt0: values.reduce((count, value) => count + (value > 0 ? 1 : 0), 0),
      gt04: values.reduce((count, value) => count + (value > 0.4 ? 1 : 0), 0),
      gt05: values.reduce((count, value) => count + (value > 0.5 ? 1 : 0), 0)
    };
  }

  global.StreamflowForecastObsSkill = {
    metricValue,
    filterLabel,
    summarize
  };
})(typeof window !== "undefined" ? window : globalThis);
