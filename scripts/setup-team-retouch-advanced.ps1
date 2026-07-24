param(
    [string]$DistroName = 'PhotoFlowNative',
    [string]$LinuxUser = 'photoflowlab'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LinuxSetupWindows = Join-Path $PSScriptRoot 'setup-team-retouch-advanced-wsl.sh'

function Invoke-WslChecked {
    param([string]$User, [string]$Command, [string]$Description)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
    & wsl.exe -d $DistroName -u $User -- bash -lc "printf %s $encoded | base64 --decode | bash"
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

if ($LinuxUser -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Invalid Linux user name' }
$stableVhd = Join-Path $env:LOCALAPPDATA 'PhotoFlow\wsl\PhotoFlowNative\ext4.vhdx'
if (-not (Test-Path -LiteralPath $stableVhd -PathType Leaf)) {
    throw "Stable PhotoFlowNative disk is missing: $stableVhd"
}

$baseSetup = @"
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=5 update
apt-get -o Acquire::Retries=5 install -y --fix-missing ca-certificates curl git build-essential pkg-config libgl1 libglib2.0-0 unzip
if ! id -u '$LinuxUser' >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash '$LinuxUser'
fi
install -d -o '$LinuxUser' -g '$LinuxUser' \
    '/home/$LinuxUser/model-lab' \
    '/home/$LinuxUser/model-lab/repos' \
    '/home/$LinuxUser/model-lab/checkpoints' \
    '/home/$LinuxUser/model-lab/env-locks'
"@
Invoke-WslChecked -User root -Command $baseSetup -Description 'WSL base setup'

$miniforgeSetup = @'
set -euo pipefail
install_root="$HOME/miniforge3"
lab_root="$HOME/model-lab"
installer="$(mktemp --suffix=.sh)"
version="26.3.2-3"
expected="848194851a98903134187fbb4ab50efe87b003e0c0f808f97644b7524a62bf2c"
url="https://github.com/conda-forge/miniforge/releases/download/${version}/Miniforge3-${version}-Linux-x86_64.sh"
if [ ! -x "$install_root/bin/conda" ]; then
    curl -fsSL --retry 5 -o "$installer" "$url"
    actual="$(sha256sum "$installer" | awk '{print $1}')"
    test "$expected" = "$actual"
    bash "$installer" -b -p "$install_root"
fi
rm -f "$installer"
"$install_root/bin/conda" config --set auto_activate_base false
'@
Invoke-WslChecked -User $LinuxUser -Command $miniforgeSetup -Description 'Miniforge setup'

$setupFullPath = [IO.Path]::GetFullPath($LinuxSetupWindows)
if ($setupFullPath -notmatch '^([A-Za-z]):\\(.+)$') { throw 'Unable to resolve the WSL setup script path' }
$wslSetup = '/mnt/{0}/{1}' -f $Matches[1].ToLowerInvariant(), $Matches[2].Replace('\', '/')
& wsl.exe -d $DistroName -u $LinuxUser -- bash $wslSetup
if ($LASTEXITCODE -ne 0) { throw "Advanced environment setup failed with exit code $LASTEXITCODE" }

& wsl.exe --manage $DistroName --set-default-user $LinuxUser
if ($LASTEXITCODE -ne 0) { throw 'Unable to set the PhotoFlowNative default user' }

Write-Host "PhotoFlow advanced environment is ready in $stableVhd"
