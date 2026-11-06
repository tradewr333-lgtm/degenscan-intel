@echo off
REM Re-assina o commit do PR #1626 (coinbase/agentkit) depois de corrigir a chave/e-mail no GitHub.
cd /d "%USERPROFILE%\Downloads\agentkit-pr"
if errorlevel 1 ( echo Pasta agentkit-pr nao encontrada. & pause & exit /b 1 )
git config gpg.format ssh
git config user.signingkey "%USERPROFILE%\.ssh\github_signing.pub"
git config user.email tradewr333@gmail.com
git commit --amend --no-edit -S --reset-author
if errorlevel 1 ( echo O commit falhou. Me mande o print. & pause & exit /b 1 )
git push --force origin feat/degenscan-intel-action-provider
echo.
echo Pronto. Abra https://github.com/coinbase/agentkit/pull/1626/commits e veja se aparece "Verified".
type "%USERPROFILE%\.ssh\github_signing.pub" | clip
echo (A chave publica tambem foi copiada, caso precise cadastrar de novo como Signing Key.)
pause
