@echo off
REM ============================================================
REM  MeshForge - Hunyuan3D-2-mini inference service launcher
REM  Runs server/hunyuan_service.py inside the hy3dgen venv and
REM  keeps it listening on http://127.0.0.1:8767 for the
REM  MeshForge backend (generators/hunyuan.py default URL).
REM
REM  Prereq: venv already created (see server/requirements-hunyuan.txt)
REM  and weights present under the --model-root folder as
REM  <model-root>/Hunyuan3D-2mini/<subfolder>/...
REM ============================================================

setlocal

set MODEL_ROOT=D:\github\models
set HY3DGEN_VENV=D:\github\hy3dgen-venv
set PYTHON=%HY3DGEN_VENV%\Scripts\python.exe
set SERVICE=%~dp0..\server\hunyuan_service.py

if not exist "%PYTHON%" (
  echo [error] hy3dgen venv not found: %PYTHON%
  echo         Create it first - see server\requirements-hunyuan.txt
  exit /b 1
)
if not exist "%SERVICE%" (
  echo [error] service file not found: %SERVICE%
  exit /b 1
)

echo [meshforge] starting Hunyuan3D inference on http://127.0.0.1:8767
echo [meshforge] model root : %MODEL_ROOT%
"%PYTHON%" "%SERVICE%" --model-root "%MODEL_ROOT%" --port 8767 --host 127.0.0.1 --preload %*

endlocal
