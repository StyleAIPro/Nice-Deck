@echo off
setlocal
chcp 65001 >nul 2>&1

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo Huawei Deck 编辑器无法启动：无法进入 skill 根目录，请确认共享目录已经挂载或映射为 Windows 盘符。
  pause
  exit /b 2
)

set "LAUNCHER=%~dp0scripts\deck-editor.py"
if not exist "%LAUNCHER%" (
  echo Huawei Deck 编辑器无法启动：入口必须保留在包含 scripts 文件夹的 skill 根目录中。
  pause
  exit /b 2
)

set "SHORTCUT=%~dp0Huawei Deck 编辑器（Windows）.lnk"
set "SHORTCUT_SCRIPT=%~dp0scripts\create_windows_launcher_shortcut.ps1"
if not exist "%SHORTCUT%" if exist "%SHORTCUT_SCRIPT%" if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SHORTCUT_SCRIPT%" >nul 2>&1
)

where py.exe >nul 2>&1
if not errorlevel 1 goto launch_py

where python.exe >nul 2>&1
if not errorlevel 1 goto launch_python

echo Huawei Deck 编辑器无法启动：找不到 Python 3，请先安装 Python 3 并勾选“Add Python to PATH”。
pause
exit /b 2

:launch_py
py.exe -3 "%LAUNCHER%" --detach-windows --app %*
exit /b %errorlevel%

:launch_python
python.exe "%LAUNCHER%" --detach-windows --app %*
exit /b %errorlevel%
