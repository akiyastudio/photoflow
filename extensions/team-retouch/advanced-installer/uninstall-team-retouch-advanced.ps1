# Byte-exact lifecycle payload: keep this file LF-only; the component manifest hashes its raw packaged bytes.
param([string]$DistroName = 'PhotoFlowNative')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$componentDataRoot = [string]$env:PHOTOFLOW_COMPONENT_DATA_ROOT
if (-not $componentDataRoot.Trim()) {
    if (-not [string]$env:LOCALAPPDATA) { throw 'The Host did not grant a controlled component data root.' }
    $componentDataRoot = Join-Path $env:LOCALAPPDATA 'PhotoFlow\components\team-retouch'
}
$componentDataRoot = [IO.Path]::GetFullPath($componentDataRoot)
$lxssRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
$registration = Get-ChildItem -LiteralPath $lxssRoot -ErrorAction SilentlyContinue | Where-Object {
    (Get-ItemProperty -LiteralPath $_.PSPath -Name DistributionName -ErrorAction SilentlyContinue).DistributionName -eq $DistroName
} | Select-Object -First 1

if (-not $registration) {
    Write-Host 'PhotoFlow advanced environment is not installed'
    exit 0
}

$properties = Get-ItemProperty -LiteralPath $registration.PSPath
$basePath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$properties.BasePath))
$allowedRoot = $componentDataRoot
$allowedPrefix = $allowedRoot.TrimEnd('\') + '\'
if (-not $basePath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a WSL environment outside PhotoFlow application data: $basePath"
}
$statePath = Join-Path $componentDataRoot 'advanced\install-state.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Refusing to remove the WSL environment because component install-state is missing.' }
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$stateRoot = [IO.Path]::GetFullPath([string]$state.installRoot).TrimEnd('\')
$markerPath = Join-Path $stateRoot '.photoflow-team-retouch-owner.json'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Refusing to remove the WSL environment because its ownership marker is missing.' }
$marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$state.componentId -ne 'team-retouch' -or [string]$state.distroName -ne $DistroName -or -not $stateRoot.Equals($basePath.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or [string]$state.ownerToken -ne [string]$marker.ownerToken) {
    throw 'Refusing to remove the WSL environment because registration, install-state, and ownership marker do not match.'
}

Write-Host '[PhotoFlow advanced setup] Stopping PhotoFlowNative'
& wsl.exe --terminate $DistroName 2>$null
Write-Host '[PhotoFlow advanced setup] Unregistering PhotoFlowNative and deleting its virtual disk'
& wsl.exe --unregister $DistroName
if ($LASTEXITCODE -ne 0) { throw "Unable to unregister $DistroName" }

if (Test-Path -LiteralPath $markerPath -PathType Leaf) { Remove-Item -LiteralPath $markerPath -Force }
if ((Test-Path -LiteralPath $basePath -PathType Container) -and -not @(Get-ChildItem -LiteralPath $basePath -Force).Count) {
    Remove-Item -LiteralPath $basePath
}
if (Test-Path -LiteralPath $statePath -PathType Leaf) { Remove-Item -LiteralPath $statePath -Force }
Write-Host 'PhotoFlow advanced environment was removed'
