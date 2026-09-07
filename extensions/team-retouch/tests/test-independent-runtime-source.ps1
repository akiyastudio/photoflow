$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\advanced-installer\setup-team-retouch-advanced.ps1') -TestHelpersOnly
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('team-runtime-source-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $zip = Join-Path $fixture 'standalone.zip'
    [IO.File]::WriteAllText($zip, 'synthetic selection fixture')
    $record = Join-Path $fixture 'source.json'
    $digest = 'a' * 64
    $manifest = @{version='26.9.7'; advancedRuntime=@{apiVersion=1;packageVersion='26.9.4';externalPackage=@{path='runtime.zip';sha256=$digest}}}
    $script:selectionCount = 0
    function Select-AdvancedPackageFile { $script:selectionCount++; return $zip }
    $first = Resolve-AdvancedPackageSource $manifest $fixture '' $record
    if ($first.Path -ne $zip -or -not $first.External -or $first.Sha256 -ne $digest) { throw 'External selection failed' }
    Write-JsonAtomic $record @{path=$zip;sha256=$digest}
    $manifest.version = '26.9.8'
    $next = Resolve-AdvancedPackageSource $manifest $fixture '' $record
    if ($next.Path -ne $zip -or $script:selectionCount -ne 1) { throw 'Plugin update lost the independent runtime source' }
    $manifest.advancedRuntime.externalPackage.sha256 = 'b' * 64
    Resolve-AdvancedPackageSource $manifest $fixture '' $record | Out-Null
    if ($script:selectionCount -ne 2) { throw 'Changed runtime must not reuse a stale selection' }
    $manifest.advancedRuntime.externalPackage.sha256 = 'invalid'
    $rejected = $false
    try { Resolve-AdvancedPackageSource $manifest $fixture $zip $record | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Missing trusted digest accepted' }
    Write-Host 'Independent runtime source selection and plugin-update reuse passed'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped temporary root' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
