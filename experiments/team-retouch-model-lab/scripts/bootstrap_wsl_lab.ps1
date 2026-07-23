param(
    [string]$DistroName = "PhotoflowNative",
    [string]$LinuxUser = "photoflowlab"
)

$ErrorActionPreference = "Stop"

if ($LinuxUser -notmatch '^[a-z_][a-z0-9_-]*$') {
    throw "LinuxUser must be a safe Linux account name."
}

function Invoke-WslChecked {
    param(
        [Parameter(Mandatory = $true)][string]$User,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $EncodedCommand = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($Command)
    )
    $Runner = "printf %s $EncodedCommand | base64 --decode | bash"
    & wsl.exe -d $DistroName -u $User -- bash -lc $Runner
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

& wsl.exe --system --exec /bin/true
if ($LASTEXITCODE -ne 0) {
    throw "The WSL utility VM is not healthy. Restart Windows after enabling HypervisorPlatform, then rerun this script."
}

$BaseSetup = @"
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git build-essential pkg-config libgl1 libglib2.0-0 unzip
if ! id -u '$LinuxUser' >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash '$LinuxUser'
fi
install -d -o '$LinuxUser' -g '$LinuxUser' \
    '/home/$LinuxUser/model-lab' \
    '/home/$LinuxUser/model-lab/repos' \
    '/home/$LinuxUser/model-lab/checkpoints' \
    '/home/$LinuxUser/model-lab/env-locks'
"@
Invoke-WslChecked -User "root" -Command $BaseSetup -Description "WSL base package and user setup"

$GpuCheck = @'
set -euo pipefail
if [ ! -x /usr/lib/wsl/lib/nvidia-smi ]; then
    echo WSL_NVIDIA_BRIDGE_NOT_FOUND >&2
    exit 2
fi
/usr/lib/wsl/lib/nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
'@
Invoke-WslChecked -User $LinuxUser -Command $GpuCheck -Description "WSL NVIDIA bridge verification"

$MiniforgeSetup = @'
set -euo pipefail
install_root="$HOME/miniforge3"
lab_root="$HOME/model-lab"
installer="$(mktemp --suffix=.sh)"
miniforge_version="26.3.2-3"
expected="848194851a98903134187fbb4ab50efe87b003e0c0f808f97644b7524a62bf2c"
url="https://github.com/conda-forge/miniforge/releases/download/${miniforge_version}/Miniforge3-${miniforge_version}-Linux-x86_64.sh"

if [ ! -x "$install_root/bin/conda" ]; then
    curl -fsSL --retry 3 -o "$installer" "$url"
    actual="$(sha256sum "$installer" | awk '{print $1}')"
    if [ "$expected" != "$actual" ]; then
        echo "Miniforge checksum mismatch" >&2
        exit 3
    fi
    printf '%s  %s\n' "$actual" "Miniforge3-Linux-x86_64.sh" > "$lab_root/env-locks/miniforge.sha256"
    bash "$installer" -b -p "$install_root"
fi

rm -f "$installer"
"$install_root/bin/conda" config --set auto_activate_base false
"$install_root/bin/conda" --version
'@
Invoke-WslChecked -User $LinuxUser -Command $MiniforgeSetup -Description "Miniforge installation"

& wsl.exe --manage $DistroName --set-default-user $LinuxUser
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not set the default WSL user. Subsequent scripts explicitly use -u $LinuxUser."
}

Write-Host "WSL lab base is ready in /home/$LinuxUser/model-lab."
