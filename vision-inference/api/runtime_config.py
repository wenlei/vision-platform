"""
runtime_config.py -- 运行时配置读写 API

GET  /config/runtime  — 返回当前存储/清理配置（可在 History 页展示）
POST /config/runtime  — 更新指定字段并写回 app-runtime.yaml，立即重载

可更新字段（JSON body）：
  storage_mode        : "none" | "retention" | "permanent"
  retention_hours     : int    (mode=retention 时生效)
  cleanup_interval_hours : int  (schedule=interval 时生效)
"""

import yaml
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from api.config import BASE_DIR, cfg, reload_config

router = APIRouter()

RUNTIME_YAML = BASE_DIR / "app-runtime.yaml"


class RuntimeConfigUpdate(BaseModel):
    storage_mode: Optional[str] = None           # none | retention | permanent
    retention_hours: Optional[int] = None
    cleanup_interval_hours: Optional[int] = None


@router.get("/config/runtime")
def get_runtime_config():
    """返回当前存储/清理配置。"""
    storage = cfg.get("storage", {})
    cleanup = storage.get("cleanup", {})
    return {
        "storage_mode":            storage.get("mode", "retention"),
        "retention_hours":         int(storage.get("retention_hours", 72)),
        "cleanup_interval_hours":  int(cleanup.get("interval_hours", 6)),
    }


@router.post("/config/runtime")
def update_runtime_config(body: RuntimeConfigUpdate):
    """更新 app-runtime.yaml 中的存储/清理配置，并立即重载。"""
    if not RUNTIME_YAML.exists():
        raise HTTPException(status_code=500, detail="app-runtime.yaml not found")

    # 读取原始 yaml（保留注释结构会丢失，但字段会完整保留）
    with open(RUNTIME_YAML, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    storage = data.setdefault("storage", {})
    cleanup = storage.setdefault("cleanup", {})

    if body.storage_mode is not None:
        if body.storage_mode not in ("none", "retention", "permanent"):
            raise HTTPException(status_code=400, detail="storage_mode must be none|retention|permanent")
        storage["mode"] = body.storage_mode

    if body.retention_hours is not None:
        if body.retention_hours < 1:
            raise HTTPException(status_code=400, detail="retention_hours must be >= 1")
        storage["retention_hours"] = body.retention_hours

    if body.cleanup_interval_hours is not None:
        if body.cleanup_interval_hours < 1:
            raise HTTPException(status_code=400, detail="cleanup_interval_hours must be >= 1")
        cleanup["interval_hours"] = body.cleanup_interval_hours

    # 写回 yaml
    with open(RUNTIME_YAML, "w", encoding="utf-8") as f:
        yaml.dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

    # 原地更新内存中的 cfg（所有模块持有同一引用，立即生效）
    reload_config()

    return {"ok": True, **get_runtime_config()}
