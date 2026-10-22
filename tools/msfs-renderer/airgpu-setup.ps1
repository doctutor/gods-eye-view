# Personal fork: sets up a rented AirGPU machine (Nvidia A10G tier, Windows)
# as the GEV MSFS renderer. The AirGPU variant of user-data.ps1: run once
# by the user, from an elevated PowerShell inside the machine (over Parsec),
# and again whenever the machine is new or something failed. AirGPU
# supplies the NVIDIA driver and Parsec, so this only reports them.
#
#   powershell -ExecutionPolicy Bypass -File airgpu-setup.ps1 [-Branch local-fixes] [-BridgeSource C:\path\to\bridge] [-Root C:\gev]
#
# Each step logs and carries on if it fails; the summary at the end lists
# the failed ones. A step whose program is already there skips it, so a
# re-run is harmless. It asks for no credential and stores none: Steam's
# sign-in and the MSFS 2024 purchase are the user's, in the Steam window it
# opens at the end. Log: C:\gev-provision.log. See README.md, "AirGPU
# (opportunistic)". Not part of upstream God's Eye View.

param(
  # The fork's branch the bridge's source is read from (pushed first).
  [string]$Branch = 'local-fixes',
  # A folder holding the bridge's source instead (copied in by hand).
  [string]$BridgeSource = '',
  # Where the bridge, the camera paths and the recordings go.
  [string]$Root = 'C:\gev'
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest crawls with its progress bar on.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'Run this from an elevated PowerShell (Run as administrator).'
  exit 2
}

Start-Transcript -Path 'C:\gev-provision.log' -Append
$work = 'C:\gev-provision'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$failed = @()
$restart = $false
$repo = 'doctutor/gods-eye-view'

function Step([string]$name, [scriptblock]$body) {
  Write-Output "=== $(Get-Date -Format s) $($name)"
  try {
    & $body
    Write-Output "--- ok: $($name)"
  } catch {
    $script:failed += $name
    Write-Output "!!! failed: $($name): $($_.Exception.Message)"
  }
}

function Download([string]$url, [string]$file) {
  $path = Join-Path $work $file
  Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
  return $path
}

function Install([string]$path, [string[]]$arguments) {
  $process = Start-Process -FilePath $path -ArgumentList $arguments -Wait -PassThru
  # 3010: done, a restart is needed.
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "$path exited with $($process.ExitCode)"
  }
  if ($process.ExitCode -eq 3010) { Write-Output 'the installer asks for a restart' }
}

function LatestGitHubAsset([string]$repository, [string]$pattern) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" -Headers @{ 'User-Agent' = 'gev-msfs-renderer' }
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { throw "no asset matching $pattern in $repository $($release.tag_name)" }
  Write-Output "$repository $($release.tag_name): $($asset.name)"
  return $asset
}

# An installed program's version from its uninstall entry, or $null.
function InstalledVersion([string]$displayName) {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entry = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like $displayName } | Select-Object -First 1
  if ($entry) { return [string]$entry.DisplayVersion }
  return $null
}

function NvidiaSmi() {
  $command = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $found = Get-ChildItem -Path C:\Windows\System32\DriverStore\FileRepository -Recurse -Filter nvidia-smi.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

# The .NET 8 installers from Microsoft's release metadata, checked against
# its SHA-512.
function DotnetInstaller([string]$part, [string]$name) {
  $releases = Invoke-RestMethod -Uri 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json' -UseBasicParsing
  $release = $releases.releases | Select-Object -First 1
  $file = $release.$part.files | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if (-not $file) { throw "no $name in .NET $($release.'release-version')" }
  $path = Download $file.url ([IO.Path]::GetFileName($file.url))
  $hash = (Get-FileHash -Path $path -Algorithm SHA512).Hash
  if ($hash -ne $file.hash.ToUpper()) { throw "$name does not match its SHA-512" }
  Write-Output ".NET $($release.$part.version): $([IO.Path]::GetFileName($file.url))"
  return $path
}

function DotnetList([string]$what) {
  $dotnet = Join-Path $Env:ProgramFiles 'dotnet\dotnet.exe'
  if (-not (Test-Path $dotnet)) { return @() }
  return @(& $dotnet $what)
}

Step 'NVIDIA driver (AirGPU supplies it; reported, not installed)' {
  $smi = NvidiaSmi
  if ($smi) {
    & $smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
  } else {
    Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name), driver $($_.DriverVersion)" }
    throw 'nvidia-smi not found: ask AirGPU, the driver is theirs'
  }
}

Step 'Parsec (AirGPU supplies it; reported, not installed)' {
  $version = InstalledVersion 'Parsec*'
  $running = Get-Process -Name parsecd -ErrorAction SilentlyContinue
  if (-not $version -and -not $running) { throw 'Parsec not found: it is AirGPU''s, not this script''s' }
  Write-Output "Parsec $(if ($version) { $version } else { '(version not listed)' }), $(if ($running) { 'running' } else { 'not running' })"
}

Step 'Windows Audio service (Parsec streams the sound)' {
  $audio = Get-Service -Name 'Audiosrv'
  if ($audio.StartType -ne 'Automatic') { Set-Service -Name 'Audiosrv' -StartupType Automatic }
  if ($audio.Status -ne 'Running') { Start-Service -Name 'Audiosrv' }
}

# Windows Server (AirGPU's image is Server 2025) leaves Media Foundation
# out; games and OBS's capture often need it. A feature install needs one
# restart, said here and in the summary; Windows 10 and 11 have it built in.
Step 'Media Foundation (Windows Server only)' {
  if (-not (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue)) { Write-Output 'not Windows Server: built in'; return }
  $feature = Get-WindowsFeature -Name 'Server-Media-Foundation'
  if (-not $feature) { throw 'no Server-Media-Foundation feature on this edition' }
  if ($feature.Installed) { Write-Output 'already installed'; return }
  $result = Install-WindowsFeature -Name 'Server-Media-Foundation'
  if (-not $result.Success) { throw "Install-WindowsFeature: $($result.ExitCode)" }
  if ($result.RestartNeeded -ne 'No') { $script:restart = $true; Write-Output 'installed; restart Windows once before starting the sim' }
}

Step 'Steam' {
  $steam = Join-Path ${Env:ProgramFiles(x86)} 'Steam\steam.exe'
  if (Test-Path $steam) { Write-Output 'already installed'; return }
  Install (Download 'https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe' 'SteamSetup.exe') @('/S')
}

# OBS 28 and later carry obs-websocket v5, the protocol the bridge speaks;
# no separate plugin. Its server is enabled, with a password, in OBS.
Step 'OBS Studio' {
  $obs = Join-Path $Env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'
  if (-not (Test-Path $obs)) {
    $asset = LatestGitHubAsset 'obsproject/obs-studio' '-Windows-x64-Installer\.exe$'
    Install (Download $asset.browser_download_url $asset.name) @('/S')
  } else { Write-Output 'already installed' }
  $version = (Get-Item $obs).VersionInfo.ProductVersion
  Write-Output "OBS $version"
  if ([version]($version -replace '[^\d.].*$', '') -lt [version]'28.0') { throw "OBS $version has no built-in websocket v5: update it" }
}

Step '7-Zip' {
  if (Test-Path (Join-Path $Env:ProgramFiles '7-Zip\7z.exe')) { Write-Output 'already installed'; return }
  $asset = LatestGitHubAsset 'ip7z/7zip' '^7z\d+-x64\.exe$'
  Install (Download $asset.browser_download_url $asset.name) @('/S')
}

# The Desktop Runtime runs the bridge; the SDK builds it here (nothing of
# it is built on the PC the path comes from).
Step '.NET 8 (Desktop Runtime and SDK)' {
  if (DotnetList '--list-runtimes' | Where-Object { $_ -match '^Microsoft\.WindowsDesktop\.App 8\.' }) {
    Write-Output 'Desktop Runtime 8 already installed'
  } else {
    Install (DotnetInstaller 'windowsdesktop' 'windowsdesktop-runtime-win-x64.exe') @('/install', '/quiet', '/norestart')
  }
  if (DotnetList '--list-sdks' | Where-Object { $_ -match '^8\.' }) {
    Write-Output 'SDK 8 already installed'
  } else {
    Install (DotnetInstaller 'sdk' 'dotnet-sdk-win-x64.exe') @('/install', '/quiet', '/norestart')
  }
}

# The bridge's source from the fork on GitHub (the branch must be pushed),
# or from -BridgeSource, built framework-dependent into $Root\bridge. With
# the MSFS 2024 SDK installed (from inside the sim), SimConnect.dll is
# copied beside it: re-run this script once the SDK is there.
Step 'GEV bridge' {
  $source = Join-Path $work 'bridge-src'
  if ($BridgeSource) {
    if (-not (Test-Path (Join-Path $BridgeSource 'GevBridge.csproj'))) { throw "no GevBridge.csproj in $BridgeSource" }
    $source = $BridgeSource
  } else {
    if (Test-Path $source) { Remove-Item -Recurse -Force $source }
    New-Item -ItemType Directory -Force -Path $source | Out-Null
    $listing = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/tools/msfs-renderer/bridge?ref=$Branch" -Headers @{ 'User-Agent' = 'gev-msfs-renderer' }
    foreach ($entry in $listing) {
      if ($entry.type -eq 'file') {
        Invoke-WebRequest -Uri $entry.download_url -OutFile (Join-Path $source $entry.name) -UseBasicParsing
      }
    }
    Write-Output "source: $repo $Branch, $(@($listing).Count) files"
  }
  $sdk = @($Env:MSFS2024_SDK, $Env:MSFS_SDK, 'C:\MSFS 2024 SDK') |
    Where-Object { $_ -and (Test-Path (Join-Path $_ 'SimConnect SDK\lib\SimConnect.dll')) } | Select-Object -First 1
  $out = Join-Path $Root 'bridge'
  $arguments = @('publish', (Join-Path $source 'GevBridge.csproj'), '-c', 'Release', '-o', $out, '--nologo')
  if ($sdk) { $arguments += "-p:MsfsSdk=$sdk"; Write-Output "MSFS 2024 SDK: $sdk" }
  else { Write-Output 'no MSFS 2024 SDK yet: --dry-run works; re-run after installing the SDK' }
  & (Join-Path $Env:ProgramFiles 'dotnet\dotnet.exe') @arguments
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish exited with $LASTEXITCODE" }
  Write-Output "bridge: $(Join-Path $out 'gev-bridge.exe')"
}

Step 'Camera path and recording folders' {
  foreach ($name in @('paths', 'recordings')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $name) | Out-Null
  }
  Write-Output "camera paths: $(Join-Path $Root 'paths'); recordings: $(Join-Path $Root 'recordings')"
}

# Started through Explorer so Steam runs as the signed-in user, not
# elevated.
Step 'Open Steam' {
  $steam = Join-Path ${Env:ProgramFiles(x86)} 'Steam\steam.exe'
  if (-not (Test-Path $steam)) { throw 'Steam is not installed' }
  Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$steam`""
}

Write-Output "=== $(Get-Date -Format s) setup finished; failed steps: $(if ($failed.Count) { $failed -join ', ' } else { 'none' })"
if ($restart) { Write-Output 'Restart Windows once (Media Foundation) before starting MSFS 2024; Parsec reconnects after it.' }
Write-Output @"
Next, by hand:
  1. Steam: sign in (Steam Guard) and install Microsoft Flight Simulator 2024 from your library.
  2. In the sim: Options > General Options > Developers > Developer Mode on; Help > SDK Installer for the MSFS 2024 SDK.
  3. Re-run this script once, so the bridge is built with SimConnect.dll.
  4. OBS: Tools > WebSocket Server Settings, enable the server (port 4455) with a password; set `$env:OBS_WEBSOCKET_PASSWORD in the shell that runs the bridge.
  5. powershell -ExecutionPolicy Bypass -File airgpu-smoke.ps1
  6. Copy a camera path (npm run msfs:path on the PC) into $(Join-Path $Root 'paths') and run $(Join-Path $Root 'bridge\gev-bridge.exe') <path.json> --record.
Nothing here outlives the machine: when AirGPU's machine goes, so does all of this.
"@
Stop-Transcript
