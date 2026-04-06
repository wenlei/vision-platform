"""
main.py -- FastAPI 应用入口

职责：
  - 创建 FastAPI 实例
  - 挂载所有路由模块
  - 挂载静态文件服务（Web UI）
  - 配置日志

启动命令：
  uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 1
"""

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api.config import log_level, log_format

# ── 日志配置 ─────────────────────────────────────────────────
logging.basicConfig(level=log_level(), format=log_format())
log = logging.getLogger(__name__)

# ── 创建 FastAPI 实例 ────────────────────────────────────────
app = FastAPI(title="Vision Inference Service")

# ── 导入模型（触发加载，必须在路由注册前）─────────────────────
from api import models  # noqa: E402, F401
log.info("All models loaded")

# ── 注册路由 ─────────────────────────────────────────────────
from api.health import router as health_router        # noqa: E402
from api.detection import router as detection_router   # noqa: E402
from api.faces import router as faces_router           # noqa: E402
from api.items import router as items_router           # noqa: E402
from api.search import router as search_router         # noqa: E402
from api.stream_proxy import router as stream_router   # noqa: E402

app.include_router(health_router)
app.include_router(detection_router)
app.include_router(faces_router)
app.include_router(items_router)
app.include_router(search_router)
app.include_router(stream_router)

# ── 静态文件服务（Web UI）────────────────────────────────────
_BASE = Path(__file__).parent.parent
UI_DIR = _BASE / "UI"

# GET / → 直接返回 index.html，无需在地址栏输入文件名
@app.get("/")
async def root():
    return FileResponse(str(UI_DIR / "index.html"))

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")
    log.info("UI mounted at /ui, root GET / → index.html")

log.info("Vision Inference Service ready")
