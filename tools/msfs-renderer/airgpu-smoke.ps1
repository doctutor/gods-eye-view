# Personal fork: a one-screen check of an AirGPU machine set up by
# airgpu-setup.ps1: the GPU, Parsec, OBS's websocket, the bridge's dry run,
# the MSFS 2024 SDK and the free disk. Changes nothing. Exit 0 with no FAIL,
# 1 otherwise. See README.md, "AirGPU (opportunistic)". Not part of
# upstream God's Eye View.
#
#   powershell -ExecutionPolicy Bypass -File airgpu-smoke.ps1 [-Root C:\gev] [-ObsPort 4455] [-MinFreeGB 60]

param(
  [string]$Root = 'C:\gev',
  [int]$ObsPort = 4455,
  # MSFS 2024's base install is about 50 GB; recordings need room too.
  [int]$MinFreeGB = 60
)

$ErrorActionPreference = 'Stop'
$results = New-Object System.Collections.ArrayList

function Check([string]$name, [scriptblock]$body) {
  try {
    $answer = & $body
    $level = $answer[0]
    $detail = $answer[1]
  } catch {
    $level = 'FAIL'
    $detail = $_.Exception.Message
  }
  [void]$results.Add([pscustomobject]@{ Result = $level; Check = $name; Detail = $detail })
}

Check 'GPU' {
  $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if (-not $smi) { return @('FAIL', 'nvidia-smi not found (the driver is AirGPU''s)') }
  $line = (& $smi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader | Select-Object -First 1)
  if ($line -match 'A10G') { return @('PASS', $line) }
  return @('WARN', "$line (not the A10G tier)")
}

Check 'Parsec' {
  if (Get-Process -Name parsecd -ErrorAction SilentlyContinue) { return @('PASS', 'parsecd running') }
  return @('WARN', 'parsecd not running (AirGPU''s; this session may be another way in)')
}

Check 'OBS websocket' {
  $obs = Join-Path $Env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'
  if (-not (Test-Path $obs)) { return @('FAIL', 'OBS not installed: run airgpu-setup.ps1') }
  $version = (Get-Item $obs).VersionInfo.ProductVersion
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect('127.0.0.1', $ObsPort, $null, $null)
    if ($wait.AsyncWaitHandle.WaitOne(2000) -and $client.Connected) {
      return @('PASS', "OBS $version, listening on $ObsPort")
    }
  } finally { $client.Close() }
  return @('FAIL', "OBS $version, nothing on port $($ObsPort): open OBS, Tools > WebSocket Server Settings")
}

Check 'Bridge dry run' {
  $bridge = Join-Path $Root 'bridge\gev-bridge.exe'
  if (-not (Test-Path $bridge)) { return @('FAIL', "no $($bridge): run airgpu-setup.ps1") }
  # Two samples a second apart over Baltimore.
  $path = Join-Path $Env:TEMP 'gev-smoke-path.json'
  Set-Content -Path $path -Encoding ascii -Value '{"version":1,"fps":30,"samples":[{"t":0,"lat":39.29,"lon":-76.61,"alt_m":300,"heading_deg":0,"pitch_deg":0,"bank_deg":0,"fov_deg":60},{"t":1,"lat":39.291,"lon":-76.61,"alt_m":300,"heading_deg":0,"pitch_deg":0,"bank_deg":0,"fov_deg":60}]}'
  $output = & $bridge $path --dry-run --fast 2>&1
  $code = $LASTEXITCODE
  Remove-Item -Path $path -Force -ErrorAction SilentlyContinue
  if ($code -ne 0) { return @('FAIL', "exit $($code): $(($output | Select-Object -Last 1))") }
  $simconnect = Test-Path (Join-Path $Root 'bridge\SimConnect.dll')
  if ($simconnect) { return @('PASS', 'dry run ok; SimConnect.dll beside it') }
  return @('WARN', 'dry run ok; no SimConnect.dll yet (install the SDK, re-run setup)')
}

Check 'MSFS 2024 SDK' {
  $sdk = @($Env:MSFS2024_SDK, $Env:MSFS_SDK, 'C:\MSFS 2024 SDK') |
    Where-Object { $_ -and (Test-Path (Join-Path $_ 'SimConnect SDK\include\SimConnect.h')) } | Select-Object -First 1
  if ($sdk) { return @('PASS', $sdk) }
  return @('WARN', 'not found: in the sim, Developer Mode, Help > SDK Installer')
}

Check 'Disk' {
  $drives = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'
  $text = ($drives | ForEach-Object { "$($_.DeviceID) $([math]::Round($_.FreeSpace / 1GB)) GB free" }) -join ', '
  $most = ($drives | Measure-Object -Property FreeSpace -Maximum).Maximum / 1GB
  if ($most -ge $MinFreeGB) { return @('PASS', $text) }
  return @('WARN', "$text (under $MinFreeGB GB on every disk)")
}

Write-Output ''
Write-Output 'GEV MSFS renderer on AirGPU'
$results | Format-Table -AutoSize -Wrap | Out-String -Width 120 | Write-Output
$fails = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Output "$fails failed, $(@($results | Where-Object { $_.Result -eq 'WARN' }).Count) to look at"
if ($fails) { exit 1 }
exit 0
