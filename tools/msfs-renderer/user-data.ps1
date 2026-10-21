# Personal fork: first-boot provisioning of the GEV MSFS renderer
# (template.yaml; msfs.mjs puts this file into its UserData). Runs once, as
# SYSTEM, under EC2Launch v2. Each step logs and carries on if it fails;
# the summary at the end lists the failed ones. Log: C:\gev-provision.log.
# Not part of upstream God's Eye View.

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest crawls with its progress bar on.
$ProgressPreference = 'SilentlyContinue'
Start-Transcript -Path 'C:\gev-provision.log' -Append
$work = 'C:\gev-provision'
New-Item -ItemType Directory -Force -Path $work | Out-Null
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
  # 3010: done, a restart is needed (the one at the end).
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "$path exited with $($process.ExitCode)"
  }
}

function LatestGitHubAsset([string]$repo, [string]$pattern) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'gev-msfs-renderer' }
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { throw "no asset matching $pattern in $repo $($release.tag_name)" }
  Write-Output "$repo $($release.tag_name): $($asset.name)"
  return $asset
}

Step 'Windows Update: no automatic restart, notify before downloading' {
  $au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
  New-Item -Path $au -Force | Out-Null
  New-ItemProperty -Path $au -Name 'NoAutoRebootWithLoggedOnUsers' -PropertyType DWord -Value 1 -Force | Out-Null
  New-ItemProperty -Path $au -Name 'AUOptions' -PropertyType DWord -Value 2 -Force | Out-Null
}

Step 'Windows Audio service (Parsec streams the sound)' {
  Set-Service -Name 'Audiosrv' -StartupType Automatic
  Start-Service -Name 'Audiosrv'
}

# AWS's documented procedure for the NVIDIA gaming driver on Windows
# (docs.aws.amazon.com/AWSEC2/latest/UserGuide/nvidia-gaming-driver.html):
# the installer from s3://nvidia-gaming/windows/latest (the instance role
# may read it), vGamingMarketplace=2, the licence certificate for the
# driver's version, a restart.
Step 'NVIDIA gaming driver' {
  $driverDir = Join-Path $work 'NVIDIA'
  $objects = Get-S3Object -BucketName 'nvidia-gaming' -KeyPrefix 'windows/latest' -Region us-east-1
  foreach ($object in $objects) {
    if ($object.Key -ne '' -and $object.Size -ne 0) {
      $local = Join-Path $driverDir $object.Key
      New-Item -ItemType Directory -Force -Path (Split-Path $local) | Out-Null
      Copy-S3Object -BucketName 'nvidia-gaming' -Key $object.Key -LocalFile $local -Region us-east-1 | Out-Null
    }
  }
  $installers = @(Get-ChildItem -Path $driverDir -Recurse -Filter '*.exe')
  # The package for this OS when the folder holds several.
  $installer = $installers | Where-Object { $_.Name -match 'server2022' } | Select-Object -First 1
  if (-not $installer) { $installer = $installers | Select-Object -First 1 }
  if (-not $installer) { throw 'no driver installer in s3://nvidia-gaming/windows/latest' }
  Write-Output "driver installer: $($installer.FullName)"
  # NVIDIA's installers take -s (silent); if this one does not, run it by
  # hand from C:\gev-provision\NVIDIA and re-run this step's last part.
  Install $installer.FullName @('-s', '-noreboot', '-clean')

  $match = [regex]::Match($installer.Name, '^\d+\.\d+')
  if (-not $match.Success) { throw "no driver version in $($installer.Name): set the registry value and certificate by hand" }
  $version = [version]$match.Value
  Write-Output "driver version $version"

  # Version 527.27 or above: the nvlddmkm key; earlier: NVIDIA Corporation.
  # reg.exe /reg:64, since PowerShell here may be the 32-bit one.
  if ($version -ge [version]'527.27') {
    $key = 'HKLM\SYSTEM\CurrentControlSet\Services\nvlddmkm\Global'
  } else {
    $key = 'HKLM\SOFTWARE\NVIDIA Corporation\Global'
  }
  & reg.exe add $key /v vGamingMarketplace /t REG_DWORD /d 2 /f /reg:64
  if ($LASTEXITCODE -ne 0) { throw "reg add $key exited with $LASTEXITCODE" }

  # The certificate for the version, as AWS lists them. 581.81 to 591.58
  # are not listed: the 2025 one, flagged.
  if ($version -ge [version]'591.59') {
    $cert = 'GridSwCert_2026_03_02.cert'
  } elseif ($version -ge [version]'576.80') {
    $cert = 'GridSwCertWindows_2025_07_01.cert'
    if ($version -gt [version]'581.80') { Write-Output "warning: AWS lists no certificate for $version; using $cert" }
  } elseif ($version -ge [version]'460.39') {
    $cert = 'GridSwCertWindows_2024_02_22.cert'
  } else {
    $cert = 'GridSwCert-Windows_2020_04.cert'
  }
  Write-Output "licence certificate: $cert"
  Invoke-WebRequest -Uri "https://nvidia-gaming.s3.amazonaws.com/GridSwCert-Archive/$cert" -OutFile "$Env:PUBLIC\Documents\GridSwCert.txt" -UseBasicParsing

  # After the restart, once: the licence status into the log.
  $check = @'
$smi = Get-ChildItem -Path C:\Windows\System32\DriverStore\FileRepository -Recurse -Filter nvidia-smi.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$lines = if ($smi) { & $smi.FullName -q | Select-String -Pattern 'Product Name|License Status' | ForEach-Object { $_.Line.Trim() } } else { 'nvidia-smi.exe not found' }
Add-Content -Path C:\gev-provision.log -Value ("=== $(Get-Date -Format s) NVIDIA licence after the restart`r`n" + ($lines -join "`r`n"))
Unregister-ScheduledTask -TaskName 'gev-nvidia-licence-check' -Confirm:$false
'@
  Set-Content -Path (Join-Path $work 'nvidia-licence-check.ps1') -Value $check
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $(Join-Path $work 'nvidia-licence-check.ps1')"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  Register-ScheduledTask -TaskName 'gev-nvidia-licence-check' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
}

# Parsec as a shared (all-users, service) host: the flags Parsec's own
# Cloud Preparation Tool installs it with.
Step 'Parsec' {
  Install (Download 'https://builds.parsec.app/package/parsec-windows.exe' 'parsec-windows.exe') @('/silent', '/shared')
}

Step 'Steam' {
  Install (Download 'https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe' 'SteamSetup.exe') @('/S')
}

Step 'OBS Studio' {
  $asset = LatestGitHubAsset 'obsproject/obs-studio' '-Windows-x64-Installer\.exe$'
  Install (Download $asset.browser_download_url $asset.name) @('/S')
}

Step '7-Zip' {
  $asset = LatestGitHubAsset 'ip7z/7zip' '^7z\d+-x64\.exe$'
  Install (Download $asset.browser_download_url $asset.name) @('/S')
}

Write-Output "=== $(Get-Date -Format s) provisioning finished; failed steps: $(if ($failed.Count) { $failed -join ', ' } else { 'none' })"
Write-Output 'Manual: Parsec and Steam sign-in, MSFS 2024, Developer Mode, and the MSFS 2024 SDK (installed from inside the sim). See tools/msfs-renderer/README.md.'
Stop-Transcript
# Once, for the driver; a minute's grace for EC2Launch to finish.
& shutdown.exe /r /t 60 /c 'gev-msfs-renderer: provisioning done, restarting once'
