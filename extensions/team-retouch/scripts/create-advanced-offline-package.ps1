param(
    [string]$DistroName = 'PhotoFlowNative',
    [string]$ComponentVersion = '26.8.24.1',
    [int]$AdvancedRuntimeApiVersion = 1,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($OutputPath) -ne '.zip') { throw 'OutputPath must end in .zip.' }
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL is not installed.' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe is required.' }
$names = @(& wsl.exe --list --quiet) | ForEach-Object { $_.Replace([string][char]0, '').Trim() } | Where-Object { $_ }
if ($names -notcontains $DistroName) { throw "WSL distribution not found: $DistroName" }
& wsl.exe -d $DistroName -u photoflow -- bash -lc "test -x `$HOME/miniforge3/envs/pairdetr/bin/python && test -x `$HOME/miniforge3/envs/sam2/bin/python && test -f `$HOME/model-lab/checkpoints/pairdetr/pytorch_model.bin && test -f `$HOME/model-lab/checkpoints/sam2/sam2.1_hiera_large.pt"
if ($LASTEXITCODE -ne 0) { throw 'PairDETR, SAM 2.1, or their checkpoints are incomplete; refusing to create a deployment package.' }

$stage = Join-Path $env:TEMP ('photoflow-advanced-package-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $vhdPath = Join-Path $stage 'PhotoFlowNative.vhdx'
    Write-Host '[PhotoFlow offline package] Stopping and exporting the verified distribution'
    & wsl.exe --terminate $DistroName 2>$null
    # The verification command above starts the WSL VM. Terminating only the
    # distribution can leave vmmemWSL holding ext4.vhdx for several seconds,
    # which makes `wsl --export --vhd` fail with ERROR_SHARING_VIOLATION.
    # This is a release-building tool, so fully stop WSL and wait for the VM
    # handle to disappear before exporting the prepared environment.
    & wsl.exe --shutdown 2>$null
    foreach ($waitAttempt in 1..20) {
        if (-not (Get-Process -Name 'vmmemWSL' -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Name 'vmmemWSL' -ErrorAction SilentlyContinue) {
        throw 'WSL virtual machine did not stop; unable to obtain an exclusive VHDX handle for export.'
    }
    $exported = $false
    foreach ($attempt in 1..3) {
        if ($attempt -gt 1) { Start-Sleep -Seconds 5 }
        & wsl.exe --export $DistroName $vhdPath --vhd
        if ($LASTEXITCODE -eq 0) { $exported = $true; break }
        if (Test-Path -LiteralPath $vhdPath) { Remove-Item -LiteralPath $vhdPath -Force }
    }
    if (-not $exported) { throw 'Unable to export the advanced environment after three attempts. Close PhotoFlow processes using the advanced engine and try again.' }
    $hash = (Get-FileHash -LiteralPath $vhdPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $vhdPath).Length
    @{
        formatVersion = 1
        componentId = 'team-retouch'
        componentVersion = $ComponentVersion
        advancedRuntimeApiVersion = $AdvancedRuntimeApiVersion
        architecture = 'x64'
        distroName = $DistroName
        linuxUser = 'photoflow'
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
    Write-Host "SHA256: $((Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant())"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
