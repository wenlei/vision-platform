"""
health.py -- 健康检查与首页路由

路由：
  GET /       — 返回 Web UI（index.html），未部署时返回 JSON 状态
  GET /health — 服务健康状态（CUDA、模型、配置参数）
"""

import logging
from pathlib import Path

import torch
from fastapi import APIRouter
from fastapi.responses import JSONResponse, FileResponse

from api.config import cfg, storage_mode, image_dir, face_thresholds, log_level, db_config

log = logging.getLogger(__name__)
router = APIRouter()

# UI 目录
_BASE = Path(__file__).parent.parent
UI_DIR = _BASE / "UI"


@router.get("/")
def index():
    """返回 Web UI 首页，未找到时返回 JSON 状态。"""
    ui = UI_DIR / "index.html"
    if ui.exists():
        return FileResponse(str(ui))
    return JSONResponse({
        "status": "ok",
        "ui": "not found, place UI/index.html",
    })


@router.get("/health")
def health():
    """返回服务运行状态和关键配置参数。"""
    high_th, low_th = face_thresholds()
    return {
        "status": "ok",
        "cuda": torch.cuda.is_available(),
        "device": (
            torch.cuda.get_device_name(0)
            if torch.cuda.is_available() else "cpu"
        ),
        "mode": cfg.get("device", "gpu"),
        "storage_mode": storage_mode(),
        "image_dir": str(image_dir()),
        "log_level": log_level(),
        "face_threshold": {
            "high": high_th,
            "low": low_th,
        },
        "db_host": db_config()["host"],
    }
