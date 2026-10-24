param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$kit = Join-Path $root 'local-ai-kit'
$script = Join-Path $kit 'scripts\console.mjs'
$logDir = Join-Path $root 'logs'
$mutex = New-Object System.Threading.Mutex($false, 'Local\LocalAIUnifiedLauncher')
$locked = $false

function Find-Console {
    $needle = $script.Replace('/', '\').ToLowerInvariant()
    $owners = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $line = [string]$_.CommandLine
        $line = $line.Replace('/', '\').ToLowerInvariant()
        $line.Contains('"' + $needle + '"') -or (($line -split '\s+') -contains $needle)
    } | Select-Object -ExpandProperty ProcessId)
    if ($owners.Count -eq 0) { return }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
        $_.OwningProcess -in $owners -and $_.LocalPort -ge 7790 -and $_.LocalPort -lt 7800 -and $_.LocalAddress -eq '127.0.0.1'
    })
    foreach ($listener in $listeners) {
        $url = 'http://127.0.0.1:' + $listener.LocalPort + '/'
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 6
            if ($response.StatusCode -eq 200 -and $response.Content -match 'console.js') {
                return [pscustomobject]@{Url=$url; ProcessId=$listener.OwningProcess}
            }
        } catch { }
    }
}

try {
    $locked = $mutex.WaitOne(45000)
    if (-not $locked) { throw 'Local AI is still starting. Please try again shortly.' }
    $console = Find-Console
    $reused = [bool]$console
    if (-not $console) {
        if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Missing console: $script" }
        $node = Join-Path $kit 'node\node.exe'
        if (-not (Test-Path -LiteralPath $node)) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
        if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $previousBrowser = $env:LOCALAI_NO_BROWSER
        $previousOptions = $env:NODE_OPTIONS
        try {
            $env:LOCALAI_NO_BROWSER = '1'
            $env:NODE_OPTIONS = $null
            $child = Start-Process -FilePath $node -ArgumentList ('"' + $script + '"') -WorkingDirectory $kit -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'unified-console.stdout.log') -RedirectStandardError (Join-Path $logDir 'unified-console.stderr.log')
        } finally {
            $env:LOCALAI_NO_BROWSER = $previousBrowser
            $env:NODE_OPTIONS = $previousOptions
        }
        $deadline = (Get-Date).AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 400
            $console = Find-Console
            if ($console) { break }
            $child.Refresh()
            if ($child.HasExited) { throw "Console failed to start. See $logDir\unified-console.stderr.log" }
        } while ((Get-Date) -lt $deadline)
        if (-not $console) { throw "Console startup timed out. See $logDir\unified-console.stderr.log" }
    }
    if (-not $NoBrowser) { Start-Process $console.Url }
    [pscustomobject]@{Url=$console.Url; ProcessId=$console.ProcessId; Reused=$reused} | ConvertTo-Json -Compress
} catch {
    if (-not $NoBrowser) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Local AI') | Out-Null
    }
    throw
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
