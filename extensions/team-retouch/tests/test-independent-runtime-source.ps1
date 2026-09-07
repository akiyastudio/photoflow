$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\advanced-installer\setup-team-retouch-advanced.ps1') -TestHelpersOnly
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('team-runtime-source-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $zip = Join-Path $fixture 'runtime.zip'
    [IO.File]::WriteAllText($zip, 'synthetic selection fixture')
    $record = $fixture
    $digest = 'a' * 64
    $manifest = @{version='26.9.7'; advancedRuntime=@{apiVersion=1;packageVersion='26.9.4';externalPackage=@{path='runtime.zip';sha256=$digest}}}
    $first = Resolve-AdvancedPackageSource $manifest $fixture '' $record
    if ($first.Path -ne $zip -or -not $first.External -or $first.Sha256 -ne $digest) { throw 'External selection failed' }
    $manifest.version = '26.9.8'
    $next = Resolve-AdvancedPackageSource $manifest $fixture '' $record
    if ($next.Path -ne $zip) { throw 'Plugin update lost the independent runtime source' }
    $manifest.advancedRuntime.externalPackage.path = 'missing.zip'
    $rejected = $false
    try { Resolve-AdvancedPackageSource $manifest $fixture '' $record | Out-Null } catch { $rejected = $_.Exception.Message -match 'ADVANCED_PACKAGE_MISSING' }
    if (-not $rejected) { throw 'Missing runtime did not produce a useful directory error' }
    $manifest.advancedRuntime.externalPackage.path = 'runtime.zip'
    $manifest.advancedRuntime.externalPackage.sha256 = 'invalid'
    $rejected = $false
    try { Resolve-AdvancedPackageSource $manifest $fixture $zip $record | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Missing trusted digest accepted' }
    $priorProgramFiles = $env:ProgramFiles
    try {
        $env:ProgramFiles = ''
        function Test-NvidiaQuery {
            if (-not $env:ProgramFiles) { throw 'NVML requires ProgramFiles' }
            $global:LASTEXITCODE = 0
            return @('N/A', '12.0')
        }
        if ((Get-AdvancedGpuCapability 'Test-NvidiaQuery') -ne 12) { throw 'GPU capability parsing failed' }
        if ($env:ProgramFiles) { throw 'GPU query did not restore the calling environment' }
        function Test-NvidiaFailure { $global:LASTEXITCODE = 255; return 'Failed to initialize NVML' }
        $rejected = $false
        try { Get-AdvancedGpuCapability 'Test-NvidiaFailure' | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'Failed GPU query was accepted' }
    } finally { $env:ProgramFiles = $priorProgramFiles }
    Write-Host 'Independent runtime source selection and plugin-update reuse passed'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped temporary root' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
