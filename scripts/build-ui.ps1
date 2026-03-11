$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    npm --prefix UI install
    npm --prefix UI run build

    Write-Host "Frontend build complete."
}
finally {
    Pop-Location
}