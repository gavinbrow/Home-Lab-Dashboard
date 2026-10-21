@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto failed
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Windows PowerShell is required to run this launcher.
  goto failed
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\start-windows.ps1" %*
if errorlevel 1 goto failed
echo.
echo Launcher completed successfully. Closing this window does not stop services.
pause
exit /b 0

:failed
echo.
echo Startup failed. Review the error above and docs\operations\DEPLOYMENT.md.
pause
exit /b 1
