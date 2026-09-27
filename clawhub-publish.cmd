@echo off
REM Publishes the Degenscan Intel agent skill to ClawHub (OpenClaw skills registry).
REM Requires Node. First run asks you to log in (browser). Safe to re-run.
cd /d "%~dp0"
call npm i -g clawhub || goto :err
call clawhub login || goto :err
call clawhub skill publish .\skills\degenscan-intel --slug degenscan-intel || goto :err
echo.
echo OK - published. Next: PR to https://github.com/VoltAgent/awesome-openclaw-skills with the ClawHub link.
pause
exit /b 0
:err
echo.
echo FAILED - copy the error above and send it to the chat.
pause
exit /b 1
