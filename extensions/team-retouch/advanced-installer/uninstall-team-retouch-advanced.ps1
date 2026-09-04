# Byte-exact lifecycle payload: keep this file LF-only; the component manifest hashes its raw packaged bytes.
param([string]$DistroName = 'PhotoFlowNative')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
function Assert-SafeLocalPath([string]$PathValue) {
    $full = [IO.Path]::GetFullPath($PathValue)
    if ($full.StartsWith('\\', [StringComparison]::Ordinal) -or $full.Substring([Math]::Min(2, $full.Length)).Contains(':')) { throw "UNC and alternate-data-stream paths are forbidden: $full" }
    $cursor = if (Test-Path -LiteralPath $full) { $full } else { Split-Path -Parent $full }
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse-point path is forbidden: $cursor" }
        }
        $next = Split-Path -Parent $cursor
        if (-not $next -or $next -eq $cursor) { break }
        $cursor = $next
    }
    return $full
}
function Assert-ExactJsonFields($Value, [string[]]$Expected, [string]$Label) {
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $required = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($required -join "`n")) { throw "$Label contains missing or unknown fields." }
}
$componentDataRoot = [string]$env:PHOTOFLOW_COMPONENT_DATA_ROOT
if (-not $componentDataRoot.Trim()) {
    if (-not [string]$env:LOCALAPPDATA) { throw 'The Host did not grant a controlled component data root.' }
    $componentDataRoot = Join-Path $env:LOCALAPPDATA 'PhotoFlow\components\team-retouch'
}
$componentDataRoot = [IO.Path]::GetFullPath($componentDataRoot)
Assert-SafeLocalPath $componentDataRoot | Out-Null
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
Assert-SafeLocalPath $basePath | Out-Null
$allowedRoot = $componentDataRoot
$allowedPrefix = $allowedRoot.TrimEnd('\') + '\'
if (-not $basePath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a WSL environment outside PhotoFlow application data: $basePath"
}
$statePath = Join-Path $componentDataRoot 'advanced\install-state.json'
Assert-SafeLocalPath $statePath | Out-Null
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Refusing to remove the WSL environment because component install-state is missing.' }
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ExactJsonFields $state @('componentId','distroName','installRoot','ownerToken','installedAt','version','componentVersion','advancedRuntimeApiVersion','packageSha256','vhdSha256','offline') 'Install state'
$stateRoot = [IO.Path]::GetFullPath([string]$state.installRoot).TrimEnd('\')
$markerPath = Join-Path $stateRoot '.photoflow-team-retouch-owner.json'
Assert-SafeLocalPath $markerPath | Out-Null
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Refusing to remove the WSL environment because its ownership marker is missing.' }
$marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ExactJsonFields $marker @('componentId','distroName','installRoot','ownerToken','version') 'Ownership marker'
if ([int]$state.version -ne 3 -or [int]$marker.version -ne 1 -or [string]$state.componentId -ne 'team-retouch' -or [string]$marker.componentId -ne 'team-retouch' -or [string]$state.distroName -ne $DistroName -or [string]$marker.distroName -ne $DistroName -or -not $stateRoot.Equals($basePath.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or [string]$marker.installRoot -ne $stateRoot -or [string]$state.ownerToken -notmatch '^[a-f0-9]{32}$' -or [string]$state.ownerToken -ne [string]$marker.ownerToken) {
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
