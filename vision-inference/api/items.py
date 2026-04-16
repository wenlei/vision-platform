"""
items.py -- 自定义物品注册与列表路由

路由：
  POST   /register        — 注册自定义物品（CLIP embedding，滚动平均）
  GET    /items           — 已注册物品列表
  DELETE /items/{label}   — 删除物品
"""

import io
import logging

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from PIL import Image

from api.models import get_clip_embedding
from api.db import get_conn
from api.storage import apply_orientation

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/register")
async def register(file: UploadFile = File(...),
                   label: str = Form(...),
                   description: str = Form("")):
    """
    注册自定义物品。
    同一 label 多次注册：滚动平均 CLIP embedding，样本越多越准。
    """
    contents = await file.read()
    img = Image.open(io.BytesIO(contents)).convert("RGB")
    img = apply_orientation(img)
    embedding = get_clip_embedding(img)

    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT id, embedding, sample_count FROM custom_items "
                "WHERE label = %s",
                (label,)
            )
            existing = cur.fetchone()

            if existing:
                old_emb = existing[1]
                count = existing[2]
                avg_emb = [
                    (old_emb[i] * count + embedding[i]) / (count + 1)
                    for i in range(len(embedding))
                ]
                norm = sum(x ** 2 for x in avg_emb) ** 0.5
                avg_emb = [x / norm for x in avg_emb]
                cur.execute(
                    "UPDATE custom_items "
                    "SET embedding=%s::vector, sample_count=%s "
                    "WHERE label=%s",
                    (str(avg_emb), count + 1, label)
                )
                msg = f"Updated '{label}' with sample {count + 1}"
            else:
                cur.execute(
                    "INSERT INTO custom_items "
                    "(label, description, embedding, sample_count) "
                    "VALUES (%s,%s,%s::vector,%s)",
                    (label, description, str(embedding), 1)
                )
                msg = f"Registered new item '{label}' with 1 sample"

        return {"status": "ok", "message": msg, "label": label}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@router.get("/items")
async def list_items():
    """返回已注册自定义物品列表。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT label, description, sample_count, registered_at "
                "FROM custom_items ORDER BY registered_at DESC"
            )
            rows = cur.fetchall()
            return {
                "items": [
                    {
                        "label": r[0], "description": r[1],
                        "sample_count": r[2],
                        "registered_at": r[3].isoformat(),
                    }
                    for r in rows
                ]
            }
    except Exception as e:
        return {"error": str(e)}


@router.delete("/items/{label}")
async def delete_item(label: str):
    """删除已注册物品（按 label 完全匹配）。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute("DELETE FROM custom_items WHERE label = %s RETURNING label", (label,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Item '{label}' not found")
        return {"status": "ok", "deleted": label}
    except HTTPException:
        raise
    except Exception as e:
        log.exception("delete item error")
        raise HTTPException(status_code=500, detail=str(e))
