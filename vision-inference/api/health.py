"""
health.py -- 健康检查与首页路由

路由：
  GET /         — 返回 Web UI（index.html），未部署时返回 JSON 状态
  GET /health   — 服务健康状态（CUDA、模型、配置参数）
  GET /overview — 平台概览（设备分组、Tag 绑定、可用端点），供 AI Agent 快速感知
"""

import logging
from pathlib import Path

import torch
import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, FileResponse

from api.config import cfg, storage_mode, image_dir, face_thresholds, log_level, db_config
from api.db import get_conn

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


@router.get("/overview")
async def overview(ping: bool = Query(False, description="是否 ping 检测设备在线状态")):
    """平台概览：设备分组、Tag 绑定、可用端点，供 AI Agent 快速感知当前平台状态。"""
    # Query devices
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT mac, name, location, ip, stream_url, tag, capability, is_default"
                " FROM devices ORDER BY name"
            )
            rows = cur.fetchall()
    except Exception as e:
        return JSONResponse({"error": f"DB error: {e}"}, status_code=502)

    # Query tag bindings
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT tag, endpoint_key FROM tag_endpoints ORDER BY tag, endpoint_key")
            bind_rows = cur.fetchall()
    except Exception:
        bind_rows = []

    # Build tag → devices + endpoints map
    tags: dict[str, dict] = {}
    all_devices: list[dict] = []

    for r in rows:
        mac, name, location, ip, stream_url, tag_raw, cap_raw, is_default = r
        caps = [c.strip() for c in (cap_raw or "video_in").split(",") if c.strip()]
        tags_list = [t.strip() for t in (tag_raw or "").split(",") if t.strip()]

        dev = {
            "mac": mac, "name": name, "location": location,
            "ip": ip, "stream_url": stream_url,
            "capability": caps, "tag": tags_list,
            "is_default": bool(is_default),
        }
        all_devices.append(dev)

        for t in tags_list:
            if t not in tags:
                tags[t] = {"devices": [], "endpoints": []}
            tags[t]["devices"].append(name)

    # Fill tag endpoints from bindings
    for tag, endpoint_key in bind_rows:
        if tag not in tags:
            tags[tag] = {"devices": [], "endpoints": []}
        if endpoint_key not in tags[tag]["endpoints"]:
            tags[tag]["endpoints"].append(endpoint_key)

    # Optional: ping devices for online status
    if ping:
        import asyncio

        async def probe(dev):
            ip = dev["ip"]
            if not ip:
                return
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(2.0)) as client:
                    r = await client.get(f"http://{ip}/status")
                    dev["online"] = r.status_code == 200
            except Exception:
                dev["online"] = False

        await asyncio.gather(*[probe(d) for d in all_devices])

    # Available endpoint definitions
    available_endpoints = [
        {"key": "detect",  "label": "检测 (YOLO+CLIP+人脸)", "method": "POST", "group_path": "/detect/group/{tag}"},
        {"key": "describe", "label": "描述 (文字)",           "method": "POST", "group_path": "/describe/group/{tag}"},
        {"key": "capture_snapshot", "label": "截图",          "method": "POST", "group_path": "/capture/group/{tag}"},
    ]

    return {
        "mode": cfg.get("device", "gpu"),
        "device_count": len(all_devices),
        "tag_count": len(tags),
        "tags": {t: {"devices": v["devices"], "endpoints": v["endpoints"]} for t, v in sorted(tags.items())},
        "devices": all_devices,
        "available_endpoints": available_endpoints,
    }
