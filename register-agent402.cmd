@echo off
REM Registers https://intel.degenscan.io in the Agent402 index (free, 0%% take). Safe to re-run.
curl -s -X POST https://agent402.tools/api/index/register -H "content-type: application/json" -d "{\"origin\":\"https://intel.degenscan.io\"}"
echo.
echo.
echo (Se apareceu um JSON acima com "ok" ou "queued", deu certo. Leaderboard: https://agent402.tools/leaderboard )
pause
