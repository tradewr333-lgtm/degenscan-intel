@echo off
setlocal
cd /d "%~dp0"
echo === Teste de pagamento x402 (USDC na Base) ===
echo Use uma carteira DESCARTAVEL com alguns centavos de USDC. Nunca a Ledger.
echo.
set /p TEST_WALLET_PK=Cole a chave privada da carteira de teste (0x...): 
echo.
call npm install --no-save x402-fetch@1.2.0 viem >nul 2>&1
call npx tsx scripts/pay-test.ts https://intel.degenscan.io
echo.
pause
