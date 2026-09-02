from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routers import agent, extensions, generate, library, process, workflows

WORKSPACE_DIR = Path(__file__).resolve().parent / 'workspace'
WORKSPACE_DIR.mkdir(exist_ok=True)

app = FastAPI(title='Meshforge API', version='0.1.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(generate.router)
app.include_router(agent.router)
app.include_router(workflows.router)
app.include_router(extensions.router)
app.include_router(process.router)
app.include_router(library.router)
app.mount('/files', StaticFiles(directory=WORKSPACE_DIR), name='files')


@app.get('/health')
def health() -> dict:
    return {'status': 'ok', 'app': 'meshforge'}
