@echo off
setlocal
cd /d "%~dp0"
echo === Publicar no MCP Registry oficial (registry.modelcontextprotocol.io) ===
echo Vai abrir o navegador para login no GitHub (conta tradewr333-lgtm).
echo.
if not exist mcp-publisher.exe (
  echo Baixando mcp-publisher...
  curl -L -o mcp-publisher.zip https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.zip
  tar -xf mcp-publisher.zip mcp-publisher.exe 2>nul || powershell -Command "Expand-Archive -Force mcp-publisher.zip ."
)
mcp-publisher.exe login github
mcp-publisher.exe publish
echo.
echo Se apareceu "Successfully published", o servidor ja esta no registry oficial (e sera indexado pelo Glama e outros).
pause
