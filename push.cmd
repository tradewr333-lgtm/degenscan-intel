@echo off
setlocal
cd /d "%~dp0"
set REPO=https://github.com/tradewr333-lgtm/degenscan-intel.git
if not "%~1"=="" set REPO=%~1

where git >nul 2>&1
if errorlevel 1 (
  echo Git nao encontrado. Instalando via winget...
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
)

if not exist .git (
  git init -b main >nul
  git remote add origin %REPO%
)
git config user.name "Renato"
git config user.email "tradewr333@gmail.com"
git add -A
set MSG=%~2
if "%MSG%"=="" set MSG=update %date% %time%
git commit -q -m "%MSG%"
echo.
echo === Enviando para %REPO% ===
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push falhou. Verifique login/GitHub. Se o remoto tiver historico diferente, rode: push.cmd "" "" force
  if "%~3"=="force" git push -u origin main --force
) else (
  echo.
  echo Pronto! Render vai fazer o auto-deploy em ~3 min.
)
pause
