@echo off
setlocal
cd /d "%~dp0"
echo === 1 pagamento x402 por rota NOVA (17 rotas, ~US$0,18 total, USDC na Base) para entrar no Bazaar da Coinbase ===
echo Indexacao, nao volume: UMA chamada por rota, uma unica vez.
echo Use a carteira Descarte (0x5344...d33BF). Nunca a Ledger.
echo.
set /p TEST_WALLET_PK=Cole a chave privada da carteira Descarte (0x...): 
echo.
call npm install >nul 2>&1
call npx tsx scripts/pay-index-2.ts https://intel.degenscan.io
echo.
pause
