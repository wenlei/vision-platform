"""
bindings.py -- Tag ↔ Endpoint 绑定管理

路由：
  GET  /bindings        -- 返回所有 tag 的 endpoint 绑定状态
  PUT  /bindings/{tag}  -- 更新某 tag 的 endpoint 勾选列表
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
from api.db import get_conn

router = APIRouter(prefix="/bindings", tags=["bindings"])

# 所有支持的 endpoint 定义
ENDPOINTS = [
    {"key": "detect",           "label": "检测 (YOLO)",        "method": "POST", "path": "/detect/group/{tag}"},
    {"key": "describe",         "label": "描述 (CLIP)",         "method": "POST", "path": "/describe/group/{tag}"},
    {"key": "capture_snapshot", "label": "截图",               "method": "POST", "path": "/capture/group/{tag}"},
]


@router.get("")
def list_bindings():
    """返回所有 tag 的 endpoint 绑定，以及可用 endpoint 定义。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT tag, endpoint_key FROM tag_endpoints ORDER BY tag, endpoint_key")
            rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    # Group by tag
    bindings: dict[str, list[str]] = {}
    for tag, ep in rows:
        bindings.setdefault(tag, []).append(ep)

    return {
        "endpoints": ENDPOINTS,
        "bindings": [{"tag": tag, "enabled": eps} for tag, eps in sorted(bindings.items())],
    }


class BindingUpdate(BaseModel):
    enabled: List[str]  # list of endpoint keys to enable


@router.put("/{tag}")
def update_binding(tag: str, body: BindingUpdate):
    """替换某 tag 的 endpoint 绑定列表。"""
    valid_keys = {e["key"] for e in ENDPOINTS}
    unknown = [k for k in body.enabled if k not in valid_keys]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown endpoint keys: {unknown}")
    try:
        with get_conn() as (conn, cur):
            cur.execute("DELETE FROM tag_endpoints WHERE tag = %s", (tag,))
            for key in body.enabled:
                cur.execute(
                    "INSERT INTO tag_endpoints (tag, endpoint_key) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (tag, key)
                )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"tag": tag, "enabled": body.enabled}
