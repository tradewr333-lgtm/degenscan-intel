@echo off
cd /d "%~dp0packages\js"
echo === @degenscan/intel: build + publish no npm ===
echo (Na primeira vez o npm abre o navegador para login. Escopo @degenscan precisa existir na sua conta npm:
echo  se der erro 404/403 de escopo, crie a org "degenscan" em https://www.npmjs.com/org/create — e gratis.)
call npm whoami >nul 2>&1 || call npm login
call npm install
call npm publish --access public
echo.
echo Confira: https://www.npmjs.com/package/@degenscan/intel
pause
