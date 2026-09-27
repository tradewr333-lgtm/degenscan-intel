@echo off
setlocal
cd /d "%~dp0"
echo === degenscan-intel probe === > probe-output.txt
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js nao encontrado. Instalando via winget... >> probe-output.txt
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
node -v >> probe-output.txt 2>&1
echo --- npm install --- >> probe-output.txt
call npm install >> probe-output.txt 2>&1
echo --- probe --- >> probe-output.txt
set INTEL_UA=Degenscan Intel/0.1 (+https://degenscan.io; contact@degenscan.io)
call npm run probe >> probe-output.txt 2>&1
echo --- done --- >> probe-output.txt
echo.
echo Pronto. Resultado em probe-output.txt (o Claude vai ler automaticamente).
pause
