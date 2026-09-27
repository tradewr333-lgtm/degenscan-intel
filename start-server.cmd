@echo off
cd /d "%~dp0"
set INTEL_UA=Degenscan Intel/0.1 (+https://degenscan.io; contact@degenscan.io)
set INTEL_FREE=1
set PORT=8787
echo Degenscan Intel rodando em http://localhost:8787  (MCP: POST /mcp  REST: /v1)
echo Feche esta janela para parar.
call npm run serve
pause
