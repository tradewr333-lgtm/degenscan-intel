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

echo.
echo === Preparando repositorio local ===
if exist .git rmdir /s /q .git
git init -b main >nul
git config user.name "Renato"
git config user.email "tradewr333@gmail.com"
git add -A
git commit -q -m "degenscan-intel v0.1.4: cross-asset event feed for agents (40 connectors validated live, exposure graph, MCP+REST, x402 gate)"
git remote add origin %REPO%

echo.
echo === Enviando para %REPO% ===
echo (se pedir login, use sua conta GitHub tradewr333-lgtm no navegador)
git push -u origin main --force
if errorlevel 1 (
  echo.
  echo Push falhou. Verifique se o repositorio existe em %REPO% e se voce esta logado.
) else (
  echo.
  echo Pronto! Repositorio publicado em %REPO%
  echo Proximo passo: Claude configura o Render.
)
pause
