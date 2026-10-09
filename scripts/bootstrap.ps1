# 本地 AI 安装包 —— 前置依赖助手
#
# 用途：当电脑上没有 Node.js（或版本太旧）时，用中文说明情况，
#       并自动下载安装 Node.js，装完接着启动图形安装向导。
#
# 由「① 双击这里开始安装.cmd」在检测不到 Node.js 时调用。

param([string]$KitDir = '')

$ErrorActionPreference = 'Continue'
try { $Host.UI.RawUI.WindowTitle = 'Local AI Setup' } catch { }

function Say($text, $color) {
    if (-not $color) { $color = 'Gray' }
    Write-Host $text -ForegroundColor $color
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cands = @()
    if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
    if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
    foreach ($c in $cands) { if (Test-Path $c) { return $c } }
    return $null
}

function Get-NodeMajor($exe) {
    try {
        $v = (& $exe -v) -replace '^v', ''
        return [int](($v -split '\.')[0])
    } catch { return -1 }
}

function Get-NodeVer($exe) {
    try { return ((& $exe -v) -replace '^v', '') } catch { return '' }
}

function Start-Installer($nodeExe, $kit) {
    $script = Join-Path $kit 'scripts\installer.mjs'
    if (-not (Test-Path $script)) {
        Say "  找不到安装脚本：$script" 'Red'
        return 1
    }
    & $nodeExe $script
    return $LASTEXITCODE
}

# ---------------------------------------------------------------- 主流程

if (-not $KitDir) { $KitDir = (Get-Location).Path }

$node = Get-NodePath
$reason = ''
$oldVer = ''

if (-not $node) {
    $reason = 'missing'
} else {
    $major = Get-NodeMajor $node
    if ($major -lt 0) {
        $reason = 'missing'
    } elseif ($major -lt 20) {
        $reason = 'old'
        $oldVer = Get-NodeVer $node
    }
}

if (-not $reason) {
    $code = Start-Installer $node $KitDir
    exit $code
}

Clear-Host
Say ''
Say '  ============================================================' 'Cyan'
Say '                需要先安装 Node.js' 'White'
Say '  ============================================================' 'Cyan'
Say ''
if ($reason -eq 'old') {
    Say "  你电脑上的 Node.js 是 v$oldVer 版本，太旧了（本程序需要 20 以上）。" 'Yellow'
} else {
    Say '  这个安装程序需要 Node.js 才能运行，你的电脑上还没有安装。' 'Yellow'
}
Say ''
Say '  Node.js 是免费的开源运行环境，安装很简单。'
Say '  接下来会自动帮你完成：'
Say ''
Say '     1. 下载 Node.js 安装包（约 30 MB）'
Say '     2. 弹出 Windows 授权窗口  ——  点「是」'
Say '     3. 自动静默安装（约 1 分钟）'
Say '     4. 装好后自动继续安装本地 AI'
Say ''
Say '  不想自动安装的话，按 Ctrl+C 取消，'
Say '  自己到 https://nodejs.org 下载 LTS 版本装好，再重新双击本文件。'
Say ''
Write-Host '  按回车开始自动安装（Ctrl+C 取消）... ' -NoNewline -ForegroundColor Green
Read-Host | Out-Null
Say ''

# ---- 判断 CPU 架构（ARM 电脑要装 arm64 版，新版 Node 已不提供 32 位） ----
$cpu = $env:PROCESSOR_ARCHITEW6432
if (-not $cpu) { $cpu = $env:PROCESSOR_ARCHITECTURE }
switch ($cpu) {
    'ARM64' { $arch = 'arm64' }
    'AMD64' { $arch = 'x64' }
    default { $arch = 'x86' }
}

# 让旧版 Windows 的 PowerShell 也能用 TLS 1.2 连 nodejs.org
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# ---- 查询最新的、提供本机安装包的 LTS 版本 ----
Say '  [1/3] 正在查询最新版本...' 'Cyan'
$lts = $null
try {
    $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30 -UseBasicParsing
    # index.json 里 arm64 只登记了 zip，但 msi 同样存在（下面会用 SHASUMS256.txt 确认）
    $lts = $idx | Where-Object {
        $_.lts -and ($_.files -contains "win-$arch-zip") -and ([int](($_.version -replace '^v', '') -split '\.')[0] -ge 20)
    } | Select-Object -First 1
} catch {
    $lts = $null
}

if (-not $lts) {
    Say ''
    Say '  连不上 nodejs.org，无法自动下载。' 'Red'
    Say ''
    Say '  请手动操作：'
    Say '    1. 浏览器会打开 Node.js 官网'
    Say '    2. 下载「LTS」版本（左边那个）'
    Say '    3. 一路点「下一步」装完'
    Say '    4. 重新双击「① 双击这里开始安装.cmd」'
    Say ''
    Start-Process 'https://nodejs.org/zh-cn/download'
    exit 1
}

$ver = $lts.version
$file = "node-$ver-$arch.msi"
$url = "https://nodejs.org/dist/$ver/$file"
$out = Join-Path $env:TEMP $file
Say "        最新 LTS：$ver ($arch)"

# ---- 下载 ----
Say '  [2/3] 正在下载...' 'Cyan'
$oldProgress = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'
$ok = $true
try {
    Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 900 -UseBasicParsing
} catch {
    $ok = $false
}
$ProgressPreference = $oldProgress

if (-not $ok -or -not (Test-Path $out)) {
    Say ''
    Say '  下载失败，请检查网络后重试。' 'Red'
    Say "  也可以手动到 https://nodejs.org/zh-cn/download 下载 LTS 版本。"
    exit 1
}
$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Say "        下载完成（$mb MB）"

# ---- 校验 SHA256：和 nodejs.org 公布的校验值对不上就不安装 ----
$expected = $null
try {
    $sums = Invoke-RestMethod -Uri "https://nodejs.org/dist/$ver/SHASUMS256.txt" -TimeoutSec 30 -UseBasicParsing
    foreach ($line in ($sums -split "`n")) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -eq 2 -and $parts[1] -eq $file) { $expected = $parts[0].ToLower() }
    }
} catch { $expected = $null }
$actual = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected -ne $actual) {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    Say ''
    Say '  安装包校验失败（文件可能损坏或被篡改），已删除，没有安装。' 'Red'
    Say '  请重试，或手动到 https://nodejs.org/zh-cn/download 下载 LTS 版本。'
    exit 1
}
Say '        校验通过'

# ---- 安装 ----
Say '  [3/3] 正在安装 —— 请在弹出窗口点「是」授权' 'Cyan'
Say ''
$exit = 1
try {
    $p = Start-Process -FilePath 'msiexec.exe' `
        -ArgumentList "/i `"$out`" /qb /norestart" `
        -Verb RunAs -Wait -PassThru
    $exit = $p.ExitCode
} catch {
    Say ''
    Say '  没有获得授权，安装已取消。' 'Yellow'
    Say '  你可以右键本文件选「以管理员身份运行」再试一次。'
    exit 1
}

if ($exit -ne 0) {
    Say ''
    Say "  安装程序返回错误码 $exit。" 'Red'
    Say '  请手动到 https://nodejs.org/zh-cn/download 下载 LTS 版本安装。'
    exit 1
}

# ---- 重新查找并继续 ----
$node2 = Get-NodePath
if (-not $node2) {
    Say ''
    Say '  Node.js 已安装，但当前窗口还看不到它。' 'Yellow'
    Say '  请【重新双击】「① 双击这里开始安装.cmd」，就能继续了。'
    Say '  （或者重启电脑后重试）'
    exit 0
}

Say ''
Say '  Node.js 安装成功，正在继续安装本地 AI ...' 'Green'
Say ''
Start-Sleep -Seconds 2
$code = Start-Installer $node2 $KitDir
exit $code
