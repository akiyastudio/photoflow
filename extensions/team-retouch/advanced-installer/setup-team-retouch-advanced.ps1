# Byte-exact lifecycle payload: keep this file LF-only; the component manifest hashes its raw packaged bytes.
param(
    [string]$DistroName = 'PhotoFlowNative', [string]$LinuxUser = 'photoflowlab',
    [string]$InstallRoot = '', [string]$PackagePath = '',
    [string]$ExpectedComponentVersion = '', [int]$ExpectedAdvancedRuntimeApiVersion = 0,
    [string]$ExpectedPackageSha256 = '', [switch]$Repair, [switch]$CheckOnly,
    [switch]$TestHelpersOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

# Advanced VHDs are legitimately large, but a release package must remain
# bounded. These limits allow a 128 GiB provisioned runtime and a 64 GiB ZIP,
# while the ratio cap rejects tiny highly-compressible archives that could
# otherwise consume hundreds of gigabytes during extraction.
$MaxArchiveBytes = 64GB
$MaxVhdBytes = 128GB
$MaxTotalExpandedBytes = $MaxVhdBytes + 1MB
$MaxCompressionRatio = 200
if (-not ('PhotoFlowAdvancedStagingLock' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PhotoFlowAdvancedStagingLock {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
}
'@
}

function Get-DistroRegistration([string]$Name) {
    Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue | Where-Object {
        (Get-ItemProperty -LiteralPath $_.PSPath -Name DistributionName -ErrorAction SilentlyContinue).DistributionName -eq $Name
    } | Select-Object -First 1
}
function Get-RegistrationBasePath($Registration) {
    if (-not $Registration) { return '' }
    $properties = Get-ItemProperty -LiteralPath $Registration.PSPath
    [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$properties.BasePath)).TrimEnd('\')
}
function Assert-RegistrationBasePath([string]$Name, [string]$ExpectedRoot) {
    $registration = Get-DistroRegistration $Name
    if (-not $registration) { throw "WSL distribution is not registered: $Name" }
    $actual = Get-RegistrationBasePath $registration
    $expected = [IO.Path]::GetFullPath($ExpectedRoot).TrimEnd('\')
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to manage WSL distribution $Name because BasePath is not component-owned: $actual" }
    $registration
}
function Unregister-OwnedDistro([string]$Name, [string]$ExpectedRoot) {
    Assert-RegistrationBasePath $Name $ExpectedRoot | Out-Null
    & wsl.exe --terminate $Name 2>$null
    & wsl.exe --unregister $Name
    if ($LASTEXITCODE -ne 0) { throw "Unable to unregister verified component distribution $Name" }
}
function Remove-OwnedRegistrationIfPresent([string]$Name, [string]$ExpectedRoot) {
    # Import can return a failure before Lxss finishes publishing its registry
    # entry.  Never trust an earlier boolean: query again at cleanup time.
    $registration = Get-DistroRegistration $Name
    if (-not $registration) { return $false }
    $actual = Get-RegistrationBasePath $registration
    $expected = [IO.Path]::GetFullPath($ExpectedRoot).TrimEnd('\')
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean up WSL distribution $Name because BasePath is not this transaction's path: $actual"
    }
    Unregister-OwnedDistro $Name $ExpectedRoot
    return $true
}
function Test-Distro([string]$Name, [string]$User) {
    & wsl.exe --manage $Name --set-default-user $User
    if ($LASTEXITCODE -ne 0) { throw "Unable to set the default user for $Name" }
    & wsl.exe -d $Name -u $User -- bash -lc 'test -x $HOME/miniforge3/envs/pairdetr/bin/python && test -x $HOME/miniforge3/envs/sam2/bin/python && test -s $HOME/model-lab/checkpoints/pairdetr/pytorch_model.bin && test -s $HOME/model-lab/checkpoints/sam2/sam2.1_hiera_large.pt'
    if ($LASTEXITCODE -ne 0) { throw "The imported advanced environment failed its runtime probe: $Name" }
}
function Open-ValidatedAdvancedArchive([string]$ArchivePath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archiveFullPath = [IO.Path]::GetFullPath($ArchivePath)
    if ($archiveFullPath.StartsWith('\\', [StringComparison]::Ordinal)) { throw 'The advanced package must be a local component file, not a UNC path.' }
    $archiveSize = (Get-Item -LiteralPath $archiveFullPath -Force).Length
    if ($archiveSize -le 0 -or $archiveSize -gt $MaxArchiveBytes) { throw 'The advanced package compressed size is outside the release limit.' }
    $archive = [IO.Compression.ZipFile]::OpenRead($archiveFullPath)
    try {
        $entries = @($archive.Entries)
        if ($entries.Count -ne 2) { throw 'The advanced package must contain exactly two root files.' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        [int64]$totalExpanded = 0
        [int64]$totalCompressed = 0
        foreach ($entry in $entries) {
            $name = [string]$entry.FullName
            if (-not $name -or $name.IndexOf([char]0) -ge 0 -or $name -ne $name.Replace('\','/') -or
                $name.StartsWith('/') -or $name.StartsWith('//') -or $name -match '^[A-Za-z]:' -or
                $name -match '/' -or $name -in @('.', '..') -or -not $seen.Add($name)) {
                throw "Offline package contains an unsafe or duplicate root path: $name"
            }
            $attributes = [uint32]([int64]$entry.ExternalAttributes -band 0xffffffffL)
            $unixType = ($attributes -shr 16) -band 0xF000
            if (($unixType -ne 0 -and $unixType -ne 0x8000) -or (($attributes -band 0x400) -ne 0)) {
                throw "Offline package contains a link or reparse entry: $name"
            }
            if ($entry.Length -lt 0 -or $entry.CompressedLength -lt 0) { throw "Offline package has an invalid entry size: $name" }
            $totalExpanded += [int64]$entry.Length
            $totalCompressed += [int64]$entry.CompressedLength
            if ($totalExpanded -gt $MaxTotalExpandedBytes) { throw 'The advanced package expands beyond the release limit.' }
        }
        $manifestEntry = $entries | Where-Object FullName -CEQ 'manifest.json' | Select-Object -First 1
        if (-not $manifestEntry -or $manifestEntry.Length -le 0 -or $manifestEntry.Length -gt 1MB) { throw 'The advanced package manifest is missing or has an anomalous size.' }
        $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.Encoding]::UTF8, $true, 4096, $false)
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        $vhdName = [string]$manifest.vhdFile
        if (-not $vhdName -or [IO.Path]::GetFileName($vhdName) -cne $vhdName -or $vhdName -in @('.', '..') -or $vhdName -match '[/\\:]') { throw 'The advanced manifest declares an unsafe VHD file.' }
        $vhdEntry = $entries | Where-Object FullName -CEQ $vhdName | Select-Object -First 1
        if (-not $vhdEntry -or $vhdEntry.Length -le 0 -or $vhdEntry.Length -gt $MaxVhdBytes) { throw 'The advanced package VHD is missing or has an anomalous size.' }
        if ($entries.FullName -cnotcontains 'manifest.json' -or $entries.FullName -cnotcontains $vhdName) { throw 'The advanced package contains files outside its strict manifest/VHD allowlist.' }
        $installedSize = [int64]$manifest.installedSizeBytes
        if ($installedSize -ne [int64]$vhdEntry.Length -or $installedSize -le 0 -or $installedSize -gt $MaxVhdBytes) { throw 'The advanced manifest installedSizeBytes does not match the VHD.' }
        if ($totalCompressed -le 0 -or ([double]$totalExpanded / [double]$totalCompressed) -gt $MaxCompressionRatio) { throw 'The advanced package compression ratio is unsafe.' }
        return @{ Archive=$archive; Manifest=$manifest; VhdName=$vhdName }
    } catch { $archive.Dispose(); throw }
}
function Assert-SafeStagingPath([string]$StagingRoot, [string]$Destination = '') {
    $root = [IO.Path]::GetFullPath($StagingRoot).TrimEnd('\')
    if ($root.StartsWith('\\', [StringComparison]::Ordinal)) { throw 'Advanced staging must be on a local component volume.' }
    $dataRootText = [string]$env:PHOTOFLOW_COMPONENT_DATA_ROOT
    if (-not $dataRootText.Trim()) { $dataRootText = Split-Path -Parent (Split-Path -Parent $root) }
    $dataRoot = [IO.Path]::GetFullPath($dataRootText).TrimEnd('\')
    if ($root -ne $dataRoot -and -not $root.StartsWith($dataRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Advanced staging escaped the component data root.' }
    $cursor = $root
    while ($cursor.Length -ge $dataRoot.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Advanced staging ancestor must not be a reparse point: $cursor" }
        }
        if ($cursor.Equals($dataRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
        $next = Split-Path -Parent $cursor
        if (-not $next -or $next -eq $cursor) { throw 'Advanced staging ancestry is invalid.' }
        $cursor = $next
    }
    if ($Destination) {
        $full = [IO.Path]::GetFullPath($Destination)
        if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Parent $full) -ne $root) { throw 'Advanced extraction target escaped staging.' }
    }
}
function Open-StagingDirectoryLock([string]$StagingRoot) {
    if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'Advanced staging directory locking is unavailable on this platform.' }
    # GENERIC_READ, FILE_SHARE_READ|FILE_SHARE_WRITE (deliberately no
    # FILE_SHARE_DELETE), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS.
    $handle = [PhotoFlowAdvancedStagingLock]::CreateFile([IO.Path]::GetFullPath($StagingRoot), 2147483648, 3, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if (-not $handle -or $handle.IsInvalid) { if ($handle) { $handle.Dispose() }; throw "Unable to lock advanced staging root: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    # A non-shareable sentinel additionally blocks recursive deletion on
    # Windows versions where a directory handle alone can enter delete-pending.
    $sentinelPath = Join-Path $StagingRoot '.photoflow-extraction.lock'
    try { $sentinel = [IO.FileStream]::new($sentinelPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { $handle.Dispose(); throw }
    return [pscustomobject]@{ Directory=$handle; Sentinel=$sentinel; SentinelPath=$sentinelPath }
}
function Close-StagingDirectoryLock($Lock, [switch]$KeepDirectoryHandle) {
    if (-not $Lock) { return }
    if ($Lock.Sentinel) { $Lock.Sentinel.Dispose(); $Lock.Sentinel = $null }
    if ($Lock.SentinelPath -and (Test-Path -LiteralPath $Lock.SentinelPath)) { Remove-Item -LiteralPath $Lock.SentinelPath -Force }
    if (-not $KeepDirectoryHandle -and $Lock.Directory) { $Lock.Directory.Dispose(); $Lock.Directory = $null }
}
function Assert-StagingEntities([string]$StagingRoot, [string[]]$AllowedNames) {
    $root = [IO.Path]::GetFullPath($StagingRoot).TrimEnd('\')
    $rootItem = Get-Item -LiteralPath $root -Force
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Advanced staging root must not be a reparse point.' }
    $items = @(Get-ChildItem -LiteralPath $root -Force -Recurse)
    if ($items.Count -ne $AllowedNames.Count) { throw 'Advanced staging contains an unexpected number of entities.' }
    foreach ($item in $items) {
        $full = [IO.Path]::GetFullPath($item.FullName)
        if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $AllowedNames -cnotcontains $item.Name -or $full -ne (Join-Path $root $item.Name)) {
            throw "Advanced staging entity escaped or is not a regular allowlisted file: $full"
        }
    }
}
function Expand-SafeAdvancedArchive([string]$ArchivePath, [string]$StagingRoot) {
    $validated = Open-ValidatedAdvancedArchive $ArchivePath
    $stagingLock = $null
    try {
        Assert-SafeStagingPath $StagingRoot
        New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
        $stagingLock = Open-StagingDirectoryLock $StagingRoot
        Assert-SafeStagingPath $StagingRoot
        [int64]$writtenTotal = 0
        foreach ($entry in $validated.Archive.Entries) {
            $destination = [IO.Path]::GetFullPath((Join-Path $StagingRoot $entry.FullName))
            Assert-SafeStagingPath $StagingRoot $destination
            $input = $entry.Open()
            $output = [IO.FileStream]::new($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = [byte[]]::new(1MB)
                [int64]$entryWritten = 0
                while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $entryWritten += $count; $writtenTotal += $count
                    if ($entryWritten -gt [int64]$entry.Length -or $writtenTotal -gt $MaxTotalExpandedBytes -or ($entry.FullName -ceq $validated.VhdName -and $entryWritten -gt $MaxVhdBytes)) { throw 'The advanced package exceeded its declared extraction bounds.' }
                    $output.Write($buffer, 0, $count)
                }
                if ($entryWritten -ne [int64]$entry.Length) { throw 'The advanced package entry length did not match bytes extracted.' }
            } finally { $output.Dispose(); $input.Dispose() }
            Assert-SafeStagingPath $StagingRoot $destination
        }
        Close-StagingDirectoryLock $stagingLock -KeepDirectoryHandle
        Assert-StagingEntities $StagingRoot @('manifest.json', $validated.VhdName)
        return $validated.Manifest
    } catch {
        if (Test-Path -LiteralPath $StagingRoot) { Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
        throw
    } finally {
        if ($stagingLock) { Close-StagingDirectoryLock $stagingLock }
        $validated.Archive.Dispose()
        # Windows PowerShell 5 can retain a ZipArchiveEntry wrapper until the
        # finalizer pass even after its archive is disposed.
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    }
}

if ($TestHelpersOnly) { return }

$hostAction = [string]$env:PHOTOFLOW_COMPONENT_LIFECYCLE_ACTION
if ($hostAction -eq 'preflight') { $CheckOnly = $true }
if ($hostAction -eq 'repair') { $Repair = $true }
if (-not $ExpectedComponentVersion.Trim()) { $ExpectedComponentVersion = [string]$env:PHOTOFLOW_COMPONENT_VERSION }
if ($ExpectedAdvancedRuntimeApiVersion -le 0 -and $env:PHOTOFLOW_COMPONENT_ADVANCED_RUNTIME_API_VERSION) { $ExpectedAdvancedRuntimeApiVersion = [int]$env:PHOTOFLOW_COMPONENT_ADVANCED_RUNTIME_API_VERSION }
if ($DistroName -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid WSL distribution name' }
if ($LinuxUser -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Invalid Linux user name' }
$componentDataRoot = [string]$env:PHOTOFLOW_COMPONENT_DATA_ROOT
if (-not $componentDataRoot.Trim()) {
    if (-not [string]$env:LOCALAPPDATA) { throw 'The Host did not grant a controlled component data root.' }
    $componentDataRoot = Join-Path $env:LOCALAPPDATA 'PhotoFlow\components\team-retouch'
}
$componentDataRoot = [IO.Path]::GetFullPath($componentDataRoot).TrimEnd('\')
if (-not $InstallRoot.Trim()) { $InstallRoot = Join-Path $componentDataRoot 'advanced\wsl\PhotoFlowNative' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if (-not $InstallRoot.StartsWith($componentDataRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The advanced environment must be installed inside the Host-controlled component data root.' }
$stateRoot = Join-Path $componentDataRoot 'advanced'
$statePath = Join-Path $stateRoot 'install-state.json'
$markerPath = Join-Path $InstallRoot '.photoflow-team-retouch-owner.json'
$stableVhd = Join-Path $InstallRoot 'ext4.vhdx'

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL 2 is not installed.' }
& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) { throw 'WSL 2 is not ready.' }
if ($CheckOnly) { Write-Host 'OFFLINE_PREFLIGHT_OK|WSL 2 ready'; exit 0 }
$componentRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$componentRootItem = Get-Item -LiteralPath $componentRoot
if ($componentRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed component root must not be a reparse point.' }
$componentManifestPath = [IO.Path]::GetFullPath((Join-Path $componentRoot 'component.json'))
if (-not $componentManifestPath.StartsWith($componentRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed component manifest escaped the component root.' }
if (-not (Test-Path -LiteralPath $componentManifestPath -PathType Leaf)) { throw 'Installed component manifest is missing.' }
$componentManifestItem = Get-Item -LiteralPath $componentManifestPath
if ($componentManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed component manifest must not be a reparse point.' }
$componentManifest = Get-Content -LiteralPath $componentManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestComponentVersion = [string]$componentManifest.version
$manifestAdvancedRuntimeApiVersion = [int]$componentManifest.advancedRuntime.apiVersion
if (-not $ExpectedComponentVersion.Trim()) { $ExpectedComponentVersion = $manifestComponentVersion }
if ($ExpectedAdvancedRuntimeApiVersion -le 0) { $ExpectedAdvancedRuntimeApiVersion = $manifestAdvancedRuntimeApiVersion }
if ($ExpectedComponentVersion -ne $manifestComponentVersion -or $ExpectedAdvancedRuntimeApiVersion -ne $manifestAdvancedRuntimeApiVersion) { throw 'Host lifecycle contract does not match the installed component manifest.' }
$declaredPackage = [string]$componentManifest.advancedRuntime.offlinePackage.path
$declaredPackageSha256 = [string]$componentManifest.advancedRuntime.offlinePackage.sha256
if (-not $declaredPackage -or [IO.Path]::GetFileName($declaredPackage) -ne $declaredPackage -or $declaredPackageSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Component manifest does not declare one safe advanced package and digest.' }
$ExpectedPackageSha256 = $declaredPackageSha256
$declaredPackagePath = [IO.Path]::GetFullPath((Join-Path $componentRoot $declaredPackage))
if (-not $PackagePath.Trim()) { $PackagePath = $declaredPackagePath }
$PackagePath = [IO.Path]::GetFullPath($PackagePath)
if (-not [IO.Path]::GetExtension($PackagePath).Equals('.zip', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw 'Only the component advanced .zip package is accepted.' }
if (-not $PackagePath.Equals($declaredPackagePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Only the advanced package embedded in this installed component is accepted.' }
$packageHash = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($packageHash -ne $ExpectedPackageSha256.ToLowerInvariant() -or $packageHash -ne $declaredPackageSha256.ToLowerInvariant()) { throw 'The advanced package does not match both the component manifest and Host-trusted SHA256 anchors.' }

$registration = Get-DistroRegistration $DistroName
$priorState = $null; $priorMarker = $null
if ($registration) {
    if (-not $Repair) { throw 'The advanced environment is already registered. Use Repair.' }
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf) -or -not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Repair refused: component ownership state is incomplete.' }
    $priorState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $priorMarker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $stateInstallRoot = [IO.Path]::GetFullPath([string]$priorState.installRoot).TrimEnd('\')
    if ([string]$priorState.componentId -ne 'team-retouch' -or [string]$priorState.distroName -ne $DistroName -or -not $stateInstallRoot.Equals($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -or [string]$priorState.ownerToken -ne [string]$priorMarker.ownerToken) { throw 'Repair refused: install-state and ownership marker do not bind this distribution.' }
    Assert-RegistrationBasePath $DistroName $InstallRoot | Out-Null
} elseif ($Repair) { throw 'Repair refused: the component-owned WSL distribution is not registered.' }

if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe is required.' }
$stagingRoot = Join-Path $stateRoot ('.offline-stage-' + [Guid]::NewGuid().ToString('N'))
$candidateRoot = Join-Path $stateRoot ('.candidate-' + [Guid]::NewGuid().ToString('N'))
$candidateName = "$DistroName-candidate-$([Guid]::NewGuid().ToString('N'))"
$backupVhd = Join-Path $stateRoot ('.rollback-' + [Guid]::NewGuid().ToString('N') + '.vhdx')
$candidateRegistered = $false; $oldUnregistered = $false; $finalRegistered = $false; $finalImportAttempted = $false; $preserveBackup = $false
try {
    Assert-SafeStagingPath $stagingRoot
    Assert-SafeStagingPath $candidateRoot
    New-Item -ItemType Directory -Path $stagingRoot,$candidateRoot -Force | Out-Null
    $manifest = Expand-SafeAdvancedArchive $PackagePath $stagingRoot
    $sourceVhd = Join-Path $stagingRoot ([string]$manifest.vhdFile)
    if ([int]$manifest.formatVersion -ne 1 -or [string]$manifest.componentId -ne 'team-retouch' -or [string]$manifest.architecture -ne 'x64') { throw 'Unsupported advanced package manifest.' }
    if (-not $ExpectedComponentVersion -or [string]$manifest.componentVersion -ne $ExpectedComponentVersion) { throw 'Advanced package component version does not match exactly.' }
    if ($ExpectedAdvancedRuntimeApiVersion -le 0 -or [int]$manifest.advancedRuntimeApiVersion -ne $ExpectedAdvancedRuntimeApiVersion) { throw 'Advanced runtime API version does not match exactly.' }
    $vhdHash = (Get-FileHash -LiteralPath $sourceVhd -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($vhdHash -ne ([string]$manifest.vhdSha256).ToLowerInvariant()) { throw 'Advanced VHD checksum mismatch.' }
    $candidateVhd = Join-Path $candidateRoot 'ext4.vhdx'
    Copy-Item -LiteralPath $sourceVhd -Destination $candidateVhd
    & wsl.exe --import-in-place $candidateName $candidateVhd
    $candidateRegistered = [bool](Get-DistroRegistration $candidateName)
    if ($LASTEXITCODE -ne 0 -or -not $candidateRegistered) { throw 'Unable to register the staged advanced candidate.' }
    Assert-RegistrationBasePath $candidateName $candidateRoot | Out-Null
    Test-Distro $candidateName $LinuxUser
    Unregister-OwnedDistro $candidateName $candidateRoot
    $candidateRegistered = $false
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    if ($registration) {
        & wsl.exe --terminate $DistroName 2>$null
        Copy-Item -LiteralPath $stableVhd -Destination $backupVhd
        Unregister-OwnedDistro $DistroName $InstallRoot
        $oldUnregistered = $true
    }
    Copy-Item -LiteralPath $sourceVhd -Destination $stableVhd -Force
    $finalImportAttempted = $true
    & wsl.exe --import-in-place $DistroName $stableVhd
    $finalRegistered = [bool](Get-DistroRegistration $DistroName)
    if ($LASTEXITCODE -ne 0 -or -not $finalRegistered) { throw 'Unable to register the final advanced environment.' }
    Assert-RegistrationBasePath $DistroName $InstallRoot | Out-Null
    Test-Distro $DistroName $LinuxUser
    $ownerToken = [Guid]::NewGuid().ToString('N')
    @{ componentId='team-retouch'; distroName=$DistroName; installRoot=$InstallRoot; ownerToken=$ownerToken; version=1 } | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding UTF8
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    @{ componentId='team-retouch'; distroName=$DistroName; installRoot=$InstallRoot; ownerToken=$ownerToken; installedAt=[DateTime]::UtcNow.ToString('o'); version=3; componentVersion=[string]$manifest.componentVersion; advancedRuntimeApiVersion=[int]$manifest.advancedRuntimeApiVersion; packageSha256=$packageHash; vhdSha256=$vhdHash; offline=$true } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-Host "PhotoFlow advanced offline environment is ready in $InstallRoot"
} catch {
    $originalFailure = $_
    try { Remove-OwnedRegistrationIfPresent $candidateName $candidateRoot | Out-Null } catch { Write-Warning $_ }
    if ($finalImportAttempted) { try { Remove-OwnedRegistrationIfPresent $DistroName $InstallRoot | Out-Null } catch { Write-Warning $_ } }
    if ($oldUnregistered -and (Test-Path -LiteralPath $backupVhd -PathType Leaf)) {
        try {
            Copy-Item -LiteralPath $backupVhd -Destination $stableVhd -Force
            & wsl.exe --import-in-place $DistroName $stableVhd
            if ($LASTEXITCODE -ne 0) { throw 'Unable to re-register the previous advanced environment.' }
            Test-Distro $DistroName $LinuxUser
            if ($priorMarker) { $priorMarker | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding UTF8 }
            if ($priorState) { $priorState | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8 }
        } catch {
            $preserveBackup = $true
            Write-Warning "Rollback failed; recovery VHD was preserved at $backupVhd"
        }
    }
    if ($preserveBackup) { throw "$($originalFailure.Exception.Message) Recovery VHD: $backupVhd" }
    throw $originalFailure
} finally {
    foreach ($target in @($stagingRoot,$candidateRoot)) { if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force } }
    if (-not $preserveBackup -and (Test-Path -LiteralPath $backupVhd -PathType Leaf)) { Remove-Item -LiteralPath $backupVhd -Force }
}
