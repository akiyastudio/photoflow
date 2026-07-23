param(
    [string]$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")),
    [string]$PythonLauncher = "py"
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

$LabRoot = Join-Path $WorkspaceRoot ".model-lab"
$EnvironmentRoot = Join-Path $LabRoot "envs\plan1-cuda"
$Requirements = Join-Path $WorkspaceRoot "experiments\team-retouch-model-lab\requirements-plan1-cuda.txt"
$Verifier = Join-Path $WorkspaceRoot "experiments\team-retouch-model-lab\scripts\verify_plan1_environment.py"

New-Item -ItemType Directory -Force -Path (Join-Path $LabRoot "models") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $LabRoot "cache") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $LabRoot "inputs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $LabRoot "outputs") | Out-Null

if (-not (Test-Path (Join-Path $EnvironmentRoot "Scripts\python.exe"))) {
    Invoke-Checked -Description "Python environment creation" -Command {
        & $PythonLauncher -3.12 -m venv $EnvironmentRoot
    }
}

$Python = Join-Path $EnvironmentRoot "Scripts\python.exe"
Invoke-Checked -Description "Packaging tool installation" -Command {
    & $Python -m pip install --upgrade pip setuptools wheel
}
Invoke-Checked -Description "PyTorch CUDA runtime installation" -Command {
    & $Python -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu130
}
Invoke-Checked -Description "Plan 1 dependency installation" -Command {
    & $Python -m pip install --requirement $Requirements
}
Invoke-Checked -Description "Plan 1 environment verification" -Command {
    & $Python $Verifier
}
