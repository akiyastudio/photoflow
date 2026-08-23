param(
    [string]$DistroName = 'PhotoFlowNative',
    [string]$LinuxUser = 'photoflowlab',
    [string]$InstallRoot = '',
    [string]$PackagePath = '',
    [string]$ExpectedComponentVersion = '',
    [int]$ExpectedAdvancedRuntimeApiVersion = 0,
    [string]$CompatibleLegacyComponentVersions = '',
    [switch]$Repair,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

function Assert-SafeArchiveEntries {
    param([string[]]$Entries)
    foreach ($entry in $Entries) {
        $normalized = ([string]$entry).Replace('\', '/').Trim()
        if (-not $normalized) { continue }
        if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:' -or $normalized.Split('/') -contains '..') {
            throw "Offline package contains an unsafe path: $entry"
        }
    }
}

if ($LinuxUser -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Invalid Linux user name' }
$defaultRoot = Join-Path $env:LOCALAPPDATA 'PhotoFlow\components\team-retouch\advanced\wsl\PhotoFlowNative'
if (-not $InstallRoot.Trim()) { $InstallRoot = $defaultRoot }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PhotoFlow'))
if (-not $InstallRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The advanced environment must be installed inside the PhotoFlow application data directory.'
}
$stableVhd = Join-Path $InstallRoot 'ext4.vhdx'

Write-Host '[PhotoFlow advanced offline setup] Checking WSL 2'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL 2 is not installed. Enable WSL 2 from the offline deployment prerequisites, restart Windows, and try again.'
}
& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'WSL 2 is not ready. Enable WSL 2 from the offline deployment prerequisites, restart Windows, and try again.'
}
$gpuNames = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Name })
if (-not ($gpuNames | Where-Object { $_ -match 'NVIDIA' })) {
    throw 'The advanced engine requires an NVIDIA GPU and an offline-installed driver that supports CUDA in WSL 2.'
}
$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
$nvidiaSmiPath = if ($nvidiaSmi) { $nvidiaSmi.Source } else { '' }
if (-not $nvidiaSmi) {
    $systemNvidiaSmi = Join-Path $env:WINDIR 'System32\nvidia-smi.exe'
    if (Test-Path -LiteralPath $systemNvidiaSmi -PathType Leaf) { $nvidiaSmiPath = $systemNvidiaSmi }
}
if (-not $nvidiaSmiPath) {
    throw 'NVIDIA driver diagnostics are unavailable. Install a current NVIDIA driver with WSL 2 CUDA support and try again.'
}
$gpuStatus = @(& $nvidiaSmiPath --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $gpuStatus.Count) {
    throw 'The NVIDIA driver is not responding. Reinstall or update the NVIDIA driver before installing the advanced engine.'
}
$gpuSummary = ($gpuStatus | ForEach-Object {
    $parts = ([string]$_).Split(',') | ForEach-Object { $_.Trim() }
    if ($parts.Count -ge 3) {
        $vramGb = [math]::Round(([double]$parts[2]) / 1024, 1)
        "$($parts[0]), driver $($parts[1]), $vramGb GB VRAM"
    } else { ([string]$_).Trim() }
} | Where-Object { $_ }) -join '; '
$driveRoot = [IO.Path]::GetPathRoot($InstallRoot)
$drive = if ($driveRoot) { [IO.DriveInfo]::new($driveRoot) } else { $null }
if ($drive -and $drive.IsReady -and $drive.AvailableFreeSpace -lt 35GB -and -not (Test-Path -LiteralPath $stableVhd -PathType Leaf)) {
    throw "The target disk needs at least 35 GB free. Available: $([math]::Round($drive.AvailableFreeSpace / 1GB, 1)) GB"
}
if ($CheckOnly) {
    Write-Host "OFFLINE_PREFLIGHT_OK|WSL 2 ready|$gpuSummary|$([math]::Round($drive.AvailableFreeSpace / 1GB, 1)) GB free"
    exit 0
}
if (-not $PackagePath.Trim()) { throw 'Select a PhotoFlow advanced engine offline package.' }
$PackagePath = [IO.Path]::GetFullPath($PackagePath)
if (-not (Test-Path -LiteralPath $PackagePath)) { throw 'The selected offline package does not exist.' }

$stateRoot = Join-Path $env:LOCALAPPDATA 'PhotoFlow\components\team-retouch\advanced'
$stagingRoot = Join-Path $stateRoot ('.offline-stage-' + [Guid]::NewGuid().ToString('N'))
$packageRoot = ''
$manifestPath = ''
$usingStaging = $false
try {
    if (Test-Path -LiteralPath $PackagePath -PathType Container) {
        $packageRoot = $PackagePath
        $manifestPath = Join-Path $packageRoot 'manifest.json'
    } elseif ([IO.Path]::GetExtension($PackagePath).Equals('.zip', [StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe is required to read the offline package.' }
        $entries = @(& tar.exe -tf $PackagePath)
        if ($LASTEXITCODE -ne 0) { throw 'Unable to read the offline package directory.' }
        Assert-SafeArchiveEntries -Entries $entries
        New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
        Write-Host '[PhotoFlow advanced offline setup] Extracting verified package payload'
        & tar.exe -xf $PackagePath -C $stagingRoot
        if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the offline package.' }
        $usingStaging = $true
        $manifests = @(Get-ChildItem -LiteralPath $stagingRoot -Filter manifest.json -File -Recurse)
        if ($manifests.Count -ne 1) { throw 'The offline package must contain exactly one manifest.json.' }
        $manifestPath = $manifests[0].FullName
        $packageRoot = Split-Path -Parent $manifestPath
    } elseif ([IO.Path]::GetExtension($PackagePath).Equals('.json', [StringComparison]::OrdinalIgnoreCase)) {
        $manifestPath = $PackagePath
        $packageRoot = Split-Path -Parent $manifestPath
    } elseif ([IO.Path]::GetExtension($PackagePath).Equals('.vhdx', [StringComparison]::OrdinalIgnoreCase)) {
        $packageRoot = Split-Path -Parent $PackagePath
        $manifestPath = Join-Path $packageRoot 'manifest.json'
    } else {
        throw 'Select a .zip offline package, manifest.json, or prepared .vhdx file.'
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The offline package is missing manifest.json.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$manifest.formatVersion -ne 1 -or [string]$manifest.componentId -ne 'team-retouch') { throw 'This is not a supported PhotoFlow team-retouch offline package.' }
    if ([string]$manifest.architecture -ne 'x64') { throw 'The offline package architecture is not supported on this computer.' }
    $manifestAdvancedApiVersion = if ($manifest.PSObject.Properties['advancedRuntimeApiVersion']) { [int]$manifest.advancedRuntimeApiVersion } else { 0 }
    $legacyVersions = @($CompatibleLegacyComponentVersions.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($ExpectedAdvancedRuntimeApiVersion -gt 0) {
        if ($manifestAdvancedApiVersion -gt 0) {
            if ($manifestAdvancedApiVersion -ne $ExpectedAdvancedRuntimeApiVersion) {
                throw "Advanced runtime API $manifestAdvancedApiVersion is not compatible with required API $ExpectedAdvancedRuntimeApiVersion."
            }
        } elseif ($legacyVersions -notcontains ([string]$manifest.componentVersion)) {
            throw "Legacy advanced package version $($manifest.componentVersion) is not in the reviewed compatibility list."
        }
    } elseif ($ExpectedComponentVersion -and [string]$manifest.componentVersion -ne $ExpectedComponentVersion) {
        throw "Offline package version $($manifest.componentVersion) does not match component version $ExpectedComponentVersion."
    }
    $vhdName = [string]$manifest.vhdFile
    if (-not $vhdName -or [IO.Path]::GetFileName($vhdName) -ne $vhdName) { throw 'The offline package manifest contains an invalid VHD file name.' }
    $sourceVhd = if ([IO.Path]::GetExtension($PackagePath).Equals('.vhdx', [StringComparison]::OrdinalIgnoreCase)) { $PackagePath } else { Join-Path $packageRoot $vhdName }
    if (-not (Test-Path -LiteralPath $sourceVhd -PathType Leaf)) { throw "The offline package is missing $vhdName." }
    if ([IO.Path]::GetFullPath($sourceVhd).Equals([IO.Path]::GetFullPath($stableVhd), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Do not select the currently installed ext4.vhdx. Reconnect the original offline deployment package.'
    }
    Write-Host '[PhotoFlow advanced offline setup] Verifying package SHA256'
    $actualHash = (Get-FileHash -LiteralPath $sourceVhd -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $manifest.vhdSha256 -or $actualHash -ne ([string]$manifest.vhdSha256).ToLowerInvariant()) { throw 'The advanced engine disk checksum does not match the package manifest.' }

    $distroNames = @(& wsl.exe --list --quiet) | ForEach-Object { $_.Replace([string][char]0, '').Trim() } | Where-Object { $_ }
    $registered = $distroNames -contains $DistroName
    if ($registered -and -not $Repair) { throw 'The advanced environment is already registered. Use Repair to replace it from an offline package.' }
    if ($registered) {
        Write-Host '[PhotoFlow advanced offline setup] Replacing the registered advanced environment'
        & wsl.exe --terminate $DistroName 2>$null
        & wsl.exe --unregister $DistroName
        if ($LASTEXITCODE -ne 0) { throw 'Unable to unregister the existing advanced environment.' }
    }

    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    if (Test-Path -LiteralPath $stableVhd -PathType Leaf) { Remove-Item -LiteralPath $stableVhd -Force }
    Write-Host '[PhotoFlow advanced offline setup] Installing PhotoFlowNative virtual disk'
    if ($usingStaging) { Move-Item -LiteralPath $sourceVhd -Destination $stableVhd }
    else { Copy-Item -LiteralPath $sourceVhd -Destination $stableVhd }
    & wsl.exe --import-in-place $DistroName $stableVhd
    if ($LASTEXITCODE -ne 0) { throw "Unable to register PhotoFlowNative (exit code $LASTEXITCODE)" }
    & wsl.exe --manage $DistroName --set-default-user $LinuxUser
    if ($LASTEXITCODE -ne 0) { throw 'Unable to set the PhotoFlowNative default user.' }
    & wsl.exe -d $DistroName -u $LinuxUser -- true
    if ($LASTEXITCODE -ne 0) { throw 'The imported PhotoFlowNative environment cannot start with its application user.' }

    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    @{
        distroName = $DistroName
        installRoot = $InstallRoot
        installedAt = [DateTime]::UtcNow.ToString('o')
        version = 2
        componentVersion = [string]$manifest.componentVersion
        advancedRuntimeApiVersion = if ($manifestAdvancedApiVersion -gt 0) { $manifestAdvancedApiVersion } else { $ExpectedAdvancedRuntimeApiVersion }
        legacyPackage = ($manifestAdvancedApiVersion -eq 0)
        packageSha256 = $actualHash
        offline = $true
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateRoot 'install-state.json') -Encoding UTF8
    Write-Host "PhotoFlow advanced offline environment is ready in $InstallRoot"
} finally {
    if ($usingStaging -and (Test-Path -LiteralPath $stagingRoot)) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
}
