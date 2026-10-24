# ==============================================================
#  本地 AI 工作台  ——  菜单主界面
#
#  为什么用 PowerShell 而不是 .bat：
#    .bat 里的中文会被 cmd 按 ANSI 代码页解析，容易变乱码甚至
#    执行出错。PowerShell 脚本用 UTF-8 (BOM) 保存，中文没问题，
#    而且支持颜色、框线、实时状态检测，界面能做得像样。
#    PowerShell 是 Windows 自带的，不需要安装任何东西。
#
#  这个脚本会自动适应两种位置：
#    ① 放在 F:\本地AI\                 （工作台根目录）
#    ② 放在 <repo>\launchers\           （仓库里）
#  两种情况下都能找到 Strata、日志目录和工具。
# ==============================================================

$ErrorActionPreference = 'Continue'

# 注意：这里【不要】去改 [Console]::OutputEncoding。
# PowerShell 的 Write-Host 走 Windows 控制台的 Unicode 接口
# (WriteConsoleW)，本来就与代码页无关；反而把它改成 UTF-8、
# 而控制台仍停在 936 时，才会真的出现乱码。

# ----------------------------------------------------------------
#  路径解析：先判断自己在哪里
# ----------------------------------------------------------------
#  注意：不要用 $Home 当变量名 —— 它是 PowerShell 的只读自动变量
#  （指向用户主目录），赋值会抛 VariableNotWritable，而且失败后
#  后续逻辑会静默用错路径。
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (Test-Path (Join-Path $ScriptDir 'workbench\tools')) {
    # ① 在工作台根目录（F:\本地AI\）
    $HomeRoot   = $ScriptDir
    $RepoRoot   = Join-Path $ScriptDir 'workbench'
    $IsHome     = $true
}
elseif (Test-Path (Join-Path (Split-Path -Parent $ScriptDir) 'config\resolve.bat')) {
    # ② 在仓库的 launchers\ 里
    $RepoRoot   = Split-Path -Parent $ScriptDir
    $HomeRoot   = $RepoRoot
    $IsHome     = $false
}
else {
    $RepoRoot   = Split-Path -Parent $ScriptDir
    $HomeRoot   = $RepoRoot
    $IsHome     = $false
}

$ToolsDir = Join-Path $RepoRoot 'tools'

# ---- 默认值 ----
$StrataHome = 'F:\Strata'
$EnginePort = 8080
$WebPort    = 8090
$DshPort    = 3080
$LogDir     = Join-Path $env:LOCALAPPDATA 'strata-dsh-workbench\logs'

# ---- 若仓库里有 config\paths.bat，按它覆盖 ----
$PathsBat = Join-Path $RepoRoot 'config\paths.bat'
if (Test-Path $PathsBat) {
    $txt = Get-Content $PathsBat -Raw -ErrorAction SilentlyContinue
    foreach ($m in [regex]::Matches($txt, '(?m)^\s*set\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"')) {
        $k = $m.Groups[1].Value
        $v = [Environment]::ExpandEnvironmentVariables($m.Groups[2].Value)
        switch ($k) {
            'STRATA_HOME' { if ($v) { $StrataHome = $v } }
            'STRATA_PORT' { if ($v) { $EnginePort = [int]$v } }
            'WEB_PORT'    { if ($v) { $WebPort    = [int]$v } }
            'LOG_DIR'     { if ($v) { $LogDir     = $v } }
        }
    }
}

# ---- 启动器所在目录 ----
if ($IsHome) { $LauncherDir = $HomeRoot } else { $LauncherDir = $ScriptDir }

# ----------------------------------------------------------------
#  小工具
# ----------------------------------------------------------------

# 中文是双宽字符，.PadRight() 按「字符个数」补齐会让三列对不齐。
# 这里按显示宽度补齐：东亚全角字符算 2 列，其余算 1 列。
function Get-DisplayWidth {
    param([string]$Text)
    $w = 0
    foreach ($ch in $Text.ToCharArray()) {
        $c = [int][char]$ch
        if (($c -ge 0x1100 -and $c -le 0x115F) -or
            ($c -ge 0x2E80 -and $c -le 0xA4CF) -or
            ($c -ge 0xAC00 -and $c -le 0xD7A3) -or
            ($c -ge 0xF900 -and $c -le 0xFAFF) -or
            ($c -ge 0xFE30 -and $c -le 0xFE6F) -or
            ($c -ge 0xFF00 -and $c -le 0xFF60) -or
            ($c -ge 0xFFE0 -and $c -le 0xFFE6)) {
            $w += 2
        } else {
            $w += 1
        }
    }
    return $w
}

function Pad-Display {
    param([string]$Text, [int]$Width)
    $cur = Get-DisplayWidth $Text
    if ($cur -ge $Width) { return $Text }
    return $Text + (' ' * ($Width - $cur))
}

function Test-Port {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(300)) {
            $client.EndConnect($async)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch {
        try { $client.Close() } catch {}
        return $false
    }
}

function Get-VramFree {
    try {
        $v = & nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null
        if ($v) { return [int]($v | Select-Object -First 1) }
    } catch {}
    return $null
}

function Write-Rule {
    param([string]$Title = '')
    if ($Title) {
        Write-Host ('  ' + ('-' * 64)) -ForegroundColor DarkCyan
        Write-Host ('    ' + $Title) -ForegroundColor Cyan
        Write-Host ('  ' + ('-' * 64)) -ForegroundColor DarkCyan
    } else {
        Write-Host ('  ' + ('-' * 64)) -ForegroundColor DarkCyan
    }
}

function Write-Item {
    param(
        [string]$Key,
        [string]$Name,
        [string]$Desc,
        [string]$Hint = '',
        [string]$Color = 'Green'
    )
    Write-Host ('   [' + $Key + ']  ') -NoNewline -ForegroundColor $Color
    Write-Host (Pad-Display $Name 22) -NoNewline -ForegroundColor White
    Write-Host (Pad-Display $Desc 30) -NoNewline -ForegroundColor Gray
    if ($Hint) { Write-Host $Hint -ForegroundColor DarkGray }
    else       { Write-Host '' }
}

function Pause-AnyKey {
    Write-Host ''
    Write-Host '   按任意键返回菜单...' -ForegroundColor DarkGray
    try   { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') }
    catch { $null = Read-Host }
}

# ----------------------------------------------------------------
#  界面
# ----------------------------------------------------------------
function Show-Header {
    Clear-Host
    Write-Host ''
    Write-Host '  ================================================================' -ForegroundColor DarkCyan
    Write-Host '                     本  地  A I  工  作  台' -ForegroundColor White
    Write-Host '          Strata 125B MoE    +    DeepSeek Harness Agent' -ForegroundColor DarkGray
    Write-Host '  ================================================================' -ForegroundColor DarkCyan
    Write-Host ''
}

function Show-Status {
    $engineUp = Test-Port $EnginePort
    $webUp    = Test-Port $WebPort
    $dshUp    = Test-Port $DshPort
    $vram     = Get-VramFree

    Write-Host '   运行状态' -ForegroundColor DarkGray
    Write-Host '     ' -NoNewline

    Write-Host ('引擎 :' + $EnginePort + ' ') -NoNewline -ForegroundColor Gray
    if ($engineUp) { Write-Host '[运行中]' -NoNewline -ForegroundColor Green }
    else           { Write-Host '[未启动]' -NoNewline -ForegroundColor DarkGray }

    Write-Host '   ' -NoNewline
    Write-Host ('WebUI :' + $WebPort + ' ') -NoNewline -ForegroundColor Gray
    if ($webUp) { Write-Host '[运行中]' -NoNewline -ForegroundColor Green }
    else        { Write-Host '[未启动]' -NoNewline -ForegroundColor DarkGray }

    Write-Host '   ' -NoNewline
    Write-Host ('dsh :' + $DshPort + ' ') -NoNewline -ForegroundColor Gray
    if ($dshUp) { Write-Host '[运行中]' -ForegroundColor Green }
    else        { Write-Host '[未启动]' -ForegroundColor DarkGray }

    if ($null -ne $vram) {
        Write-Host '     ' -NoNewline
        Write-Host ('显存空闲 ' + $vram + ' MiB') -NoNewline -ForegroundColor Gray
        if ($vram -lt 3000) { Write-Host '  ← 偏低，建议关掉浏览器等占显存的程序' -ForegroundColor Yellow }
        else                { Write-Host '  ← 充足' -ForegroundColor DarkGray }
    }

    Write-Host ''
    Write-Host '   提示  ' -NoNewline -ForegroundColor DarkGray
    if ($engineUp) {
        Write-Host '引擎已就绪。要它动手干活选 [1]，只想聊天问问题选 [2]。' -ForegroundColor Green
    } else {
        Write-Host '引擎还没启动。日常使用直接选 [1]，它会自动把引擎拉起来。' -ForegroundColor Yellow
    }
    Write-Host ''
}

function Show-Menu {
    Write-Rule '启动'
    Write-Item '1' '启动工作台'     '引擎 + dsh Agent'          '打开 :3080'
    Write-Item '2' '启动 WebUI'     '对话 / 文件夹 / 提示词'    '打开 :8090'
    Write-Item '3' '只启动引擎'     '不开界面，供其它程序调用'  (':' + $EnginePort)
    Write-Host ''

    Write-Rule '维护'
    Write-Item '4' '停止全部'       '关闭引擎和 WebUI'          '' 'Red'
    Write-Item '5' '显存体检'       '检查并修正显存预留'        '防 OOM 崩溃'
    Write-Item '6' '环境自检'       '路径 / 模型 / dsh 集成'    ''
    Write-Host ''

    Write-Rule '打开'
    Write-Item '7' '日志目录'       '排查问题时先看这里'        '' 'Cyan'
    Write-Item '8' '安装目录'       'Strata 引擎与模型所在'     '' 'Cyan'
    Write-Item '9' '其它 AI 快捷方式' 'DeepSeek / OpenCode 等'  '' 'Cyan'
    Write-Host ''

    Write-Rule '帮助'
    Write-Item 'H' '中文使用说明'   '完整文档，记事本打开'      '' 'Yellow'
    Write-Item '0' '退出'           ''                          '' 'DarkGray'
    Write-Host ''
    Write-Host '   输入序号后按回车。' -NoNewline -ForegroundColor DarkGray
    Write-Host '首次使用建议直接选 [1]。' -ForegroundColor DarkGray
    Write-Host ''
}

# ----------------------------------------------------------------
#  动作
# ----------------------------------------------------------------
function Start-Launcher {
    param([string]$Bat)
    $path = Join-Path $LauncherDir $Bat
    if (-not (Test-Path $path)) {
        Write-Host ''
        Write-Host ('   找不到：' + $path) -ForegroundColor Red
        Start-Sleep -Seconds 3
        return
    }
    Start-Process -FilePath $path -WorkingDirectory $LauncherDir
    Write-Host ''
    Write-Host ('   已在新窗口启动：' + $Bat) -ForegroundColor Green
    Write-Host '   那个窗口不要关，关掉对应的服务就停了。' -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
}

function Invoke-InPlace {
    param([string]$Label, [string]$Cmd, [string[]]$CmdArgs)
    Clear-Host
    Write-Host ''
    Write-Host ('  ==  ' + $Label + '  ' + ('=' * [Math]::Max(4, 58 - $Label.Length))) -ForegroundColor Cyan
    Write-Host ''
    if (Test-Path $Cmd) {
        try { & $Cmd @CmdArgs } catch { Write-Host ('   执行出错：' + $_.Exception.Message) -ForegroundColor Red }
    } else {
        Write-Host ('   找不到：' + $Cmd) -ForegroundColor Red
    }
    Pause-AnyKey
}

function Open-Folder {
    param([string]$Path)
    if (Test-Path $Path) { Start-Process explorer.exe $Path }
    else {
        Write-Host ''
        Write-Host ('   目录不存在：' + $Path) -ForegroundColor Red
        Start-Sleep -Seconds 3
    }
}

function Find-Python {
    $c = Join-Path $StrataHome '.venv\Scripts\python.exe'
    if (Test-Path $c) { return $c }
    return 'python'
}

# ----------------------------------------------------------------
#  主循环
# ----------------------------------------------------------------
while ($true) {
    Show-Header
    Show-Status
    Show-Menu

    $choice = Read-Host '   请输入序号'

    switch ($choice.Trim().ToUpper()) {

        '1' {
            if ($IsHome) { Start-Launcher 'start-workbench.bat' }
            else         { Start-Launcher 'Strata-dsh-Workbench.bat' }
        }

        '2' {
            if (-not (Test-Port $EnginePort)) {
                Write-Host ''
                Write-Host '   注意：引擎还没启动，只开 WebUI 是问不了问题的。' -ForegroundColor Yellow
                Write-Host '         要一起启动请用 [1] 启动工作台。' -ForegroundColor Yellow
                Write-Host ''
                Write-Host '   仍要只开 WebUI 吗？(Y/N) ' -NoNewline -ForegroundColor Gray
                $ans = Read-Host
                if ($ans.Trim().ToUpper() -ne 'Y') { continue }
            }
            if ($IsHome) { Start-Launcher 'start-webui.bat' }
            else         { Start-Launcher 'Strata-WebUI.bat' }
        }

        '3' {
            if ($IsHome) { Start-Launcher 'start-engine.bat' }
            else         { Start-Launcher 'Start-Strata.bat' }
        }

        '4' {
            if ($IsHome) { $stop = Join-Path $LauncherDir 'stop-all.bat' }
            else         { $stop = Join-Path $LauncherDir 'Stop-Strata.bat' }
            Invoke-InPlace '停止全部' $stop @()
        }

        '5' { Invoke-InPlace '显存体检' (Find-Python) @((Join-Path $ToolsDir 'fix-vram-reserve.py')) }

        '6' { Invoke-InPlace '环境自检' (Join-Path $ToolsDir 'verify.bat') @() }

        '7' { Open-Folder $LogDir }

        '8' { Open-Folder $StrataHome }

        '9' { Open-Folder (Join-Path $HomeRoot 'shortcuts') }

        'H' {
            $doc = Join-Path $HomeRoot 'README-CN.txt'
            if (Test-Path $doc) { Start-Process notepad.exe $doc }
            else { Write-Host '   找不到 README-CN.txt' -ForegroundColor Red; Start-Sleep -Seconds 2 }
        }

        '0' { exit 0 }

        '' { }

        default {
            Write-Host ''
            Write-Host ('   「' + $choice + '」不是有效选项，请输入 0-9 或 H。') -ForegroundColor Red
            Start-Sleep -Seconds 2
        }
    }
}
