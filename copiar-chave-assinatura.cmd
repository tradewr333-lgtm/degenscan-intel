@echo off
type "%USERPROFILE%\.ssh\github_signing.pub" | clip
echo Chave copiada:
type "%USERPROFILE%\.ssh\github_signing.pub"
pause
