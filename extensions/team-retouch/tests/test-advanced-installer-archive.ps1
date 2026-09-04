$ErrorActionPreference = 'Stop'
$setup = Join-Path (Split-Path -Parent $PSScriptRoot) 'advanced-installer\setup-team-retouch-advanced.ps1'
. $setup -TestHelpersOnly
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-TestArchive([string]$Path, [object[]]$Entries) {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($spec in $Entries) {
            $entry = $zip.CreateEntry([string]$spec.Name)
            if ($spec.Attributes -ne $null) { $entry.ExternalAttributes = [int]$spec.Attributes }
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.Encoding]::UTF8)
            try { $writer.Write([string]$spec.Data) } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('team-retouch-archive-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$caught = $null
try {
    $vhdBytes = [byte[]]([Text.Encoding]::UTF8.GetPreamble() + [Text.Encoding]::UTF8.GetBytes('vhd'))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $vhdDigest = ([BitConverter]::ToString($sha.ComputeHash($vhdBytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    $manifest = "{`"formatVersion`":1,`"componentId`":`"team-retouch`",`"architecture`":`"x64`",`"vhdFile`":`"PhotoFlowNative.vhdx`",`"vhdSha256`":`"$vhdDigest`",`"installedSizeBytes`":$($vhdBytes.Length)}"
    $regular = @(@{Name='manifest.json';Data=$manifest;Attributes=$null}, @{Name='PhotoFlowNative.vhdx';Data='vhd';Attributes=$null})
    $valid = Join-Path $root 'valid.zip'; New-TestArchive $valid $regular
    $opened = Open-ValidatedAdvancedArchive $valid
    try {
        if ([string]$opened.Manifest.vhdFile -ne 'PhotoFlowNative.vhdx' -or [string]$opened.PackageSha256 -notmatch '^[a-f0-9]{64}$') { throw 'valid strict archive did not validate' }
        $copyRoot = Join-Path $root 'direct-copy'; New-Item -ItemType Directory -Path $copyRoot | Out-Null
        $env:PHOTOFLOW_COMPONENT_DATA_ROOT = $root
        $copied = Join-Path $copyRoot 'ext4.vhdx'
        if ((Copy-ValidatedVhdEntry $opened $copied) -ne $vhdDigest -or -not (Test-Path -LiteralPath $copied) -or (Test-Path -LiteralPath (Join-Path $copyRoot 'manifest.json'))) { throw 'trusted VHD entry was not copied directly and exclusively' }
    }
    finally { Close-ValidatedAdvancedArchive $opened }

    $lockedRoot = Join-Path $root 'locked-stage'; $outsideRoot = Join-Path $root 'outside'
    New-Item -ItemType Directory -Path $lockedRoot,$outsideRoot | Out-Null
    $lock = Open-StagingDirectoryLock $lockedRoot
    try {
        try { Remove-Item -LiteralPath $lockedRoot -Recurse -Force -ErrorAction Stop } catch { }
        try { New-Item -ItemType Junction -Path $lockedRoot -Target $outsideRoot -ErrorAction Stop | Out-Null } catch { }
        $lockedItem = Get-Item -LiteralPath $lockedRoot -Force
        if (-not $lockedItem.PSIsContainer -or ($lockedItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'locked staging root was replaceable during extraction' }
        if (@(Get-ChildItem -LiteralPath $outsideRoot -Force).Count) { throw 'locked staging replacement wrote outside the component root' }
    } finally { Close-StagingDirectoryLock $lock }

    $linkAttributes = -1577123840 # signed Int32 representation of Unix symlink mode 0120777
    $cases = @(
        @{Name='traversal'; Entries=@(@{Name='../evil';Data='owned';Attributes=$null}, $regular[0])},
        @{Name='absolute'; Entries=@(@{Name='/evil';Data='owned';Attributes=$null}, $regular[0])},
        @{Name='unc'; Entries=@(@{Name='//server/share';Data='owned';Attributes=$null}, $regular[0])},
        @{Name='drive'; Entries=@(@{Name='C:/evil';Data='owned';Attributes=$null}, $regular[0])},
        @{Name='link'; Entries=@(@{Name='manifest.json';Data=$manifest;Attributes=$linkAttributes}, $regular[1])},
        @{Name='duplicate'; Entries=@($regular[0], $regular[0], $regular[1])}
    )
    foreach ($case in $cases) {
        $archive = Join-Path $root ($case.Name + '.zip'); New-TestArchive $archive $case.Entries
        $escaped = Join-Path $root 'evil'
        $rejected = $false
        try { $opened = Open-ValidatedAdvancedArchive $archive; Close-ValidatedAdvancedArchive $opened } catch { $rejected = $true }
        if (-not $rejected) { throw "malicious archive was accepted: $($case.Name)" }
        if (Test-Path -LiteralPath $escaped) { throw "archive wrote outside staging: $($case.Name)" }
    }
    $bombManifest = '{"formatVersion":1,"componentId":"team-retouch","architecture":"x64","vhdFile":"PhotoFlowNative.vhdx","vhdSha256":"00","installedSizeBytes":2097155}'
    $bomb = Join-Path $root 'compression-bomb.zip'
    New-TestArchive $bomb @(@{Name='manifest.json';Data=$bombManifest;Attributes=$null}, @{Name='PhotoFlowNative.vhdx';Data=('0' * 2097152);Attributes=$null})
    $bombRejected = $false
    try { $opened = Open-ValidatedAdvancedArchive $bomb; Close-ValidatedAdvancedArchive $opened } catch { $bombRejected = $true }
    if (-not $bombRejected) { throw 'high-compression archive bomb was accepted' }
    # Fault injection for the import race: the import result was already
    # reported as failed, but Lxss publishes the registration before cleanup.
    $script:lateRegistration = $null; $script:unregistered = 0
    function Get-DistroRegistration([string]$Name) { return $script:lateRegistration }
    function Get-RegistrationBasePath($Registration) { return [string]$Registration.BasePath }
    function Unregister-OwnedDistro([string]$Name, [string]$ExpectedRoot) { $script:unregistered += 1 }
    $ownedRoot = Join-Path $root 'candidate'
    $script:lateRegistration = @{ BasePath=[IO.Path]::GetFullPath($ownedRoot) }
    if (-not (Remove-OwnedRegistrationIfPresent 'failed-import-candidate' $ownedRoot) -or $script:unregistered -ne 1) { throw 'late import registration was not cleaned up' }
    $script:lateRegistration = @{ BasePath=[IO.Path]::GetFullPath((Join-Path $root 'somebody-else')) }
    $refused = $false
    try { Remove-OwnedRegistrationIfPresent 'foreign' $ownedRoot | Out-Null } catch { $refused = $true }
    if (-not $refused -or $script:unregistered -ne 1) { throw 'cleanup touched a registration outside the transaction path' }
    Write-Host 'Advanced installer strict ZIP behavior tests passed'
} catch { $caught = $_ }
finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
if ($caught) { throw $caught }
