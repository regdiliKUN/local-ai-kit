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
<# 判定一个进程是否"属于"某个脚本。
   传入已取好的进程对象，不要再按 PID 二次查 CIM —— 本机 node 进程动辄十个以上
   （各种 Electron / 助手应用），stop 时逐个再查一次，N+1 次 WMI 调用能把单次操作
   拖到 30~40 秒，用户以为"点了没反应"。 #>
function OwnedCim($p, [string]$Script) {
    if (-not $p -or -not $p.CommandLine -or $p.Name -notmatch '^(pythonw?|node)\.exe$') { return $false }
    $command = $p.CommandLine.Replace('/', '\').ToLowerInvariant()
    $needle = $Script.Replace('/', '\').ToLowerInvariant()
    # Require the complete quoted argument, or a whole unquoted argument.
    $quoted = '"' + $needle + '"'
    return $command.Contains($quoted) -or (($command -split '\s+') -contains $needle)
}
function Owned($ProcessId, [string]$Script) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    return (OwnedCim $p $Script)
}
function Launch([string]$Exe, [string]$Arguments, [string]$WorkingDir, [string]$Name) {
    if ($cfg.dryRun) { return }
    Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $WorkingDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir "$Name.stdout.log") `
        -RedirectStandardError (Join-Path $logDir "$Name.stderr.log") | Out-Null
}
function Check-Port([int]$Port, [string]$Script) {
    $owners = @(Listeners $Port)
    if ($owners.Count -gt 0) {
        # 一次拿齐这些 PID 的命令行，别逐个查 CIM
        $watch = @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='node.exe'")
        foreach ($owner in $owners) {
            $p_ = $watch | Where-Object { $_.ProcessId -eq $owner }
            if ($p_.Count -gt 1) { throw "Port $Port is ambiguous: $owner maps to several processes." }
            if (-not (OwnedCim $p_ $Script)) { throw "Port $Port belongs to a different application (PID $owner)." }
        }
    }
    return $owners.Count -gt 0
}

if ($cfg.action -eq 'stop') {
    $stopped = @(); $refused = @()
    foreach ($entry in @(@($cfg.dshPort, $dshScript), @($cfg.webPort, $webScript), @($cfg.enginePort, $engineScript))) {
        # 一次查全，别在这循环里再按 PID 逐个查 CIM（N+1 WMI 会把这步拖成 30 秒+）
        $pids = @(Listeners $entry[0])
        $watch = @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='node.exe'")
        $owners = @()
        foreach ($pid_ in $pids) { $owners += $pid_ }
        foreach ($candidate in $watch) {
            if (OwnedCim $candidate $entry[1]) { $owners += $candidate.ProcessId }
        }
        foreach ($owner in @($owners | Select-Object -Unique)) {
            $p_ = $watch | Where-Object { $_.ProcessId -eq $owner }
            if (-not $p_) {
                # 端口占用者不是 python/node：单独查一次确认归属
                $p_ = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
                if (-not $p_ -or -not (OwnedCim $p_ $entry[1])) { $refused += $owner; continue }
            } elseif (-not (OwnedCim $p_ $entry[1])) {
                $refused += $owner; continue
            }
            if (-not $cfg.dryRun) {
                # 用 Start-Process 调 taskkill：原生命令写 stderr 在 ErrorActionPreference=Stop 下
                # 会变成 NativeCommandError 直接终止整个脚本（上一轮 /T 连带杀掉后就会这样）。
                $alive = Get-Process -Id $owner -ErrorAction SilentlyContinue
                if ($alive) {
                    $killer = Start-Process -FilePath 'taskkill.exe' -ArgumentList "/PID $owner /T /F" -WindowStyle Hidden -PassThru -Wait
                    if ($killer.ExitCode -ne 0) { $refused += $owner; continue }
                }
                # 已经不在 = 已被连带杀掉，同样算停成功
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
        if (OwnedCim $candidate $engineScript) { $engineStarting = $true; break }
    }
}
if ($cfg.action -eq 'webui' -and -not $engineUp) { throw 'Start the Strata engine first, then open WebUI.' }
$targetScript = if ($cfg.action -eq 'webui') { $webScript } else { $dshScript }
$targetPort = if ($cfg.action -eq 'webui') { $cfg.webPort } else { $cfg.dshPort }
$targetUp = if ($cfg.action -eq 'engine') { $engineUp -or $engineStarting } else { Check-Port $targetPort $targetScript }
if (-not $targetUp -and $cfg.action -ne 'engine') {
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='node.exe'")) {
        if (OwnedCim $candidate $targetScript) { $targetUp = $true; break }
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
