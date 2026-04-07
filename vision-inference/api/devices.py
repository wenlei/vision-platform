"""
devices.py -- 设备列表 API

路由：
  GET /devices        -- 返回 DB 中注册的所有摄像头设备
  PATCH /devices/{mac}/stream_url -- 更新设备流地址
"""

import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from api.db import get_conn

log = logging.getLogger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])


@router.get("")
def list_devices():
    """返回 devices 表中所有设备，包含 name、location、stream_url。"""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT mac, name, location, stream_url, registered_at"
                    " FROM devices ORDER BY registered_at DESC"
                )
                rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    return {
        "devices": [
            {
                "mac":          r[0],
                "name":         r[1],
                "location":     r[2],
                "stream_url":   r[3],
                "registered_at": r[4].isoformat() if r[4] else None,
            }
            for r in rows
        ]
    }


class StreamUrlUpdate(BaseModel):
    stream_url: str


@router.patch("/{mac}/stream_url")
def update_device_stream_url(mac: str, body: StreamUrlUpdate):
    """更新指定设备的 stream_url。"""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE devices SET stream_url = %s WHERE mac = %s RETURNING name",
                    (body.stream_url, mac.upper())
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail=f"Device {mac} not found")
            conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    return {"ok": True, "name": row[0], "stream_url": body.stream_url}
