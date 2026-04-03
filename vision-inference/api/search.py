"""
search.py -- 历史检测记录搜索路由

路由：
  GET /search?label=xxx&limit=5 — 按标签搜索检测历史
"""

import logging

from fastapi import APIRouter

from api.db import get_conn

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/search")
async def search(label: str, limit: int = 5):
    """
    按物品标签搜索检测历史记录。
    返回最近 limit 条包含指定标签的记录。
    """
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """SELECT id, captured_at, camera_ip, device_mac,
                          device_name, labels, description, image_url
                   FROM vision_log
                   WHERE %s = ANY(labels)
                   ORDER BY captured_at DESC LIMIT %s""",
                (label, limit)
            )
            rows = cur.fetchall()
            return {
                "results": [
                    {
                        "id": r[0],
                        "captured_at": r[1].isoformat(),
                        "camera_ip": r[2],
                        "device_mac": r[3],
                        "device_name": r[4],
                        "labels": r[5],
                        "description": r[6],
                        "image_url": r[7],
                    }
                    for r in rows
                ],
                "count": len(rows),
                "query": label,
            }
    except Exception as e:
        return {"error": str(e)}
