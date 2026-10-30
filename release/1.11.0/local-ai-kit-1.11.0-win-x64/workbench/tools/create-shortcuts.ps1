param(
    [Parameter(Mandatory=$true)][string]$Root
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path $Root).Path
$desktop = [Environment]::GetFolderPath('Desktop')

Write-Host "      desktop: $desktop"

$ws = New-Object -ComObject WScript.Shell

$targets = @(
    @{ Name = 'Strata + dsh Workbench'; File = 'launchers\Strata-dsh-Workbench.bat'; Icon = 'shell32.dll,137'; Desc = 'Start the Strata engine and the DeepSeek Harness agent workbench' },
    @{ Name = 'Strata WebUI';           File = 'launchers\Strata-WebUI.bat';           Icon = 'shell32.dll,14';  Desc = 'Live streaming chat and folder upload web UI' },
    @{ Name = 'Start Strata';           File = 'launchers\Start-Strata.bat';           Icon = 'shell32.dll,25';  Desc = 'Start the Strata inference engine only' },
    @{ Name = 'Stop Strata';            File = 'launchers\Stop-Strata.bat';            Icon = 'shell32.dll,27';  Desc = 'Stop the engine and the web UI' }
)

foreach ($t in $targets) {
    $target = Join-Path $Root $t.File
    if (-not (Test-Path $target)) {
        Write-Host ("      [skip] missing " + $t.File)
        continue
    }
    $lnk = Join-Path $desktop ($t.Name + '.lnk')
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath        = $target
    $s.WorkingDirectory  = (Split-Path $target -Parent)
    $s.IconLocation      = $t.Icon
    $s.Description       = $t.Desc
    $s.Save()
    Write-Host ("      [ok]   " + $t.Name)
}

Write-Host "      done."
