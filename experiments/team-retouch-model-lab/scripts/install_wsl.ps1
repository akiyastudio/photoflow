$ErrorActionPreference = "Stop"

Write-Host "Installing the Windows Subsystem for Linux platform without a default distribution..."
& wsl.exe --install --no-distribution
if ($LASTEXITCODE -ne 0) {
    throw "wsl.exe --install failed with exit code $LASTEXITCODE"
}

Write-Host "WSL platform installation completed. Register the isolated PhotoflowLab distribution after any required restart."
