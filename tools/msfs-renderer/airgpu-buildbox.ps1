# Personal fork: turns a rented AirGPU machine into a temporary build runner
# for GEV's RAM-heavy data builds (32 GB, a datacenter's bandwidth for the
# dump downloads). Run by the user from an elevated PowerShell inside the
# machine (over Parsec). Nothing here outlives the machine. See README.md,
# "AirGPU (opportunistic)". Not part of upstream God's Eye View.
#
#   powershell -ExecutionPolicy Bypass -File airgpu-buildbox.ps1 [-Branch local-fixes] [-Root C:\gev]
#   powershell -ExecutionPolicy Bypass -File airgpu-buildbox.ps1 -Package
#   powershell -ExecutionPolicy Bypass -File airgpu-buildbox.ps1 -Serve C:\gev\out\<zip> -AllowFrom <your PC's public IPv4>
#
# The default run installs Git and Node.js 24 (this PC's major), clones the
# public fork's branch (pushed first; no token, nothing signed in) and runs
# npm ci. It copies nothing up: no .env, no key, and the builds run here
# are the keyless ones. -Package zips the Wikipedia points build's output
# (the only thing to bring back); -Serve hands that zip out once over HTTP
# to one address (airgpu-serve.mjs). Re-running is harmless. Log:
# C:\gev-buildbox.log.

param(
  [string]$Branch = 'local-fixes',
  [string]$Root = 'C:\gev',
  [switch]$Package,
  [string]$Serve = '',
  [string]$AllowFrom = '',
  [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'Run this from an elevated PowerShell (Run as administrator).'
  exit 2
}

$repoUrl = 'https://github.com/doctutor/gods-eye-view.git'
$checkout = Join-Path $Root 'repo'
$work = 'C:\gev-provision'
New-Item -ItemType Directory -Force -Path $work | Out-Null

function RefreshPath() {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# -Package: the Wikipedia points, zipped, with the SHA-256 to compare on the PC.
if ($Package) {
  $points = Join-Path $Root 'cache\wikipedia\points'
  if (-not (Test-Path $points)) { Write-Output "no $($points): run the Wikipedia points build first"; exit 1 }
  $outDir = Join-Path $Root 'out'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $zip = Join-Path $outDir "wikipedia-points-$(Get-Date -Format yyyyMMdd-HHmmss).zip"
  Compress-Archive -Path (Join-Path $points '*') -DestinationPath $zip
  Write-Output "$zip, $([math]::Round((Get-Item $zip).Length / 1MB)) MB"
  Write-Output "SHA-256 $((Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower())"
  exit 0
}

# -Serve: the zip, once, to one address; the firewall rule goes when it ends.
if ($Serve) {
  if (-not (Test-Path $Serve -PathType Leaf)) { Write-Output "no file $Serve"; exit 1 }
  if ($AllowFrom -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Write-Output '-AllowFrom takes your PC''s public IPv4 address (checkip.amazonaws.com shows it)'; exit 2 }
  RefreshPath
  $rule = 'gev-serve-once'
  Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $AllowFrom -Action Allow | Out-Null
  try {
    & node (Join-Path $checkout 'tools\msfs-renderer\airgpu-serve.mjs') $Serve --port $Port
  } finally {
    Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
    Write-Output "firewall rule $rule removed"
  }
  exit $LASTEXITCODE
}

Start-Transcript -Path 'C:\gev-buildbox.log' -Append
$failed = @()

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
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "$path exited with $($process.ExitCode)"
  }
}

Step 'Git' {
  RefreshPath
  if (Get-Command git.exe -ErrorAction SilentlyContinue) { & git --version; return }
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'gev-msfs-renderer' }
  $asset = $release.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw "no 64-bit installer in Git for Windows $($release.tag_name)" }
  Write-Output "Git for Windows $($release.tag_name): $($asset.name)"
  Install (Download $asset.browser_download_url $asset.name) @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-')
  RefreshPath
  & git --version
}

# The latest 24.x from nodejs.org, checked against its SHASUMS256.txt.
Step 'Node.js 24' {
  RefreshPath
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($node -and ((& node --version) -match '^v24\.')) { & node --version; return }
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $version = ($index | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1).version
  if (-not $version) { throw 'no Node.js 24 in nodejs.org/dist/index.json' }
  $name = "node-$version-x64.msi"
  $msi = Download "https://nodejs.org/dist/$version/$name" $name
  $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
  $expected = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($name))$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
  if (-not $expected -or (Get-FileHash -Path $msi -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw "$name does not match SHASUMS256.txt" }
  Install 'msiexec.exe' @('/i', "`"$msi`"", '/qn', '/norestart')
  RefreshPath
  & node --version
}

# The public fork, read-only: no token, no sign-in. The branch must be on
# GitHub (git push fork local-fixes on the PC first).
Step 'GEV checkout' {
  RefreshPath
  if (Test-Path (Join-Path $checkout '.git')) {
    & git -C $checkout fetch origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch exited with $LASTEXITCODE" }
    & git -C $checkout checkout $Branch
    & git -C $checkout merge --ff-only "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { throw "the checkout has local changes or diverged: $checkout" }
  } else {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    & git clone --branch $Branch --single-branch $repoUrl $checkout
    if ($LASTEXITCODE -ne 0) { throw "git clone exited with $LASTEXITCODE (is $Branch pushed?)" }
  }
  & git -C $checkout log --oneline -1
}

Step 'npm ci' {
  RefreshPath
  Push-Location $checkout
  try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci exited with $LASTEXITCODE" }
  } finally { Pop-Location }
}

Step 'Build folders' {
  foreach ($name in @('raw', 'cache', 'out')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $name) | Out-Null
  }
}

Write-Output "=== $(Get-Date -Format s) build box ready; failed steps: $(if ($failed.Count) { $failed -join ', ' } else { 'none' })"
Write-Output @"
The multi-wiki Wikipedia points build, in a new PowerShell:
  cd $checkout
  `$env:GEV_RAW_DIR = '$(Join-Path $Root 'raw')'
  `$env:WIKIPEDIA_COVERAGE_DIR = '$(Join-Path $Root 'cache\wikipedia')'
  npm run wikipedia:build -- --points --wikis enwiki,dewiki,frwiki,eswiki,ruwiki,jawiki,zhwiki,itwiki,ptwiki,plwiki,nlwiki
Then bring back only the points:
  powershell -ExecutionPolicy Bypass -File $(Join-Path $checkout 'tools\msfs-renderer\airgpu-buildbox.ps1') -Package
  powershell -ExecutionPolicy Bypass -File $(Join-Path $checkout 'tools\msfs-renderer\airgpu-buildbox.ps1') -Serve <the zip> -AllowFrom <your PC's public IPv4>
Keyless builds only: no .env comes here. --population (Earth Engine) and the census build need keys; run those on the PC.
"@
Stop-Transcript
