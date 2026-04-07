"""main.py -- FastAPI 应用入口"""
import logging
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from api.config import log_level, log_format

logging.basicConfig(level=log_level(), format=log_format())
log = logging.getLogger(__name__)

app = FastAPI(title="Vision Inference Service")

from api import models  # noqa: E402, F401
log.info("All models loaded")

from api.health import router as health_router
from api.detection import router as detection_router
from api.faces import router as faces_router
from api.items import router as items_router
from api.search import router as search_router
from api.stream_proxy import router as stream_router
from api.devices import router as devices_router

app.include_router(health_router)
app.include_router(detection_router)
app.include_router(faces_router)
app.include_router(items_router)
app.include_router(search_router)
app.include_router(stream_router)
app.include_router(devices_router)

_BASE  = Path(__file__).parent.parent
UI_DIR = _BASE / "UI"

@app.get("/")
async def root():
    """GET / → 返回 index.html，no-cache"""
    content = (UI_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(content=content, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache", "Expires": "0",
    })

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")
    log.info("UI mounted at /ui → %s", UI_DIR)

log.info("Vision Inference Service ready")
