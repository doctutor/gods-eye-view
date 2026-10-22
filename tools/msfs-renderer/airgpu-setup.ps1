# Personal fork: sets up a rented AirGPU machine (Nvidia A10G tier, Windows)
# as the GEV MSFS renderer. The AirGPU variant of user-data.ps1: run once
# by the user, from an elevated PowerShell inside the machine (over Parsec),
# and again whenever the machine is new or something failed. AirGPU
# supplies the NVIDIA driver and Parsec, so this only reports them.
#
#   powershell -ExecutionPolicy Bypass -File airgpu-setup.ps1 [-Branch local-fixes] [-BridgeSource C:\path\to\bridge] [-Root C:\gev]
#     [-ObsCodec hevc|h264] [-ObsCqp 18] [-ObsFps 60] [-ObsCanvas 3840x2160] [-ObsOutput 1920x1080]
#     [-ObsCapture game|display] [-SimExe FlightSimulator2024.exe]
#   powershell -ExecutionPolicy Bypass -File airgpu-setup.ps1 -ObsConfigOnly DIR   (the OBS files alone, into DIR)
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
  [string]$Root = 'C:\gev',
  # OBS's recording: the codec (NVENC HEVC, or H.264 where HEVC will not
  # do), its constant quality (CQP: lower is better and bigger), the frame
  # rate, the canvas (stills are this size) and the video's size as
  # WIDTHxHEIGHT (both the display's by default), and what is captured.
  [ValidateSet('hevc', 'h264')][string]$ObsCodec = 'hevc',
  [ValidateRange(1, 51)][int]$ObsCqp = 18,
  [ValidateSet(30, 60)][int]$ObsFps = 60,
  [string]$ObsCanvas = '',
  [string]$ObsOutput = '',
  [ValidateSet('game', 'display')][string]$ObsCapture = 'game',
  # MSFS 2024's executable, which Game Capture matches.
  [string]$SimExe = 'FlightSimulator2024.exe',
  # Write only the OBS files, into this folder as if it were
  # %APPDATA%\obs-studio (tests, or a look before a run).
  [string]$ObsConfigOnly = ''
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest crawls with its progress bar on.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- OBS: the WebSocket server, the GEV profile and the GEV scene ----------
#
# The formats are OBS 32.2.2's, from its sources: obs-websocket's
# plugin_config\obs-websocket\config.json (Config.cpp), user.ini's [Basic]
# Profile/ProfileDir/SceneCollection/SceneCollectionFile and [General]
# FirstRun (OBSApp.cpp; FirstRun stops the auto-configuration wizard), a
# profile's basic.ini and recordEncoder.json (AdvancedOutput.cpp, the
# obs-nvenc plugin), and a scene collection's JSON (libobs's obs-scene.c).
# All of it is written as UTF-8 without a byte-order mark: OBS's JSON
# readers refuse one.

# Write a file if its text differs; $true when it did.
function Set-FileText([string]$path, [string]$text) {
  if ((Test-Path -LiteralPath $path) -and ([IO.File]::ReadAllText($path) -ceq $text)) { return $false }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
  return $true
}

# An INI file's text with these values set (section => key => value),
# every other line kept as it was.
function Set-IniText([string]$text, [System.Collections.IDictionary]$values) {
  $lines = New-Object System.Collections.Generic.List[string]
  if ($text) { foreach ($line in ($text -split "`r?`n")) { $lines.Add($line) } }
  while ($lines.Count -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  foreach ($section in $values.Keys) {
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -eq "[$section]") { $start = $i; break } }
    if ($start -lt 0) {
      if ($lines.Count) { $lines.Add('') }
      $lines.Add("[$section]")
      $start = $lines.Count - 1
    }
    foreach ($key in $values[$section].Keys) {
      $end = $lines.Count
      for ($i = $start + 1; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim().StartsWith('[')) { $end = $i; break } }
      $line = "$key=$($values[$section][$key])"
      $found = $false
      for ($i = $start + 1; $i -lt $end; $i++) {
        if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") { $lines[$i] = $line; $found = $true; break }
      }
      if (-not $found) { $lines.Insert($end, $line) }
    }
  }
  return (($lines -join "`r`n") + "`r`n")
}

# The WebSocket password: kept in $file once made (24 letters and digits
# from the system's cryptographic generator), readable by this user only.
# Never printed.
function Get-ObsPassword([string]$file) {
  if (Test-Path -LiteralPath $file) {
    $kept = (Get-Content -LiteralPath $file -TotalCount 1)
    if ($kept -and $kept.Trim()) { return $kept.Trim() }
  }
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 24
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  $random.GetBytes($bytes)
  $random.Dispose()
  $password = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  Set-FileText $file $password | Out-Null
  & icacls.exe $file /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  return $password
}

# 'WxH' => @(W, H), each even (NV12 needs it).
function Get-Size([string]$text) {
  if ($text -notmatch '^(\d{3,5})x(\d{3,5})$') { throw "a size is WIDTHxHEIGHT, not $text" }
  return @(([int]$Matches[1] - [int]$Matches[1] % 2), ([int]$Matches[2] - [int]$Matches[2] % 2))
}

# The primary display's resolution in pixels (WMI's, not DPI-scaled).
function Get-DisplaySize() {
  $video = Get-CimInstance Win32_VideoController |
    Where-Object { $_.CurrentHorizontalResolution -gt 0 } | Select-Object -First 1
  if (-not $video) { return '1920x1080' }
  return "$($video.CurrentHorizontalResolution)x$($video.CurrentVerticalResolution)"
}

# The files that make OBS record as GEV wants, as path => text, under the
# obs-studio folder $obsRoot.
function Get-ObsFiles([string]$obsRoot, [string]$password, [hashtable]$o) {
  $canvas = Get-Size $o.Canvas
  $output = Get-Size $o.Output
  $hevc = $o.Codec -eq 'hevc'
  $encoder = if ($hevc) { 'obs_nvenc_hevc_tex' } else { 'obs_nvenc_h264_tex' }
  $files = [ordered]@{}

  $files[(Join-Path $obsRoot 'plugin_config\obs-websocket\config.json')] = (ConvertTo-Json -Depth 4 ([ordered]@{
        alerts_enabled  = $false
        auth_required   = $true
        first_load      = $false
        server_enabled  = $true
        server_password = $password
        server_port     = 4455
      }))

  $profileDir = Join-Path $obsRoot 'basic\profiles\GEV'
  $files[(Join-Path $profileDir 'basic.ini')] = Set-IniText '' ([ordered]@{
      General = [ordered]@{ Name = 'GEV' }
      Video   = [ordered]@{
        BaseCX = $canvas[0]; BaseCY = $canvas[1]; OutputCX = $output[0]; OutputCY = $output[1]
        FPSType = 0; FPSCommon = $o.Fps; ScaleType = 'lanczos'
        ColorFormat = 'NV12'; ColorSpace = '709'; ColorRange = 'Partial'
      }
      Output  = [ordered]@{ Mode = 'Advanced'; FilenameFormatting = 'gev_%CCYY-%MM-%DD_%hh-%mm-%ss' }
      AdvOut  = [ordered]@{
        RecType = 'Standard'; RecFilePath = $o.Recordings; RecFormat2 = 'hybrid_mp4'
        RecEncoder = $encoder; RecUseRescale = 'false'; RecTracks = 1; Encoder = $encoder
      }
    })
  # Constant quality (CQP): the same quantizer for every frame, so detail
  # does not drop when the view gets busy, at the cost of the file's size.
  $files[(Join-Path $profileDir 'recordEncoder.json')] = (ConvertTo-Json -Depth 4 ([ordered]@{
        rate_control = 'CQP'
        cqp          = $o.Cqp
        preset       = 'p5'
        tune         = 'hq'
        multipass    = 'qres'
        profile      = $(if ($hevc) { 'main' } else { 'high' })
        bf           = 2
        keyint_sec   = 2
      }))

  # The scene: MSFS's window by Game Capture, matched by its executable
  # (priority 2), over a Display Capture of the primary display, hidden
  # unless -Capture display. Both fill the canvas (bounds 2: scale inside).
  $gameName = 'MSFS 2024 (game capture)'
  $displayName = 'Display (fallback)'
  $item = {
    param([string]$name, [int]$id, [bool]$visible)
    [ordered]@{
      name = $name; id = $id; visible = $visible; locked = $false; rot = 0
      pos = [ordered]@{ x = 0; y = 0 }; scale = [ordered]@{ x = 1; y = 1 }; align = 5
      bounds_type = 2; bounds_align = 0; bounds = [ordered]@{ x = $canvas[0]; y = $canvas[1] }
      crop_left = 0; crop_top = 0; crop_right = 0; crop_bottom = 0
    }
  }
  $collection = [ordered]@{
    name                  = 'GEV'
    current_scene         = 'GEV'
    current_program_scene = 'GEV'
    current_transition    = 'Fade'
    transition_duration   = 300
    scene_order           = @([ordered]@{ name = 'GEV' })
    transitions           = @()
    DesktopAudioDevice1   = [ordered]@{ id = 'wasapi_output_capture'; name = 'Desktop Audio'; settings = [ordered]@{ device_id = 'default' } }
    sources               = @(
      [ordered]@{
        id = 'game_capture'; name = $gameName
        settings = [ordered]@{
          capture_mode = 'window'
          window = "Microsoft Flight Simulator 2024::$($o.SimExe)"
          priority = 2
          capture_cursor = $false
          allow_transparency = $false
          anti_cheat_hook = $true
          capture_overlays = $false
          limit_framerate = $false
        }
      },
      [ordered]@{
        id = 'monitor_capture'; name = $displayName
        settings = [ordered]@{ monitor_id = '\\.\DISPLAY1'; method = 0; capture_cursor = $false }
      },
      [ordered]@{
        id = 'scene'; name = 'GEV'
        settings = [ordered]@{
          id_counter = 2
          custom_size = $false
          items = @(
            (& $item $displayName 1 ($o.Capture -eq 'display')),
            (& $item $gameName 2 ($o.Capture -ne 'display'))
          )
        }
      }
    )
  }
  $files[(Join-Path $obsRoot 'basic\scenes\GEV.json')] = (ConvertTo-Json -Depth 10 $collection)
  return $files
}

# Every OBS file as it should be, user.ini (OBS's own, these keys set)
# included: path => text.
function Get-ObsWrites([string]$obsRoot, [string]$password, [hashtable]$o) {
  $files = Get-ObsFiles $obsRoot $password $o
  $userIni = Join-Path $obsRoot 'user.ini'
  $before = if (Test-Path -LiteralPath $userIni) { [IO.File]::ReadAllText($userIni) } else { '' }
  $files[$userIni] = Set-IniText $before ([ordered]@{
      General = [ordered]@{ FirstRun = 'true' }
      Basic   = [ordered]@{ Profile = 'GEV'; ProfileDir = 'GEV'; SceneCollection = 'GEV'; SceneCollectionFile = 'GEV' }
    })
  return $files
}

# OBS rewrites its files in its own layout as it exits, so they are not
# compared by their text: a stamp (the hash of what was last written, in
# gev-obs-stamp.txt) says whether the GEV files are as wanted, and user.ini
# is compared by its keys.
function Get-ObsStamp($writes, [string]$userIni) {
  $text = -join ($writes.Keys | Where-Object { $_ -ne $userIni } | ForEach-Object { "$_`n$($writes[$_])`n" })
  $sha = [Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))
  $sha.Dispose()
  return -join ($hash | ForEach-Object { $_.ToString('x2') })
}

# Whether the writes would change anything.
function Test-ObsStale([string]$obsRoot, $writes) {
  $userIni = Join-Path $obsRoot 'user.ini'
  foreach ($path in $writes.Keys) { if (-not (Test-Path -LiteralPath $path)) { return $true } }
  $before = [IO.File]::ReadAllText($userIni)
  if ((Set-IniText $before ([ordered]@{})) -cne $writes[$userIni]) { return $true }
  $stampFile = Join-Path $obsRoot 'gev-obs-stamp.txt'
  $stamp = if (Test-Path -LiteralPath $stampFile) { [IO.File]::ReadAllText($stampFile).Trim() } else { '' }
  return $stamp -ne (Get-ObsStamp $writes $userIni)
}

function Write-ObsFiles([string]$obsRoot, $writes) {
  foreach ($path in $writes.Keys) { Set-FileText $path $writes[$path] | Out-Null }
  Set-FileText (Join-Path $obsRoot 'gev-obs-stamp.txt') (Get-ObsStamp $writes (Join-Path $obsRoot 'user.ini')) | Out-Null
}

$obsOptions = @{
  Codec = $ObsCodec; Cqp = $ObsCqp; Fps = $ObsFps; SimExe = $SimExe; Capture = $ObsCapture
  Canvas = $(if ($ObsCanvas) { $ObsCanvas } else { Get-DisplaySize })
  Recordings = (Join-Path $Root 'recordings')
}
$obsOptions.Output = $(if ($ObsOutput) { $ObsOutput } else { $obsOptions.Canvas })

# -ObsConfigOnly DIR: the OBS files alone, into DIR as if it were
# %APPDATA%\obs-studio, its password in DIR\obs-websocket.txt (for tests and
# for a look before a run). Nothing else is touched.
if ($ObsConfigOnly) {
  $password = Get-ObsPassword (Join-Path $ObsConfigOnly 'obs-websocket.txt')
  $writes = Get-ObsWrites $ObsConfigOnly $password $obsOptions
  $stale = Test-ObsStale $ObsConfigOnly $writes
  if ($stale) { Write-ObsFiles $ObsConfigOnly $writes }
  Write-Output "OBS files in $($ObsConfigOnly): $(if ($stale) { 'written' } else { 'unchanged' }); canvas $($obsOptions.Canvas), output $($obsOptions.Output), $($obsOptions.Codec) CQP $($obsOptions.Cqp) at $($obsOptions.Fps) fps"
  exit 0
}

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
  Write-Host "$repository $($release.tag_name): $($asset.name)"
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
  # Write-Host, not Write-Output: output here would join the returned path.
  Write-Host ".NET $($release.$part.version): $([IO.Path]::GetFileName($file.url))"
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

Step 'Streaming host (AirGPU supplies it; reported, not installed)' {
  # AirGPU streams with Moonlight (Sunshine on the machine), not Parsec.
  $hosts = @(Get-Process -Name sunshine, parsecd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name -Unique)
  if ($hosts.Count -eq 0) { Write-Output 'no Sunshine or Parsec process seen; the stream you are reading this over is AirGPU''s' }
  else { Write-Output "streaming host: $($hosts -join ', ')" }
}

Step 'Windows Audio service (the stream carries the sound)' {
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
  if ($sdk) {
    $arguments += "-p:MsfsSdk=$sdk"
    Write-Output "MSFS 2024 SDK: $sdk"
    # The bridge reads the camera API's values from the SDK's SimConnect.h at
    # run time; a machine-wide MSFS2024_SDK saves the --sdk flag in new shells.
    if ([Environment]::GetEnvironmentVariable('MSFS2024_SDK', 'Machine') -ne $sdk) {
      [Environment]::SetEnvironmentVariable('MSFS2024_SDK', $sdk, 'Machine')
      Write-Output 'MSFS2024_SDK set machine-wide (new shells see it)'
    }
  }
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

# OBS set up for GEV with no hand steps: its WebSocket server on 4455 with a
# password made here once (in $Root\obs-websocket.txt, which the bridge
# reads; never printed), the GEV profile (NVENC, constant quality, the
# canvas and frame rate, timestamped files in $Root\recordings) and the GEV
# scene (MSFS's window). OBS rewrites its files when it exits, so a running
# OBS is closed first, then started again minimised to the tray. Nothing
# changes when everything is already so.
Step 'OBS: WebSocket, GEV profile and scene' {
  $obsExe = Join-Path $Env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'
  if (-not (Test-Path $obsExe)) { throw 'OBS is not installed' }
  $obsRoot = Join-Path $Env:APPDATA 'obs-studio'
  $password = Get-ObsPassword (Join-Path $Root 'obs-websocket.txt')
  $writes = Get-ObsWrites $obsRoot $password $obsOptions
  $running = @(Get-Process -Name obs64 -ErrorAction SilentlyContinue)
  if (Test-ObsStale $obsRoot $writes) {
    if ($running.Count) {
      foreach ($process in $running) { [void]$process.CloseMainWindow() }
      $running | Wait-Process -Timeout 20 -ErrorAction SilentlyContinue
      $left = @(Get-Process -Name obs64 -ErrorAction SilentlyContinue)
      if ($left.Count) {
        # In the tray it has no window to close. A forced stop leaves OBS's
        # crash marker, whose dialog would offer Safe Mode (no WebSocket).
        $left | Stop-Process -Force
        Start-Sleep -Seconds 2
        Remove-Item -Path (Join-Path $obsRoot '.sentinel\run_*') -Force -ErrorAction SilentlyContinue
        Write-Output 'OBS did not close by itself: stopped, and its crash marker cleared'
      } else { Write-Output 'OBS closed' }
      # It saves user.ini as it exits: read it again.
      $writes = Get-ObsWrites $obsRoot $password $obsOptions
    }
    Write-ObsFiles $obsRoot $writes
    Write-Output "OBS files written: canvas $($obsOptions.Canvas), output $($obsOptions.Output), $($obsOptions.Codec) CQP $($obsOptions.Cqp) at $($obsOptions.Fps) fps, $($obsOptions.Capture) capture of $($obsOptions.SimExe)"
  } else { Write-Output 'OBS files already so' }
  if (-not (Get-Process -Name obs64 -ErrorAction SilentlyContinue)) {
    # From its own folder: OBS finds its locale and plugins from there.
    Start-Process -FilePath $obsExe -WorkingDirectory (Split-Path $obsExe) -ArgumentList '--profile', 'GEV', '--collection', 'GEV', '--minimize-to-tray', '--disable-updater'
    Write-Output 'OBS started, minimised to the tray'
  }
  $until = (Get-Date).AddSeconds(45)
  do {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', 4455); $listening = $client.Connected } catch { $listening = $false } finally { $client.Close() }
    if (-not $listening) { Start-Sleep -Seconds 2 }
  } until ($listening -or (Get-Date) -gt $until)
  if (-not $listening) { throw 'OBS is not listening on 4455 after 45 s' }
  Write-Output 'OBS WebSocket listening on 4455; its password is in the file the bridge reads'
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
  4. OBS is set up and running in the tray (profile and scene GEV); the bridge reads its password from $(Join-Path $Root 'obs-websocket.txt').
  5. powershell -ExecutionPolicy Bypass -File airgpu-smoke.ps1
  6. Copy a camera path (npm run msfs:path on the PC) into $(Join-Path $Root 'paths') and run $(Join-Path $Root 'bridge\gev-bridge.exe') <path.json> --record (or --stills for PNGs at the waypoints).
Nothing here outlives the machine: when AirGPU's machine goes, so does all of this.
"@
Stop-Transcript
