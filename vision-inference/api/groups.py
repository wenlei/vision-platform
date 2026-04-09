"""
groups.py -- 检测分组管理 API

路由：
  GET    /groups              -- 返回所有分组及其设备 MAC 列表
  POST   /groups              -- 创建分组
  PUT    /groups/{name}       -- 更新分组（名称/描述/设备列表）
  DELETE /groups/{name}       -- 删除分组
"""

import logging
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from api.db import get_conn

log = logging.getLogger(__name__)
router = APIRouter(prefix="/groups", tags=["groups"])


def _group_with_devices(cur, group_id: int, name: str, description: str, created_at) -> dict:
    cur.execute(
        """SELECT gd.device_mac, d.name, d.location, d.ip
           FROM group_devices gd
           JOIN devices d ON d.mac = gd.device_mac
           WHERE gd.group_id = %s""",
        (group_id,)
    )
    devices = [
        {"mac": r[0], "name": r[1], "location": r[2], "ip": r[3]}
        for r in cur.fetchall()
    ]
    return {
        "id":          group_id,
        "name":        name,
        "description": description,
        "created_at":  created_at.isoformat() if created_at else None,
        "devices":     devices,
        "device_count": len(devices),
    }


@router.get("")
def list_groups():
    """返回所有检测分组，包含各组的设备列表。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT id, name, description, created_at FROM detection_groups ORDER BY created_at"
            )
            rows = cur.fetchall()
            groups = [_group_with_devices(cur, r[0], r[1], r[2], r[3]) for r in rows]
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"groups": groups}


class GroupCreate(BaseModel):
    name:        str
    description: Optional[str] = None
    macs:        List[str] = []


@router.post("")
def create_group(body: GroupCreate):
    """创建新分组，同时绑定设备 MAC 列表。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO detection_groups (name, description) VALUES (%s, %s)"
                " RETURNING id, name, description, created_at",
                (name, body.description)
            )
            row = cur.fetchone()
            group_id = row[0]
            if body.macs:
                cur.executemany(
                    "INSERT INTO group_devices (group_id, device_mac) VALUES (%s, %s)"
                    " ON CONFLICT DO NOTHING",
                    [(group_id, m.upper()) for m in body.macs]
                )
            return _group_with_devices(cur, row[0], row[1], row[2], row[3])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")


class GroupUpdate(BaseModel):
    name:        Optional[str] = None
    description: Optional[str] = None
    macs:        Optional[List[str]] = None   # None = don't change; [] = clear all


@router.put("/{name}")
def update_group(name: str, body: GroupUpdate):
    """更新分组名称、描述或设备列表（macs 不为 None 时全量替换）。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT id FROM detection_groups WHERE name = %s", (name,)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Group '{name}' not found")
            group_id = row[0]

            # Update scalar fields
            updates = {}
            if body.name is not None:
                updates["name"] = body.name.strip()
            if body.description is not None:
                updates["description"] = body.description
            if updates:
                set_clause = ", ".join(f"{k} = %s" for k in updates)
                cur.execute(
                    f"UPDATE detection_groups SET {set_clause} WHERE id = %s",
                    list(updates.values()) + [group_id]
                )

            # Replace device list if provided
            if body.macs is not None:
                cur.execute("DELETE FROM group_devices WHERE group_id = %s", (group_id,))
                if body.macs:
                    cur.executemany(
                        "INSERT INTO group_devices (group_id, device_mac) VALUES (%s, %s)"
                        " ON CONFLICT DO NOTHING",
                        [(group_id, m.upper()) for m in body.macs]
                    )

            effective_name = updates.get("name", name)
            cur.execute(
                "SELECT id, name, description, created_at FROM detection_groups WHERE id = %s",
                (group_id,)
            )
            g = cur.fetchone()
            return _group_with_devices(cur, g[0], g[1], g[2], g[3])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")


@router.delete("/{name}")
def delete_group(name: str):
    """删除分组（级联删除 group_devices）。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "DELETE FROM detection_groups WHERE name = %s RETURNING name", (name,)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Group '{name}' not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"ok": True, "deleted": row[0]}
