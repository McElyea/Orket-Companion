$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    function Import-DotEnvFiles {
        param(
            [string[]]$Paths
        )

        $fileValues = @{}
        $loadedPaths = New-Object System.Collections.Generic.List[string]

        foreach ($path in $Paths) {
            if (-not (Test-Path -LiteralPath $path)) {
                continue
            }
            $loadedPaths.Add($path)
            foreach ($rawLine in Get-Content -LiteralPath $path) {
                $line = [string]$rawLine
                if ([string]::IsNullOrWhiteSpace($line)) {
                    continue
                }
                $trimmed = $line.Trim()
                if ($trimmed.StartsWith("#")) {
                    continue
                }
                if ($trimmed.StartsWith("export ")) {
                    $trimmed = $trimmed.Substring(7).TrimStart()
                }
                $separatorIndex = $trimmed.IndexOf("=")
                if ($separatorIndex -le 0) {
                    continue
                }
                $name = $trimmed.Substring(0, $separatorIndex).Trim()
                if ($name -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
                    continue
                }
                $value = $trimmed.Substring($separatorIndex + 1).Trim()
                if ($value.Length -ge 2) {
                    $quotedWithDouble = $value.StartsWith('"') -and $value.EndsWith('"')
                    $quotedWithSingle = $value.StartsWith("'") -and $value.EndsWith("'")
                    if ($quotedWithDouble -or $quotedWithSingle) {
                        $value = $value.Substring(1, $value.Length - 2)
                    }
                }
                $fileValues[$name] = $value
            }
        }

        foreach ($entry in $fileValues.GetEnumerator()) {
            $existingValue = (Get-Item -Path "Env:$($entry.Key)" -ErrorAction SilentlyContinue).Value
            if ([string]::IsNullOrWhiteSpace($existingValue)) {
                Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
            }
        }

        return $loadedPaths
    }

    $loadedEnvFiles = @(Import-DotEnvFiles -Paths @(
        (Join-Path $repoRoot ".env"),
        (Join-Path $repoRoot ".env.local")
    ))
    $uiHost = if ([string]::IsNullOrWhiteSpace($env:COMPANION_UI_HOST)) { "127.0.0.1" } else { $env:COMPANION_UI_HOST }
    $startPort = if ([string]::IsNullOrWhiteSpace($env:COMPANION_UI_PORT)) { 3000 } else { [int]$env:COMPANION_UI_PORT }
    $maxPort = if ([string]::IsNullOrWhiteSpace($env:COMPANION_UI_MAX_PORT)) { ($startPort + 20) } else { [int]$env:COMPANION_UI_MAX_PORT }
    $verboseLogging = @("1", "true", "yes", "on") -contains ([string]$env:COMPANION_VERBOSE_LOGGING).Trim().ToLowerInvariant()
    $hostApiCandidates = @(
        "http://127.0.0.1:8082",
        "http://127.0.0.1:18082",
        "http://127.0.0.1:8000"
    )
    $hostApiProvided = -not [string]::IsNullOrWhiteSpace($env:COMPANION_HOST_BASE_URL)
    $resolvedHostApiFromCandidate = $null

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
                $resolvedHostApiFromCandidate = $candidateBaseUrl
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($env:COMPANION_HOST_BASE_URL)) {
            $env:COMPANION_HOST_BASE_URL = $hostApiCandidates[0]
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:COMPANION_API_KEY)) {
        foreach ($fallbackVar in @("ORKET_API_KEY")) {
            $fallbackValue = (Get-Item -Path "Env:$fallbackVar" -ErrorAction SilentlyContinue).Value
            if (-not [string]::IsNullOrWhiteSpace($fallbackValue)) {
                $env:COMPANION_API_KEY = $fallbackValue
                break
            }
        }
    }

    $missingApiKey = [string]::IsNullOrWhiteSpace($env:COMPANION_API_KEY)

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

    if (-not $hostApiProvided -and $null -eq $resolvedHostApiFromCandidate) {
        Write-Warning "No local Orket host API was reachable on $($hostApiCandidates -join ', '). Defaulting COMPANION_HOST_BASE_URL to $($env:COMPANION_HOST_BASE_URL)."
    }
    if ($missingApiKey) {
        Write-Warning "COMPANION_API_KEY is not set. Starting Companion in degraded mode; host-backed /api/* requests will fail until COMPANION_API_KEY or ORKET_API_KEY is set."
    }
    if ($loadedEnvFiles.Count -gt 0) {
        $loadedEnvFileNames = $loadedEnvFiles | ForEach-Object { Split-Path -Leaf $_ }
        Write-Host "Loaded env defaults from $($loadedEnvFileNames -join ', ')"
    }
    if ($uiPort -ne $startPort) {
        Write-Host "Companion UI port $startPort is unavailable; using $uiPort instead."
    }
    Write-Host "Launching Companion gateway/UI at http://$uiHost`:$uiPort"
    Write-Host "Host API base URL: $($env:COMPANION_HOST_BASE_URL)"
    if ($verboseLogging) {
        Write-Host "Server logging: verbose"
    } else {
        Write-Host "Server logging: quiet (set COMPANION_VERBOSE_LOGGING=1 for uvicorn startup logs)"
    }
    Write-Host "Press Ctrl+C to stop."

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
