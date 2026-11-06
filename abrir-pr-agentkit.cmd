@echo off
setlocal
REM Abre o PR do Degenscan Intel no coinbase/agentkit. Rode de dentro de Downloads\degenscan-intel.
set GH=tradewr333-lgtm
set BR=feat/degenscan-intel-action-provider
set SRC=%~dp0integrations\agentkit
set KEY=%USERPROFILE%\.ssh\github_signing

echo.
echo === PASSO 1: fork ===
echo Vou abrir https://github.com/coinbase/agentkit/fork no navegador.
echo Clique em "Create fork" (deixe o nome "agentkit"). Depois volte aqui.
start "" https://github.com/coinbase/agentkit/fork
pause

echo.
echo === PASSO 2: chave para assinar o commit (o AgentKit exige commits assinados) ===
if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"
if not exist "%KEY%" ssh-keygen -t ed25519 -f "%KEY%" -N "" -C "github commit signing"
if not exist "%KEY%.pub" ( echo Nao consegui criar a chave. Me mande o print. & pause & exit /b 1 )
type "%KEY%.pub" | clip
echo A chave publica foi COPIADA. Vou abrir a pagina do GitHub:
echo   Title: Assinatura PC   ^|   Key type: Signing Key   ^|   Key: cole (Ctrl+V)   ^|   Add SSH key
echo Se a chave ja estiver la (de uma vez anterior), so feche a pagina.
start "" https://github.com/settings/ssh/new
pause

echo.
echo === PASSO 3: clonar o fork, aplicar e assinar ===
cd /d "%USERPROFILE%\Downloads"
if not exist agentkit-pr git -c core.autocrlf=false clone --filter=blob:none https://github.com/%GH%/agentkit agentkit-pr
if errorlevel 1 ( echo Falhou o clone: o fork existe? & pause & exit /b 1 )
cd agentkit-pr
git config core.autocrlf false
git fetch https://github.com/coinbase/agentkit main
git checkout -B %BR% FETCH_HEAD
git apply --whitespace=nowarn "%SRC%\agentkit-pr.patch"
if errorlevel 1 ( echo O patch nao aplicou. Me mande o print. & pause & exit /b 1 )
git config gpg.format ssh
git config user.signingkey "%KEY%.pub"
if exist "C:\Program Files\Git\usr\bin\ssh-keygen.exe" git config gpg.ssh.program "C:/Program Files/Git/usr/bin/ssh-keygen.exe"
git add -A
git commit -S -F "%SRC%\commit-msg.txt"
if errorlevel 1 ( echo O commit falhou. Me mande o print. & pause & exit /b 1 )
git log --show-signature -1 | findstr /i "Good signature commit"
for /f "delims=" %%e in ('git config user.email') do echo E-mail do commit: %%e  (tem que ser um e-mail confirmado na sua conta GitHub)
git push -u origin %BR% --force

echo.
echo === PASSO 4: abrir o PR ===
powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 '%SRC%\PR.md' | Set-Clipboard"
echo O texto do PR foi COPIADO. Na pagina que vai abrir: titulo = primeira linha (sem o #), descricao = cole (Ctrl+V) e apague a primeira linha. Clique "Create pull request".
start "" "https://github.com/coinbase/agentkit/compare/main...%GH%:agentkit:%BR%?expand=1"
pause
