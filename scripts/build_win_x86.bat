@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "APP_NAME=DCMViewer"
set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
set "TARGETS=nsis, zip"

cd /d "%ROOT_DIR%" || exit /b 1

call :assert_command node || exit /b 1
call :assert_command npm || exit /b 1
call :assert_command npx || exit /b 1

if not exist "node_modules\" (
    call :invoke_command "Installing dependencies with npm ci" npm ci || exit /b 1
)

if not defined CSC_IDENTITY_AUTO_DISCOVERY set "CSC_IDENTITY_AUTO_DISCOVERY=false"

call :invoke_command "Building renderer and Electron main process" npm run build || exit /b 1
call :invoke_command "Packaging Windows x86 desktop app (%TARGETS%)" npx electron-builder --win nsis zip --ia32 || exit /b 1

call :write_step "Done. Packaged files are in: %ROOT_DIR%\release"
exit /b 0

:write_step
echo.
echo [%APP_NAME%] %~1
exit /b 0

:assert_command
where %~1 >nul 2>nul
if errorlevel 1 (
    echo Required command not found: %~1
    exit /b 1
)

call %~1 --version >nul 2>nul
if errorlevel 1 (
    echo Required command is installed but cannot run: %~1
    exit /b 1
)

exit /b 0

:invoke_command
set "LABEL=%~1"
call :write_step "%LABEL%"
call %~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9
if errorlevel 1 (
    set "EXIT_CODE=%ERRORLEVEL%"
    echo %LABEL% failed with exit code !EXIT_CODE!
    exit /b !EXIT_CODE!
)

exit /b 0
