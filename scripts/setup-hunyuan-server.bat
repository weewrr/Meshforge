@echo off
REM ============================================================
REM  MeshForge - one-click Hunyuan3D-2-mini environment setup
REM
REM  1. create the hy3dgen venv (Python 3.11, via uv)
REM  2. install CUDA torch (cu126) + runtime deps (CN mirror)
REM  3. download the Hunyuan3D-2mini weights (hf-mirror.com)
REM  4. start the inference service (pass --no-start to skip)
REM
REM  Env overrides:
REM    HY3DGEN_VENV               venv location (default D:\github\hy3dgen-venv)
REM    MESHFORGE_HUNYUAN_WEIGHTS  weights dir (default <repo>\server\models\Hunyuan3D-2mini)
REM ============================================================
setlocal EnableExtensions

set "ROOT=%~dp0.."
for %%i in ("%ROOT%") do set "ROOT=%%~fi"

set "VENV=%HY3DGEN_VENV%"
if "%VENV%"=="" set "VENV=D:\github\hy3dgen-venv"
set "PYTHON=%VENV%\Scripts\python.exe"

set "WEIGHTS=%MESHFORGE_HUNYUAN_WEIGHTS%"
if "%WEIGHTS%"=="" set "WEIGHTS=%ROOT%\server\models\Hunyuan3D-2mini"

set "NO_START=0"
if /i "%~1"=="--no-start" set "NO_START=1"

echo [setup] repo        : %ROOT%
echo [setup] venv        : %VENV%
echo [setup] weights dir : %WEIGHTS%
echo.

REM Locate uv: PATH first, then common install locations.
set "UV="
where uv >nul 2>nul && set "UV=uv"
if not defined UV (
  for %%p in ("%LOCALAPPDATA%\Programs\uv\uv.exe" "%USERPROFILE%\.local\bin\uv.exe" "%USERPROFILE%\.cargo\bin\uv.exe") do (
    if exist "%%~p" if not defined UV set "UV=%%~p"
  )
)
if not defined UV (
  echo [error] uv not found. Install it first: https://docs.astral.sh/uv/
  exit /b 1
)
echo [setup] uv          : %UV%

if exist "%PYTHON%" (
  echo [setup] venv already exists, skipping creation
) else (
  echo [setup] creating venv with Python 3.11 ...
  "%UV%" venv "%VENV%" --python 3.11
  if errorlevel 1 exit /b 1
)

"%PYTHON%" -c "import torch" >nul 2>nul
if errorlevel 1 (
  echo [setup] installing CUDA torch ^(cu126^) - large download, please wait ...
  "%UV%" pip install --python "%PYTHON%" torch torchvision --index-url https://download.pytorch.org/whl/cu126
  if errorlevel 1 exit /b 1
) else (
  echo [setup] torch already installed, skipping
)

"%PYTHON%" -c "import hy3dgen" >nul 2>nul
if errorlevel 1 (
  echo [setup] installing runtime deps from Tsinghua mirror ...
  "%UV%" pip install --python "%PYTHON%" -r "%ROOT%\server\requirements-hunyuan.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple
  if errorlevel 1 exit /b 1
) else (
  echo [setup] hy3dgen already installed, skipping
)

if exist "%WEIGHTS%\hunyuan3d-dit-v2-mini" (
  echo [setup] weights already present, skipping download
) else (
  echo [setup] downloading Hunyuan3D-2mini weights from hf-mirror.com ...
  echo [setup] destination: %WEIGHTS%
  set "HF_ENDPOINT=https://hf-mirror.com"
  "%PYTHON%" -c "from huggingface_hub import snapshot_download; snapshot_download('tencent/Hunyuan3D-2mini', local_dir=r'%WEIGHTS%', allow_patterns=['hunyuan3d-dit-v2-mini/*','hunyuan3d-vae-v2-mini/*','hunyuan3d-vae-v2-mini-withencoder/*'])"
  if errorlevel 1 exit /b 1
)

echo.
echo [setup] done. Start the service any time with: scripts\start-hunyuan-server.bat
if "%NO_START%"=="1" exit /b 0

call "%~dp0start-hunyuan-server.bat"
