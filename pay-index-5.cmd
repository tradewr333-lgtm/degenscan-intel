@echo off
setlocal
cd /d "%~dp0"
echo === 1 pagamento x402 por rota NOVA (7 rotas, ~US$0,019 total, USDC na Base) para entrar no Bazaar da Coinbase ===
echo Indexacao, nao volume: UMA chamada por rota, uma unica vez.
echo Use a carteira Descarte (0x5344...d33BF). Nunca a Ledger.
echo Rode 1 a 2 horas depois do push (a profundidade do livro e gravada a cada hora, no minuto :03).
echo.
set /p TEST_WALLET_PK=Cole a chave privada da carteira Descarte (0x...): 
echo.
call npm install >nul 2>&1
call npx tsx scripts/pay-index-5.ts https://intel.degenscan.io
echo.
pause
