param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$repo = Join-Path $cfg.deploymentRoot 'workbench'
$engineScript = Join-Path $cfg.strataHome 'serve\server.py'
$webScript = Join-Path $repo 'webui\server.py'
$dshScript = Join-Path $cfg.dshDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$logDir = Join-Path $cfg.deploymentRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Listeners([int]$Port) {
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}
function Owned($ProcessId, [string]$Script) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $p -or -not $p.CommandLine -or $p.Name -notmatch '^(pythonw?|node)\.exe$') { return $false }
    $command = $p.CommandLine.Replace('/', '\').ToLowerInvariant()
    $needle = $Script.Replace('/', '\').ToLowerInvariant()
    # Require the complete quoted argument, or a whole unquoted argument.
    $quoted = '"' + $needle + '"'
    return $command.Contains($quoted) -or (($command -split '\s+') -contains $needle)
}
function Launch([string]$Exe, [string]$Arguments, [string]$WorkingDir, [string]$Name) {
    if ($cfg.dryRun) { return }
    Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $WorkingDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "$Name.stdout.log") `
        -RedirectStandardError (Join-Path $logDir "$Name.stderr.log") | Out-Null
}
function Check-Port([int]$Port, [string]$Script) {
    $owners = @(Listeners $Port)
    foreach ($owner in $owners) {
        if (-not (Owned $owner $Script)) { throw "Port $Port belongs to a different application (PID $owner)." }
    }
    return $owners.Count -gt 0
}

if ($cfg.action -eq 'stop') {
    $stopped = @(); $refused = @()
    foreach ($entry in @(@($cfg.dshPort, $dshScript), @($cfg.webPort, $webScript), @($cfg.enginePort, $engineScript))) {
        $owners = @(Listeners $entry[0])
        foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='node.exe'")) {
            if (Owned $candidate.ProcessId $entry[1]) { $owners += $candidate.ProcessId }
        }
        foreach ($owner in @($owners | Select-Object -Unique)) {
            if (-not (Owned $owner $entry[1])) { $refused += $owner; continue }
            if (-not $cfg.dryRun) {
                & taskkill.exe /PID $owner /T /F 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) { $refused += $owner; continue }
            }
            $stopped += $owner
        }
    }
    @{ok=($refused.Count -eq 0); stopped=@($stopped); refused=@($refused); dryRun=[bool]$cfg.dryRun} | ConvertTo-Json -Compress
    exit 0
}

$engineUp = Check-Port $cfg.enginePort $engineScript
$engineStarting = $false
if (-not $engineUp) {
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='python.exe'")) {
        if (Owned $candidate.ProcessId $engineScript) { $engineStarting = $true; break }
    }
}
if ($cfg.action -eq 'webui' -and -not $engineUp) { throw 'Start the Strata engine first, then open WebUI.' }
$targetScript = if ($cfg.action -eq 'webui') { $webScript } else { $dshScript }
$targetPort = if ($cfg.action -eq 'webui') { $cfg.webPort } else { $cfg.dshPort }
$targetUp = if ($cfg.action -eq 'engine') { $engineUp -or $engineStarting } else { Check-Port $targetPort $targetScript }
if (-not $targetUp -and $cfg.action -ne 'engine') {
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='node.exe'")) {
        if (Owned $candidate.ProcessId $targetScript) { $targetUp = $true; break }
    }
}

if (-not $engineUp -and -not $engineStarting) {
    # Existing launcher retains the deployment's VRAM preflight and model configuration.
    $env:STRATA_HOME = $cfg.strataHome
    $env:STRATA_PORT = [string]$cfg.enginePort
    $launcher = Join-Path $repo 'tools\run-strata.bat'
    Launch $env:ComSpec ('/d /s /c ""' + $launcher + '" <nul"') $repo 'kit-engine'
}
if ($cfg.action -eq 'webui' -and -not $targetUp) {
    $env:STRATA_BASE_URL = 'http://127.0.0.1:' + $cfg.enginePort + '/v1'
    $env:STRATA_WEB_HOST = '127.0.0.1'
    $env:STRATA_WEB_PORT = [string]$cfg.webPort
    Launch $cfg.pythonExe ('"' + $webScript + '"') (Split-Path $webScript) 'kit-webui'
}
if ($cfg.action -eq 'workbench' -and -not $targetUp) {
    if ($cfg.dshHome) { $env:DSH_HOME = $cfg.dshHome }
    Launch $cfg.nodeExe ('"' + $dshScript + '" web --host 127.0.0.1 --port ' + $cfg.dshPort) $cfg.dshDir 'kit-dsh'
}
@{ok=$true; accepted=$true; alreadyRunning=[bool]$targetUp; dryRun=[bool]$cfg.dryRun} | ConvertTo-Json -Compress
