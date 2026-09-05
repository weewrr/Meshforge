@echo off
REM ============================================================
REM  MeshForge - Hunyuan3D-2-mini inference service launcher
REM  Runs server/hunyuan_service.py inside the hy3dgen venv and
REM  keeps it listening on http://127.0.0.1:8767 for the
REM  MeshForge backend (generators/hunyuan.py default URL).
REM
REM  Weight location is auto-detected, in order:
REM    1. HY3DGEN_MODELS env var
REM    2. legacy D:\github\models
REM    3. <repo>\server\models  (default of scripts\setup-hunyuan-server.bat)
REM  Expected layout: <model-root>\Hunyuan3D-2mini\<subfolder>\...
REM
REM  If the venv or weights are missing, run scripts\setup-hunyuan-server.bat
REM  (one click: venv + CUDA torch + deps + weight download).
REM ============================================================

setlocal EnableExtensions

set "HY3DGEN_VENV=%HY3DGEN_VENV%"
if "%HY3DGEN_VENV%"=="" set "HY3DGEN_VENV=D:\github\hy3dgen-venv"
set "PYTHON=%HY3DGEN_VENV%\Scripts\python.exe"
set "SERVICE=%~dp0..\server\hunyuan_service.py"

set "MODEL_ROOT=%HY3DGEN_MODELS%"
if "%MODEL_ROOT%"=="" if exist "D:\github\models\Hunyuan3D-2mini" set "MODEL_ROOT=D:\github\models"
if "%MODEL_ROOT%"=="" (
  for %%i in ("%~dp0..\server\models") do set "MODEL_ROOT=%%~fi"
)

if not exist "%PYTHON%" (
  echo [error] hy3dgen venv not found: %PYTHON%
  echo         Run scripts\setup-hunyuan-server.bat first (creates venv + downloads weights^)
  exit /b 1
)
if not exist "%SERVICE%" (
  echo [error] service file not found: %SERVICE%
  exit /b 1
)
if not exist "%MODEL_ROOT%\Hunyuan3D-2mini" (
  echo [error] Hunyuan3D-2mini weights not found under: %MODEL_ROOT%
  echo         Run scripts\setup-hunyuan-server.bat first (downloads weights to server\models^)
  exit /b 1
)

echo [meshforge] starting Hunyuan3D inference on http://127.0.0.1:8767
echo [meshforge] model root : %MODEL_ROOT%
"%PYTHON%" "%SERVICE%" --model-root "%MODEL_ROOT%" --port 8767 --host 127.0.0.1 --preload %*

endlocal
