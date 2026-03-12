$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    $uiHost = if ([string]::IsNullOrWhiteSpace($env:COMPANION_UI_HOST)) { "127.0.0.1" } else { $env:COMPANION_UI_HOST }
    $startPort = if ([string]::IsNullOrWhiteSpace($env:COMPANION_UI_PORT)) { 3000 } else { [int]$env:COMPANION_UI_PORT }
    $maxPort = if ([string]::IsNullOrWhiteSpace($env:COMPANION_UI_MAX_PORT)) { ($startPort + 20) } else { [int]$env:COMPANION_UI_MAX_PORT }
    $verboseLogging = @("1", "true", "yes", "on") -contains ([string]$env:COMPANION_VERBOSE_LOGGING).Trim().ToLowerInvariant()
    $hostApiCandidates = @(
        "http://127.0.0.1:8082",
        "http://127.0.0.1:18082",
        "http://127.0.0.1:8000"
    )

    if ($maxPort -lt $startPort) {
        throw "COMPANION_UI_MAX_PORT ($maxPort) must be >= COMPANION_UI_PORT ($startPort)."
    }

    function Test-PortAvailable {
        param(
            [string]$BindHost,
            [int]$Port
        )
        try {
            $address = [System.Net.Dns]::GetHostAddresses($BindHost) | Select-Object -First 1
            $listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
            $listener.Start()
            $listener.Stop()
            return $true
        } catch {
            return $false
        }
    }

    function Test-HostApiReachable {
        param(
            [string]$BaseUrl
        )
        $client = $null
        $waitHandle = $null
        try {
            $uri = [System.Uri]$BaseUrl
            $client = [System.Net.Sockets.TcpClient]::new()
            $asyncResult = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
            $waitHandle = $asyncResult.AsyncWaitHandle
            if (-not $waitHandle.WaitOne(500)) {
                return $false
            }
            $client.EndConnect($asyncResult)
            return $true
        } catch {
            return $false
        } finally {
            if ($waitHandle) {
                $waitHandle.Dispose()
            }
            if ($client) {
                $client.Dispose()
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:COMPANION_HOST_BASE_URL)) {
        foreach ($candidateBaseUrl in $hostApiCandidates) {
            if (Test-HostApiReachable -BaseUrl $candidateBaseUrl) {
                $env:COMPANION_HOST_BASE_URL = $candidateBaseUrl
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($env:COMPANION_HOST_BASE_URL)) {
            $env:COMPANION_HOST_BASE_URL = $hostApiCandidates[0]
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:COMPANION_API_KEY)) {
        foreach ($fallbackVar in @("ORKET_COMPANION_API_KEY", "ORKET_API_KEY")) {
            $fallbackValue = (Get-Item -Path "Env:$fallbackVar" -ErrorAction SilentlyContinue).Value
            if (-not [string]::IsNullOrWhiteSpace($fallbackValue)) {
                $env:COMPANION_API_KEY = $fallbackValue
                break
            }
        }
    }

    $uiPort = $null
    for ($candidate = $startPort; $candidate -le $maxPort; $candidate++) {
        if (Test-PortAvailable -BindHost $uiHost -Port $candidate) {
            $uiPort = $candidate
            break
        }
    }

    if ($null -eq $uiPort) {
        throw "No open UI port found in range $startPort-$maxPort on $uiHost."
    }

    $uvicornArgs = @(
        "-m",
        "uvicorn",
        "companion_app.server:app",
        "--app-dir",
        "src",
        "--host",
        $uiHost,
        "--port",
        "$uiPort"
    )
    if (-not $verboseLogging) {
        $uvicornArgs += @("--no-access-log", "--log-level", "critical")
    }

    python @uvicornArgs
}
finally {
    Pop-Location
}
