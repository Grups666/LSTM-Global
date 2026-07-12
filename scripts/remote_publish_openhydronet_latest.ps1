param(
  [string]$OpenHydroNetRoot = "D:\SSH\OpenHydroNet_FloodHub_Operational",
  [string]$PagesRepo = "D:\SSH\LSTM-Global",
  [string]$RemoteUrl = "ssh://git@ssh.github.com:443/Grups666/LSTM-Global.git",
  [string]$CloneUrl = "https://github.com/Grups666/LSTM-Global.git",
  [string]$Branch = "main",
  [string]$PythonExe = "D:\SSH\conda_envs\hydro\python.exe",
  [string]$GitExe = "C:\Program Files\Git\cmd\git.exe",
  [string]$SshExe = "C:\Program Files\Git\usr\bin\ssh.exe",
  [string]$DeployKey = "D:\SSH\OpenHydroNet_FloodHub_Operational\secrets\lstm_global_deploy_ed25519",
  [string]$PagesWorktree = "D:\SSH\LSTM-Global-gh-pages-publish",
  [string]$HistoryRoot = "D:\SSH\OpenHydroNet_FloodHub_Operational\outputs\api\history",
  [string]$CandidateBundleManifestJson = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\strict_obs_final_rescue_latest.json",
  [string]$ValidationRunDir = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\validation\public_streamflow_daily\latest",
  [string]$CandidateMetricsCsv = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\gate_published_clim095_margin005_writepred_20260710\gate_published_clim095_m005_lead12\basin_lead_metrics.csv",
  [string]$CandidateManifestJson = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\gate_published_clim095_margin005_writepred_20260710\gate_published_clim095_m005_lead12\manifest.json",
  [string]$CandidateSkillClassesCsv = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\gate_published_clim095_margin005_writepred_20260710\gate_published_clim095_m005_lead12_basin_skill_classes.csv",
  [string]$CandidateLabel = "Strict obs climatology-blend rescue gate lead1-2",
  [string]$CandidateMetricsSplit = "test",
  [string]$StrictObsProjectRoot = "D:\SSH\Hydrological_Forecasting_DL",
  [string]$StrictObsOverlayWorkRoot = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\daily_history_overlay",
  [string]$StrictObsAdaptiveClimatologyBasinLead = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\climatology_rescue_20260710_192325\adaptive\adaptive_final_alpha_default1_m002_shrink60\climatology_basin_lead.csv",
  [string]$StrictObsAdaptiveAlphaTable = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\climatology_rescue_20260710_192325\adaptive\adaptive_final_alpha_default1_m002_shrink60\adaptive_alpha_table.csv",
  [string]$StrictObsAdaptiveGateSelection = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\climatology_rescue_20260710_192325\adaptive_gate\gate_selection.csv",
  [double]$StrictObsSelectionMargin = 0.05,
  [string]$StrictObsOverlayLabel = "adaptive_margin_0p05_live",
  [string]$StrictObsBasinleadBundleJson = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\strict_obs_basinlead_publish_latest.json",
  [int]$StrictObsBasinleadMaxIssueLagDays = 2,
  [string]$StrictObsBasinleadFallbackPredictions = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\source_expansion_live_inference_20260711\fixed_blend_alpha0p8\predictions.csv.gz",
  [string]$StrictObsBasinleadCandidatePredictions = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\source_expansion_live_inference_20260711\basinlead_alpha_candidate_fit10_default0p8_validltissue_20260712\predictions.csv.gz",
  [double]$StrictObsBasinleadMinImprovement = -0.05,
  [double]$StrictObsBasinleadProtectFallbackNseLte = 0.8,
  [double]$StrictObsBasinleadMinCandidateNse = 0.2,
  [string]$StrictObsBasinleadLabel = "sourceexp_basinlead_gate_protect0p8_marginm0p05_mincand0p2",
  [switch]$DisableStrictObsBasinleadGate,
  [switch]$RequireStrictObsBasinleadGate,
  [int]$HistoryDays = 30,
  [switch]$SkipPull,
  [switch]$Push,
  [switch]$DisableStrictObsHistoryOverlay,
  [switch]$RequireStrictObsHistoryOverlay
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$StaticApiDir = Join-Path $OpenHydroNetRoot "outputs\api\latest\static"
$CaravanNcDir = Join-Path $OpenHydroNetRoot "data\raw\Caravan-nc"
$LogDir = Join-Path $OpenHydroNetRoot "logs\lstm_global_publish"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogPath = Join-Path $LogDir ("publish_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".log")

function Write-Log {
  param([string]$Message)
  $line = "$(Get-Date -Format s) $Message"
  Write-Output $line
  Add-Content -Encoding UTF8 -Path $LogPath -Value $line
}

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  function Quote-ProcessArg {
    param([string]$Arg)
    if ($Arg -match '[\s"]') {
      return '"' + ($Arg -replace '\\(?=\\*")', '$&' -replace '"', '\"') + '"'
    }
    return $Arg
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $GitExe
  $psi.Arguments = ($Args | ForEach-Object { Quote-ProcessArg $_ }) -join " "
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($stdout) { Write-Output $stdout.TrimEnd() }
  if ($stderr) { Write-Output $stderr.TrimEnd() }
  if ($p.ExitCode -ne 0) {
    throw "git failed: $($Args -join ' ')"
  }
}

if (-not (Test-Path $StaticApiDir)) { throw "Static API dir missing: $StaticApiDir" }
if (-not (Test-Path (Join-Path $StaticApiDir "latest.json"))) { throw "latest.json missing under $StaticApiDir" }
if (-not (Test-Path $PythonExe)) { throw "Python not found: $PythonExe" }
if (-not (Test-Path $GitExe)) { throw "Git not found: $GitExe" }
if ($Push -and (Test-Path $DeployKey)) {
  $env:GIT_SSH_COMMAND = "`"$SshExe`" -i `"$DeployKey`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
}

Write-Log "START openhydronet_publish static_api=$StaticApiDir repo=$PagesRepo push=$Push"

if (-not (Test-Path $PagesRepo)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $PagesRepo) | Out-Null
  Write-Log "clone_repo url=$CloneUrl"
  Invoke-Git clone $CloneUrl $PagesRepo
}

Invoke-Git -C $PagesRepo checkout $Branch
if (-not $SkipPull) {
  Invoke-Git -C $PagesRepo pull --ff-only origin $Branch
}

$ApiDir = Join-Path $PagesRepo "public\modules\streamflow-forecast\api"
$DataDir = Join-Path $PagesRepo "public\modules\streamflow-forecast\data"
New-Item -ItemType Directory -Force -Path $ApiDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

Write-Log "copy_static_api"
Get-ChildItem -LiteralPath $StaticApiDir -Filter "*.json" | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $ApiDir $_.Name) -Force
}

$DashboardScript = Join-Path $PagesRepo "scripts\build_openhydronet_dashboard.py"
if (-not (Test-Path $DashboardScript)) { throw "Dashboard builder missing: $DashboardScript" }

Write-Log "build_dashboard"
& $PythonExe $DashboardScript `
  --static-api-dir $ApiDir `
  --caravan-nc-dir $CaravanNcDir `
  --output-dashboard (Join-Path $DataDir "dashboard-data-state-current.json") `
  --compact
if ($LASTEXITCODE -ne 0) { throw "dashboard builder failed" }

$LatestJson = Get-Content -LiteralPath (Join-Path $ApiDir "latest.json") -Raw | ConvertFrom-Json
Write-Log ("api_issue_date=" + $LatestJson.issueDate)
Write-Log ("api_basin_count=" + $LatestJson.basinCount)
Write-Log ("api_row_count=" + $LatestJson.rowCount)
if ($LatestJson.streamflowInputUsed -ne $false) {
  throw "Refusing to publish product with streamflowInputUsed=$($LatestJson.streamflowInputUsed)"
}

Write-Log "archive_history_static"
$HistoryIssueDir = Join-Path $HistoryRoot $LatestJson.issueDate
$HistoryStaticDir = Join-Path $HistoryIssueDir "static"
New-Item -ItemType Directory -Force -Path $HistoryStaticDir | Out-Null
Get-ChildItem -LiteralPath $ApiDir -Filter "*.json" | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $HistoryStaticDir $_.Name) -Force
}

$HistoryScript = Join-Path $PagesRepo "scripts\build_openhydronet_history_api.py"
if (-not (Test-Path $HistoryScript)) { throw "History builder missing: $HistoryScript" }
Write-Log "build_history_api"
& $PythonExe $HistoryScript `
  --history-root $HistoryRoot `
  --output-dir (Join-Path $ApiDir "history") `
  --window-days $HistoryDays `
  --max-lead $LatestJson.maxLead `
  --shard-size 50
if ($LASTEXITCODE -ne 0) { throw "history API builder failed" }

$ObservationValidationRunDir = $ValidationRunDir
$StrictObsBasinleadApplied = $false
if (-not $DisableStrictObsBasinleadGate) {
  $StrictBasinleadScript = Join-Path $StrictObsProjectRoot "scripts\run_strict_obs_basinlead_gate_overlay_pipeline.py"
  $StrictBasinleadResolver = Join-Path $StrictObsProjectRoot "scripts\resolve_strict_obs_basinlead_publish_bundle.py"
  $StrictBasinleadResolverAttempted = $false
  $StrictBasinleadBundleReady = $true
  if (Test-Path -LiteralPath $StrictBasinleadResolver) {
    $StrictBasinleadResolverAttempted = $true
    $StrictBasinleadBundleReady = $false
    $StrictResolvedDir = Join-Path $StrictObsOverlayWorkRoot "resolved"
    New-Item -ItemType Directory -Force -Path $StrictResolvedDir | Out-Null
    $StrictResolvedBundle = Join-Path $StrictResolvedDir ("basinlead_bundle_" + $LatestJson.issueDate + ".json")
    Write-Log "strict_obs_basinlead_resolve_start expected_issue=$($LatestJson.issueDate) max_lag_days=$StrictObsBasinleadMaxIssueLagDays"
    & $PythonExe $StrictBasinleadResolver `
      --root (Join-Path $StrictObsProjectRoot "local\outputs\strict_obs_posttrain") `
      --expected-issue-date $LatestJson.issueDate `
      --max-issue-lag-days $StrictObsBasinleadMaxIssueLagDays `
      --output-json $StrictResolvedBundle `
      --allow-unresolved
    if ($LASTEXITCODE -ne 0) { throw "strict obs basinlead bundle resolver failed" }
    if (Test-Path -LiteralPath $StrictResolvedBundle) {
      Copy-Item -LiteralPath $StrictResolvedBundle -Destination $StrictObsBasinleadBundleJson -Force
      $StrictBundle = Get-Content -LiteralPath $StrictResolvedBundle -Raw | ConvertFrom-Json
      if ($StrictBundle.resolved -eq $true) {
        $StrictObsBasinleadFallbackPredictions = [string]$StrictBundle.fallback_predictions
        $StrictObsBasinleadCandidatePredictions = [string]$StrictBundle.candidate_predictions
        if ($null -ne $StrictBundle.candidate_label) { $StrictObsBasinleadLabel = [string]$StrictBundle.candidate_label }
        if ($null -ne $StrictBundle.gate.min_improvement) { $StrictObsBasinleadMinImprovement = [double]$StrictBundle.gate.min_improvement }
        if ($null -ne $StrictBundle.gate.protect_fallback_nse_lte) { $StrictObsBasinleadProtectFallbackNseLte = [double]$StrictBundle.gate.protect_fallback_nse_lte }
        if ($null -ne $StrictBundle.gate.min_candidate_nse) { $StrictObsBasinleadMinCandidateNse = [double]$StrictBundle.gate.min_candidate_nse }
        $StrictBasinleadBundleReady = $true
        Write-Log "strict_obs_basinlead_resolved bundle=$StrictResolvedBundle issue_date_max=$($StrictBundle.issue_date_max) issue_lag_days=$($StrictBundle.issue_lag_days) label=$StrictObsBasinleadLabel"
      } else {
        $msg = "strict_obs_basinlead_bundle_unresolved=" + (($StrictBundle.blockers | ForEach-Object { [string]$_ }) -join ";")
        if ($RequireStrictObsBasinleadGate) { throw $msg }
        Write-Log ("WARN " + $msg)
      }
    }
  } else {
    Write-Log "WARN strict_obs_basinlead_resolver_missing=$StrictBasinleadResolver"
  }
  if ($StrictBasinleadResolverAttempted -and (-not $StrictBasinleadBundleReady)) {
    $StrictBasinleadMissingInputs = @("resolved_strict_obs_basinlead_publish_bundle")
  } else {
    $StrictBasinleadRequiredInputs = @(
      $StrictBasinleadScript,
      $StrictObsBasinleadFallbackPredictions,
      $StrictObsBasinleadCandidatePredictions,
      (Join-Path $ValidationRunDir "forecast_validation.csv.gz"),
      (Join-Path $ValidationRunDir "observed_streamflow.csv.gz")
    )
    $StrictBasinleadMissingInputs = @($StrictBasinleadRequiredInputs | Where-Object { -not (Test-Path $_) })
  }
  if ($StrictBasinleadMissingInputs.Count -gt 0) {
    $msg = "strict_obs_basinlead_gate_missing_inputs=" + ($StrictBasinleadMissingInputs -join ";")
    if ($RequireStrictObsBasinleadGate) { throw $msg }
    Write-Log ("WARN " + $msg)
  } else {
    $StrictIssueWorkRoot = Join-Path $StrictObsOverlayWorkRoot $LatestJson.issueDate
    $StrictWorkDir = Join-Path $StrictIssueWorkRoot "basinlead_work"
    $StrictOverlayApi = Join-Path $StrictIssueWorkRoot "basinlead_api_overlay"
    if (Test-Path -LiteralPath $StrictIssueWorkRoot) {
      Remove-Item -LiteralPath $StrictIssueWorkRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $StrictIssueWorkRoot | Out-Null
    Write-Log "strict_obs_basinlead_gate_start work_dir=$StrictWorkDir"
    & $PythonExe $StrictBasinleadScript `
      --public-api-root $ApiDir `
      --source-validation-run-dir $ValidationRunDir `
      --validation-csv-gz (Join-Path $ValidationRunDir "forecast_validation.csv.gz") `
      --output-api-root $StrictOverlayApi `
      --work-dir $StrictWorkDir `
      --fallback-predictions $StrictObsBasinleadFallbackPredictions `
      --candidate-predictions $StrictObsBasinleadCandidatePredictions `
      --leads "1,2" `
      --min-count 4 `
      --min-improvement $StrictObsBasinleadMinImprovement `
      --protect-fallback-nse-lte $StrictObsBasinleadProtectFallbackNseLte `
      --min-candidate-nse $StrictObsBasinleadMinCandidateNse `
      --fallback-name "published_alpha0p8" `
      --candidate-name "basinlead_alpha_validltissue" `
      --candidate-label $StrictObsBasinleadLabel `
      --filter-candidate-to-history-issues `
      --fill-missing-overlay-leads-with-history `
      --auto-recent-comparison `
      --promotion-min-overlap-rows 1000 `
      --promotion-min-basins 3900 `
      --promotion-min-delta-gt0 0 `
      --promotion-min-delta-gt04 0 `
      --promotion-min-delta-gt05 0 `
      --promotion-min-delta-overlap-nse 0 `
      --promotion-max-delta-overlap-mae 0 `
      --require-promotion `
      --progress-jsonl (Join-Path $StrictIssueWorkRoot "basinlead_progress.jsonl")
    if ($LASTEXITCODE -ne 0) { throw "strict obs basinlead gate overlay pipeline failed" }

    $ApiHistoryDir = Join-Path $ApiDir "history"
    if (Test-Path -LiteralPath $ApiHistoryDir) {
      Remove-Item -LiteralPath $ApiHistoryDir -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $StrictOverlayApi "history") -Destination $ApiHistoryDir -Recurse -Force
    $OverlaySummary = Join-Path $StrictOverlayApi "history_overlay_summary.json"
    if (Test-Path -LiteralPath $OverlaySummary) {
      Copy-Item -LiteralPath $OverlaySummary -Destination (Join-Path $ApiDir "history_overlay_summary.json") -Force
    }
    $ObservationValidationRunDir = Join-Path $StrictWorkDir "validation"
    $StrictObsBasinleadApplied = $true
    Write-Log "strict_obs_basinlead_gate_applied label=$StrictObsBasinleadLabel validation_run_dir=$ObservationValidationRunDir"
  }
} else {
  Write-Log "strict_obs_basinlead_gate_disabled=True"
}

if ((-not $StrictObsBasinleadApplied) -and (-not $DisableStrictObsHistoryOverlay)) {
  $StrictOverlayScript = Join-Path $StrictObsProjectRoot "scripts\run_strict_obs_history_overlay_pipeline.py"
  $StrictReuseValidationScript = Join-Path $StrictObsProjectRoot "scripts\reuse_public_streamflow_validation_for_api.py"
  $StrictRequiredInputs = @(
    $StrictOverlayScript,
    $StrictObsAdaptiveClimatologyBasinLead,
    $StrictObsAdaptiveAlphaTable,
    $StrictObsAdaptiveGateSelection
  )
  $StrictMissingInputs = @($StrictRequiredInputs | Where-Object { -not (Test-Path $_) })
  if ($StrictMissingInputs.Count -gt 0) {
    $msg = "strict_obs_history_overlay_missing_inputs=" + ($StrictMissingInputs -join ";")
    if ($RequireStrictObsHistoryOverlay) { throw $msg }
    Write-Log ("WARN " + $msg)
  } else {
    $StrictIssueWorkRoot = Join-Path $StrictObsOverlayWorkRoot $LatestJson.issueDate
    $StrictWorkDir = Join-Path $StrictIssueWorkRoot "work"
    $StrictOverlayApi = Join-Path $StrictIssueWorkRoot "api_overlay"
    if (Test-Path -LiteralPath $StrictIssueWorkRoot) {
      Remove-Item -LiteralPath $StrictIssueWorkRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $StrictIssueWorkRoot | Out-Null
    Write-Log "strict_obs_history_overlay_start work_dir=$StrictWorkDir"
    & $PythonExe $StrictOverlayScript `
      --api-root $ApiDir `
      --output-api-root $StrictOverlayApi `
      --work-dir $StrictWorkDir `
      --adaptive-climatology-basin-lead $StrictObsAdaptiveClimatologyBasinLead `
      --adaptive-alpha-table $StrictObsAdaptiveAlphaTable `
      --adaptive-gate-selection $StrictObsAdaptiveGateSelection `
      --selection-margin $StrictObsSelectionMargin `
      --candidate-label $StrictObsOverlayLabel `
      --leads "1,2" `
      --progress-jsonl (Join-Path $StrictIssueWorkRoot "progress.jsonl")
    if ($LASTEXITCODE -ne 0) { throw "strict obs history overlay pipeline failed" }

    $ApiHistoryDir = Join-Path $ApiDir "history"
    if (Test-Path -LiteralPath $ApiHistoryDir) {
      Remove-Item -LiteralPath $ApiHistoryDir -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $StrictOverlayApi "history") -Destination $ApiHistoryDir -Recurse -Force
    $OverlaySummary = Join-Path $StrictOverlayApi "history_overlay_summary.json"
    if (Test-Path -LiteralPath $OverlaySummary) {
      Copy-Item -LiteralPath $OverlaySummary -Destination (Join-Path $ApiDir "history_overlay_summary.json") -Force
    }
    Write-Log "strict_obs_history_overlay_applied label=$StrictObsOverlayLabel"

    if ((Test-Path $StrictReuseValidationScript) -and (Test-Path (Join-Path $ValidationRunDir "observed_streamflow.csv.gz"))) {
      $StrictValidationRunDir = Join-Path $StrictIssueWorkRoot "validation_reuse_obs"
      Write-Log "strict_obs_overlay_validation_reuse_start source=$ValidationRunDir"
      & $PythonExe $StrictReuseValidationScript `
        --source-validation-run-dir $ValidationRunDir `
        --api-root $ApiDir `
        --output-run-dir $StrictValidationRunDir
      if ($LASTEXITCODE -ne 0) { throw "strict obs overlay validation reuse failed" }
      $ObservationValidationRunDir = $StrictValidationRunDir
      Write-Log "strict_obs_overlay_validation_reuse_done run_dir=$ObservationValidationRunDir"
    } else {
      $msg = "strict_obs_overlay_validation_reuse_skipped script_or_observations_missing validation_run_dir=$ValidationRunDir"
      if ($RequireStrictObsHistoryOverlay) { throw $msg }
      Write-Log ("WARN " + $msg)
    }
  }
} else {
  Write-Log "strict_obs_history_overlay_disabled=True"
}

$ObservationScript = Join-Path $PagesRepo "scripts\build_streamflow_observation_api.py"
if ((Test-Path $ObservationScript) -and (Test-Path (Join-Path $ObservationValidationRunDir "summary.json"))) {
Write-Log "build_observation_api validation_run_dir=$ObservationValidationRunDir"
if (Test-Path $CandidateBundleManifestJson) {
  Write-Log "candidate_bundle_manifest=$CandidateBundleManifestJson"
  $CandidateBundle = Get-Content -LiteralPath $CandidateBundleManifestJson -Raw | ConvertFrom-Json
  if ($CandidateBundle.candidateMetricsCsv) {
    $CandidateMetricsCsv = [string]$CandidateBundle.candidateMetricsCsv
  }
  if ($CandidateBundle.candidateManifestJson) {
    $CandidateManifestJson = [string]$CandidateBundle.candidateManifestJson
  }
  if ($CandidateBundle.candidateSkillClassesCsv) {
    $CandidateSkillClassesCsv = [string]$CandidateBundle.candidateSkillClassesCsv
  }
  if ($CandidateBundle.candidateLabel) {
    $CandidateLabel = [string]$CandidateBundle.candidateLabel
  }
}
$ObservationArgs = @(
    "--validation-run-dir", $ObservationValidationRunDir,
    "--output-dir", (Join-Path $ApiDir "observations"),
    "--shard-size", "50"
  )
  if (Test-Path $CandidateMetricsCsv) {
    Write-Log "observation_candidate_metrics=$CandidateMetricsCsv"
    $ObservationArgs += @("--candidate-metrics-csv", $CandidateMetricsCsv)
    $ObservationArgs += @("--candidate-metrics-split", $CandidateMetricsSplit)
    $ObservationArgs += @("--candidate-label", $CandidateLabel)
    if (Test-Path $CandidateManifestJson) {
      $ObservationArgs += @("--candidate-manifest-json", $CandidateManifestJson)
    } else {
      Write-Log "WARN candidate_manifest_missing path=$CandidateManifestJson"
    }
    if (Test-Path $CandidateSkillClassesCsv) {
      $ObservationArgs += @("--candidate-skill-classes-csv", $CandidateSkillClassesCsv)
    } else {
      Write-Log "WARN candidate_skill_classes_missing path=$CandidateSkillClassesCsv"
    }
  } else {
    Write-Log "WARN candidate_metrics_missing path=$CandidateMetricsCsv"
  }
  & $PythonExe $ObservationScript @ObservationArgs
  if ($LASTEXITCODE -ne 0) { throw "observation API builder failed" }
} else {
  Write-Log "WARN observation_api_skipped script_or_validation_missing validation_run_dir=$ObservationValidationRunDir"
}

Invoke-Git -C $PagesRepo config user.name "openhydronet-bot"
Invoke-Git -C $PagesRepo config user.email "openhydronet-bot@users.noreply.github.com"
Invoke-Git -C $PagesRepo remote set-url origin $RemoteUrl
Invoke-Git -C $PagesRepo add `
  "public/modules/streamflow-forecast/api" `
  "public/modules/streamflow-forecast/data/dashboard-data-state-current.json" `
  "module.json" `
  "public/module.json" `
  "public/modules/streamflow-forecast/module.json" `
  "public/modules/streamflow-forecast/index.js" `
  "README.md" `
  "scripts/build_openhydronet_dashboard.py" `
  "scripts/build_openhydronet_history_api.py" `
  "scripts/build_streamflow_observation_api.py" `
  "scripts/remote_backfill_openhydronet_history.ps1" `
  "scripts/remote_publish_openhydronet_latest.ps1"

$changed = & $GitExe -C $PagesRepo status --porcelain
if ($changed) {
  Invoke-Git -C $PagesRepo commit -m "Update OpenHydroNet operational forecast API"
  Write-Log "commit_created=True"
} else {
  Write-Log "commit_created=False"
}

if ($Push) {
  if (-not (Test-Path $DeployKey)) { throw "Deploy key missing: $DeployKey" }
  $env:GIT_SSH_COMMAND = "`"$SshExe`" -i `"$DeployKey`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  Write-Log "push_start"
  Invoke-Git -C $PagesRepo push origin $Branch
  Write-Log "push_done=True"

  Write-Log "pages_branch_publish_start"
  if (Test-Path -LiteralPath $PagesWorktree) {
    & $GitExe -C $PagesRepo worktree remove --force $PagesWorktree 2>$null | Out-Null
    if (Test-Path -LiteralPath $PagesWorktree) {
      Remove-Item -LiteralPath $PagesWorktree -Recurse -Force
    }
  }
  Invoke-Git -C $PagesRepo fetch origin gh-pages
  Invoke-Git -C $PagesRepo worktree add -B gh-pages $PagesWorktree origin/gh-pages
  Invoke-Git -C $PagesWorktree rm -r --ignore-unmatch .
  Get-ChildItem -LiteralPath (Join-Path $PagesRepo "public") -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $PagesWorktree -Recurse -Force
  }
  Invoke-Git -C $PagesWorktree add --all
  $pagesChanged = & $GitExe -C $PagesWorktree status --porcelain
  if ($pagesChanged) {
    Invoke-Git -C $PagesWorktree config user.name "openhydronet-bot"
    Invoke-Git -C $PagesWorktree config user.email "openhydronet-bot@users.noreply.github.com"
    Invoke-Git -C $PagesWorktree commit -m "Deploy OpenHydroNet forecast site"
    Invoke-Git -C $PagesWorktree push origin gh-pages
    Write-Log "pages_branch_publish_done=True"
  } else {
    Write-Log "pages_branch_publish_done=False no_changes"
  }
} else {
  Write-Log "push_skipped=True"
  if (Test-Path ($DeployKey + ".pub")) {
    Write-Log ("deploy_public_key=" + (Get-Content -LiteralPath ($DeployKey + ".pub") -Raw).Trim())
  }
}

Write-Log "DONE openhydronet_publish"
