$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $repositoryRoot "Huawei Deck 编辑器.cmd"
$iconPath = Join-Path $repositoryRoot "assets/launcher/huawei-deck-editor.ico"
$shortcutPath = Join-Path $repositoryRoot "Huawei Deck 编辑器（Windows）.lnk"

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "无法创建 Windows 快捷方式：找不到 Huawei Deck 编辑器.cmd。"
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "无法创建 Windows 快捷方式：找不到应用图标。"
}

$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcherPath
    $shortcut.WorkingDirectory = $repositoryRoot
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Description = "Huawei Deck 编辑器（Windows）"
    $shortcut.WindowStyle = 1
    $shortcut.Save()
} finally {
    if ($null -ne $shell) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
}

Write-Output $shortcutPath
