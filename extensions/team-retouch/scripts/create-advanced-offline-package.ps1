param(
    [string]$DistroName = 'PhotoFlowNative',
    [string]$LinuxUser = 'photoflow',
    [string]$ComponentVersion = '26.8.24.1',
    [int]$AdvancedRuntimeApiVersion = 1,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [switch]$TestHelpersOnly
)

$ErrorActionPreference = 'Stop'
function Get-ReleaseFileSha256([string]$LiteralPath) {
    $stream = [IO.File]::OpenRead($LiteralPath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Stop-IdleWslVirtualMachine {
    $rawNames = @(& wsl.exe --list --running --quiet)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify whether other WSL distributions are running.' }
    $runningNames = @($rawNames | ForEach-Object { ([string]$_).Replace([string][char]0, '').Trim() } | Where-Object { $_ })
    if ($runningNames.Count -gt 0) { return $false }
    # WSL can retain a stopped distro's VHD handle in its otherwise idle VM.
    # Never shut down the shared VM while any distribution has active work.
    & wsl.exe --shutdown | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to release the idle WSL virtual machine.' }
    return $true
}
if ($TestHelpersOnly) { return }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ($LinuxUser -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Invalid Linux user name.' }
if ([IO.Path]::GetExtension($OutputPath) -ne '.zip') { throw 'OutputPath must end in .zip.' }
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL is not installed.' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe is required.' }
$names = @(& wsl.exe --list --quiet) | ForEach-Object { $_.Replace([string][char]0, '').Trim() } | Where-Object { $_ }
if ($names -notcontains $DistroName) { throw "WSL distribution not found: $DistroName" }
$componentRoot = Split-Path -Parent $PSScriptRoot
function Read-AdvancedWslText([string[]]$CommandArguments) {
    $lines = @(& wsl.exe -d $DistroName -u $LinuxUser --exec @CommandArguments)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -ne 1 -or -not ([string]$lines[0]).Trim()) { throw 'Cannot resolve an advanced build path.' }
    return ([string]$lines[0]).Trim()
}
$pairLinux = Read-AdvancedWslText @('wslpath', '-a', (Join-Path $componentRoot 'advanced\pairdetr_service.py'))
$samLinux = Read-AdvancedWslText @('wslpath', '-a', (Join-Path $componentRoot 'advanced\sam2_service.py'))
$verifyLinux = Read-AdvancedWslText @('wslpath', '-a', (Join-Path $componentRoot 'scripts\verify-advanced-environment.py'))
$sourceLinux = Read-AdvancedWslText @('wslpath', '-a', $componentRoot)
$runtimeHome = Read-AdvancedWslText @('printenv', 'HOME')
foreach ($engineProfile in @('pairdetr', 'sam2')) {
    & wsl.exe -d $DistroName -u $LinuxUser --exec "$runtimeHome/miniforge3/envs/$engineProfile/bin/python" $verifyLinux --profile $engineProfile --source-root $sourceLinux
    if ($LASTEXITCODE -ne 0) { throw "Advanced $engineProfile environment does not match the reviewed release inputs." }
}
& wsl.exe -d $DistroName -u $LinuxUser --exec timeout 180 "$runtimeHome/miniforge3/envs/pairdetr/bin/python" $pairLinux --self-test
if ($LASTEXITCODE -ne 0) { throw 'PairDETR self-test failed; refusing to export.' }
& wsl.exe -d $DistroName -u $LinuxUser --exec timeout 240 "$runtimeHome/miniforge3/envs/sam2/bin/python" $samLinux --self-test
if ($LASTEXITCODE -ne 0) { throw 'SAM self-test failed; refusing to export.' }

$stage = Join-Path $env:TEMP ('photoflow-advanced-package-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $vhdPath = Join-Path $stage 'PhotoFlowNative.vhdx'
    Write-Host '[PhotoFlow offline package] Stopping and exporting the verified distribution'
    & wsl.exe --terminate $DistroName 2>$null
    $releasedIdleVm = Stop-IdleWslVirtualMachine
    if ($releasedIdleVm) { Write-Host '[PhotoFlow offline package] Released idle WSL disk handles; no running distributions were interrupted' }
    # Retry this distribution's export without shutting down unrelated WSL work.
    $exported = $false
    foreach ($attempt in 1..3) {
        if ($attempt -gt 1) { Start-Sleep -Seconds 5 }
        & wsl.exe --export $DistroName $vhdPath --vhd
        if ($LASTEXITCODE -eq 0) { $exported = $true; break }
        if (Test-Path -LiteralPath $vhdPath) { Remove-Item -LiteralPath $vhdPath -Force }
    }
    if (-not $exported) { throw 'Unable to export the advanced environment after three attempts. Close PhotoFlow processes using the advanced engine and try again.' }
    $hash = Get-ReleaseFileSha256 $vhdPath
    $size = (Get-Item -LiteralPath $vhdPath).Length
    @{
        formatVersion = 1
        componentId = 'team-retouch'
        componentVersion = $ComponentVersion
        advancedRuntimeApiVersion = $AdvancedRuntimeApiVersion
        architecture = 'x64'
        distroName = 'PhotoFlowNative'
        linuxUser = $LinuxUser
        vhdFile = 'PhotoFlowNative.vhdx'
        vhdSha256 = $hash
        installedSizeBytes = $size
        createdAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding UTF8
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    if (Test-Path -LiteralPath $OutputPath) { throw "Output package already exists: $OutputPath" }
    Write-Host '[PhotoFlow offline package] Compressing manifest and virtual disk'
    & tar.exe -a -cf $OutputPath -C $stage manifest.json PhotoFlowNative.vhdx
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the offline package.' }
    Write-Host "Offline package created: $OutputPath"
    Write-Host "SHA256: $(Get-ReleaseFileSha256 $OutputPath)"
} finally {
    $temporaryRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not [IO.Path]::GetFullPath($stage).StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Export staging escaped TEMP.' }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
