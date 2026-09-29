@echo off
setlocal
cd /d "%~dp0"
echo === ClawHub: mover degenscan-intel de "Other" para Finance/Trading/Data e adicionar topics ===
call npm i -g clawhub >nul 2>&1
call clawhub whoami >nul 2>&1 || call clawhub login
call clawhub skill publish .\skills\degenscan-intel --slug degenscan-intel --categories finance,trading,data --topics polymarket,funding-rate,whale-alerts,sec-filings,no-key-required --changelog "Recategorized to Finance; SKILL.md rewritten with no-key-required trial, Polymarket, funding, whale, SEC filings; SDKs npm/PyPI; domain intel.degenscan.io"
echo.
echo Confira: https://clawhub.ai/skills/degenscan-intel  (categoria e topics; scan VirusTotal na pagina)
pause
