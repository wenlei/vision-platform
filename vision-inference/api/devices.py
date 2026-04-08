"""
devices.py -- 设备管理 API

路由：
  GET    /devices              -- 返回所有已注册设备
  POST   /devices              -- 注册新设备
  PUT    /devices/{mac}        -- 更新设备信息
  DELETE /devices/{mac}        -- 删除设备
"""

import logging
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from api.db import get_conn

log = logging.getLogger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])


def _row_to_dict(r):
    return {
        "mac":          r[0],
        "name":         r[1],
        "location":     r[2],
        "ip":           r[3],
        "description":  r[4],
        "stream_url":   r[5],
        "registered_at": r[6].isoformat() if r[6] else None,
    }


@router.get("")
def list_devices():
    """返回所有已注册设备。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT mac, name, location, ip, description, stream_url, registered_at"
                " FROM devices ORDER BY registered_at DESC"
            )
            rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"devices": [_row_to_dict(r) for r in rows]}


class DeviceCreate(BaseModel):
    mac:         str
    name:        str
    location:    Optional[str] = None
    ip:          Optional[str] = None
    description: Optional[str] = None
    stream_url:  Optional[str] = None


@router.post("")
def register_device(body: DeviceCreate):
    """注册新设备，MAC 已存在则更新。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """INSERT INTO devices (mac, name, location, ip, description, stream_url)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (mac) DO UPDATE SET
                     name        = EXCLUDED.name,
                     location    = EXCLUDED.location,
                     ip          = EXCLUDED.ip,
                     description = EXCLUDED.description,
                     stream_url  = EXCLUDED.stream_url
                   RETURNING mac, name, location, ip, description, stream_url, registered_at""",
                (body.mac.upper(), body.name, body.location,
                 body.ip, body.description, body.stream_url)
            )
            row = cur.fetchone()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return _row_to_dict(row)


class DeviceUpdate(BaseModel):
    name:        Optional[str] = None
    location:    Optional[str] = None
    ip:          Optional[str] = None
    description: Optional[str] = None
    stream_url:  Optional[str] = None


@router.put("/{mac}")
def update_device(mac: str, body: DeviceUpdate):
    """更新设备字段（仅更新非 None 字段）。"""
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [mac.upper()]
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                f"UPDATE devices SET {set_clause} WHERE mac = %s"
                " RETURNING mac, name, location, ip, description, stream_url, registered_at",
                values
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device {mac} not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return _row_to_dict(row)


@router.delete("/{mac}")
def delete_device(mac: str):
    """删除设备。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute("DELETE FROM devices WHERE mac = %s RETURNING name", (mac.upper(),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device {mac} not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"ok": True, "deleted": row[0]}
