@echo off
setlocal
cd /d "%~dp0"
echo === 1 pagamento x402 real (USDC na Base) para indexar no Bazaar da Coinbase ===
echo Use a carteira Descarte (0x5344...d33BF), que esta publicada em /wallets.json. Nunca a Ledger.
echo A chave nao aparece na tela ao digitar/colar.
echo.
set /p TEST_WALLET_PK=Cole a chave privada da carteira Descarte (0x...): 
echo.
call npm install >nul 2>&1
call npx tsx scripts/pay-test.ts https://intel.degenscan.io /v1/pulse
echo.
pause
