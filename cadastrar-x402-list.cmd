@echo off
REM Cadastra a Degenscan Intel no diretorio x402-list.com (gratis, revisao manual em ate 7 dias; resposta por e-mail em contact@degenscan.io).
cd /d "%~dp0"
curl.exe -sS -X POST "https://x402-list.com/api/v1/submit" -H "content-type: application/json" --data-binary "@integrations\directories\x402-list-submit.json"
echo.
echo Se apareceu "submission_id", esta enviado. Me mande o print.
pause
