@echo off
cd /d "%~dp0packages\py"
echo === degenscan-intel: build + publish no PyPI ===
echo (Precisa de um token de API do PyPI: https://pypi.org/manage/account/token/ — quando pedir usuario, digite __token__ e cole o token como senha.)
python -m pip install --upgrade build twine -q
if exist dist rmdir /s /q dist
python -m build
python -m twine upload dist/*
echo.
echo Confira: https://pypi.org/project/degenscan-intel/
pause
