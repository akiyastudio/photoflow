param([string]$DistroName = 'PhotoFlowNative')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
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
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PhotoFlow'))
$allowedPrefix = $allowedRoot.TrimEnd('\') + '\'
if (-not $basePath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a WSL environment outside PhotoFlow application data: $basePath"
}

Write-Host '[PhotoFlow advanced setup] Stopping PhotoFlowNative'
& wsl.exe --terminate $DistroName 2>$null
Write-Host '[PhotoFlow advanced setup] Unregistering PhotoFlowNative and deleting its virtual disk'
& wsl.exe --unregister $DistroName
if ($LASTEXITCODE -ne 0) { throw "Unable to unregister $DistroName" }

if ((Test-Path -LiteralPath $basePath -PathType Container) -and -not @(Get-ChildItem -LiteralPath $basePath -Force).Count) {
    Remove-Item -LiteralPath $basePath
}
$statePath = Join-Path $env:LOCALAPPDATA 'PhotoFlow\components\team-retouch\advanced\install-state.json'
if (Test-Path -LiteralPath $statePath -PathType Leaf) { Remove-Item -LiteralPath $statePath -Force }
Write-Host 'PhotoFlow advanced environment was removed'
