@echo off
setlocal
cd /d "%~dp0"
echo === Publicar no MCP Registry oficial (registry.modelcontextprotocol.io) ===
echo Vai abrir o navegador para login no GitHub (conta tradewr333-lgtm).
echo.
if not exist mcp-publisher.exe (
  echo Baixando mcp-publisher v1.8.1...
  curl -L --fail -o mcp-publisher.tar.gz https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/mcp-publisher_windows_amd64.tar.gz
  if errorlevel 1 ( echo Download falhou. & pause & exit /b 1 )
  tar -xzf mcp-publisher.tar.gz
  if not exist mcp-publisher.exe ( echo Nao achei mcp-publisher.exe apos extrair. Conteudo: & tar -tzf mcp-publisher.tar.gz & pause & exit /b 1 )
)
echo.
echo --- login ---
mcp-publisher.exe login github
if errorlevel 1 ( echo Login falhou. & pause & exit /b 1 )
echo.
echo --- publish ---
mcp-publisher.exe publish
echo.
echo Se apareceu "Successfully published", o servidor ja esta no registry oficial (e sera indexado pelo Glama e outros).
pause
