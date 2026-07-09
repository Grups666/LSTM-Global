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
  [string]$ValidationRunDir = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\validation\public_streamflow_daily\latest",
  [string]$CandidateMetricsCsv = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\gate_balanced_vs_hightail_m0_writepred_20260709\gate_balanced_vs_hightail_m0_lead12\basin_lead_metrics.csv",
  [string]$CandidateManifestJson = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\gate_balanced_vs_hightail_m0_writepred_20260709\gate_balanced_vs_hightail_m0_lead12\manifest.json",
  [string]$CandidateSkillClassesCsv = "D:\SSH\Hydrological_Forecasting_DL\local\outputs\strict_obs_posttrain\gate_balanced_vs_hightail_m0_writepred_20260709\gate_balanced_vs_hightail_m0_lead12_basin_skill_classes.csv",
  [string]$CandidateLabel = "Strict obs balanced/high-tail validation gate lead1-2",
  [string]$CandidateMetricsSplit = "test",
  [int]$HistoryDays = 30,
  [switch]$SkipPull,
  [switch]$Push
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

$ObservationScript = Join-Path $PagesRepo "scripts\build_streamflow_observation_api.py"
if ((Test-Path $ObservationScript) -and (Test-Path (Join-Path $ValidationRunDir "summary.json"))) {
  Write-Log "build_observation_api validation_run_dir=$ValidationRunDir"
  $ObservationArgs = @(
    "--validation-run-dir", $ValidationRunDir,
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
  Write-Log "WARN observation_api_skipped script_or_validation_missing validation_run_dir=$ValidationRunDir"
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
