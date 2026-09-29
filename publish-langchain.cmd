@echo off
cd /d "%~dp0packages\langchain-py"
echo === langchain-degenscan: build + publish no PyPI (rode DEPOIS do publish-pypi.cmd, ele depende do degenscan-intel) ===
python -m pip install --upgrade build twine -q
if exist dist rmdir /s /q dist
python -m build
python -m twine upload dist/*
echo.
echo Confira: https://pypi.org/project/langchain-degenscan/
echo Depois: abrir issue "Integration listing" em https://github.com/langchain-ai/docs/issues (texto em integrations\langchain\LISTING-ISSUE.md)
pause
