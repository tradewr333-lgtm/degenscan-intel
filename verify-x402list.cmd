@echo off
setlocal
cd /d "%~dp0"
echo === x402-list: pedir o selo "verified" (eles pagam uma chamada real ao nosso endpoint) ===
echo Custa US$0,25 + preco do endpoint, em USDC na Base, pago pela carteira Descarte.
echo.
set /p TEST_WALLET_PK=Cole a chave privada da carteira Descarte (0x...): 
echo.
call npm install >nul 2>&1
call npx tsx scripts/x402list-verify.ts
echo.
pause
