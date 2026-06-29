param(
  [string]$OpenHydroNetRoot = "D:\OpenHydroNet_FloodHub_Operational",
  [string]$PagesRepo = "D:\LSTM-Global",
  [string]$StartDate = "20260531",
  [string]$EndDate = "20260629",
  [int]$HistoryDays = 30,
  [switch]$Push
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Runner = Join-Path $OpenHydroNetRoot "tools\remote_run_openhydronet_full_operational.ps1"
$Publisher = Join-Path $PagesRepo "scripts\remote_publish_openhydronet_latest.ps1"
$HistoryRoot = Join-Path $OpenHydroNetRoot "outputs\api\history"
$LogDir = Join-Path $OpenHydroNetRoot "logs\lstm_global_history_backfill"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogPath = Join-Path $LogDir ("backfill_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".log")

function Write-Log {
  param([string]$Message)
  $line = "$(Get-Date -Format s) $Message"
  Write-Output $line
  Add-Content -Encoding UTF8 -Path $LogPath -Value $line
}

function Parse-Date {
  param([string]$DateText)
  return [datetime]::ParseExact($DateText, "yyyyMMdd", [Globalization.CultureInfo]::InvariantCulture)
}

function Copy-Latest-To-History {
  param([string]$IssueDateIso)
  $source = Join-Path $OpenHydroNetRoot "outputs\api\latest\static"
  $target = Join-Path (Join-Path $HistoryRoot $IssueDateIso) "static"
  if (-not (Test-Path (Join-Path $source "latest.json"))) {
    throw "latest static API missing under $source"
  }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem -LiteralPath $source -Filter "*.json" | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $_.Name) -Force
  }
}

function Invoke-LoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$ProcessLog
  )
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments *>&1 |
      Tee-Object -FilePath $ProcessLog |
      Add-Content -Encoding UTF8 -Path $LogPath
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($null -eq $code) { $code = 0 }
  return $code
}

if (-not (Test-Path $Runner)) { throw "Runner missing: $Runner" }
if (-not (Test-Path $Publisher)) { throw "Publisher missing: $Publisher" }

$start = Parse-Date $StartDate
$end = Parse-Date $EndDate
if ($end -lt $start) { throw "EndDate is before StartDate" }

$dates = @()
for ($date = $start; $date -le $end; $date = $date.AddDays(1)) {
  $dates += $date
}

Write-Log "START backfill start=$StartDate end=$EndDate count=$($dates.Count)"
$index = 0
foreach ($date in $dates) {
  $index += 1
  $issueDate = $date.ToString("yyyyMMdd")
  $issueIso = $date.ToString("yyyy-MM-dd")
  $existing = Join-Path (Join-Path $HistoryRoot $issueIso) "static\latest.json"
  if (Test-Path -LiteralPath $existing) {
    Write-Log "SKIP existing issue=$issueIso progress=$index/$($dates.Count)"
    continue
  }

  $started = Get-Date
  Write-Log "RUN issue=$issueDate progress=$index/$($dates.Count)"
  $code = Invoke-LoggedProcess `
    -FilePath "powershell.exe" `
    -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Runner, "-ProjectRoot", $OpenHydroNetRoot, "-IssueDate", $issueDate) `
    -ProcessLog (Join-Path $LogDir "issue_${issueDate}.log")
  if ($code -ne 0) { throw "Issue $issueDate failed with exit code $code" }
  Copy-Latest-To-History -IssueDateIso $issueIso
  $elapsed = [math]::Round(((Get-Date) - $started).TotalMinutes, 2)
  $remaining = $dates.Count - $index
  Write-Log "DONE issue=$issueIso minutes=$elapsed remaining=$remaining"
}

Write-Log "PUBLISH rolling history"
$publishArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-File", $Publisher,
  "-SkipPull",
  "-HistoryDays", "$HistoryDays"
)
if ($Push) { $publishArgs += "-Push" }
$publishCode = Invoke-LoggedProcess `
  -FilePath "powershell.exe" `
  -Arguments $publishArgs `
  -ProcessLog (Join-Path $LogDir "publish_final.log")
if ($publishCode -ne 0) { throw "Final publish failed with exit code $publishCode" }
Write-Log "DONE backfill"
