"""
search.py -- 历史检测记录搜索路由

路由：
  GET /search?limit=50          — 最近 N 条记录
  GET /search?label=xxx&limit=5 — 按标签过滤
  GET /search?device_mac=xxx    — 按设备过滤
"""

import logging
from typing import Optional

from fastapi import APIRouter

from api.db import get_conn

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/search")
async def search(label: Optional[str] = None, limit: int = 50,
                 device_mac: Optional[str] = None):
    """
    查询检测历史记录。
    不传 label 时返回最近 limit 条全量记录。
    """
    try:
        with get_conn() as (conn, cur):
            conditions = []
            params: list = []
            if label:
                conditions.append("%s = ANY(labels)")
                params.append(label)
            if device_mac:
                conditions.append("device_mac = %s")
                params.append(device_mac.upper())
            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            params.append(limit)
            cur.execute(
                f"""SELECT id, captured_at, camera_ip, device_mac,
                           device_name, labels, description, image_url
                    FROM vision_log
                    {where}
                    ORDER BY captured_at DESC LIMIT %s""",
                params
            )
            rows = cur.fetchall()
            return {
                "results": [
                    {
                        "id": r[0],
                        "captured_at": r[1].isoformat() if r[1] else None,
                        "camera_ip": r[2],
                        "device_mac": r[3],
                        "device_name": r[4],
                        "labels": r[5] or [],
                        "description": r[6],
                        "image_url": ("/images/" + r[7].split("/")[-1]) if r[7] else None,
                    }
                    for r in rows
                ],
                "count": len(rows),
                "query": label,
            }
    except Exception as e:
        log.exception("search error")
        return {"error": str(e), "results": []}
