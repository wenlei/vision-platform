"""
faces.py -- 人脸识别路由

路由：
  POST /face/register  — 注册人脸（滚动平均，一人一条记录）
  POST /face/identify  — 识别人脸（三档置信度 + 低置信自动学习）
  GET  /faces          — 已注册人脸列表
"""

import io
import logging

import numpy as np
from fastapi import APIRouter, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse
from PIL import Image

from api.models import face_app
from api.db import get_conn
from api.storage import save_image_file, apply_orientation
from api.device_layer import get_device_tag
from api.config import face_thresholds

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/face/register")
async def face_register(request: Request,
                        file: UploadFile = File(...),
                        name: str = Form(...),
                        label: str = Form("")):
    """
    注册人脸。
    同一 name 多次注册：滚动平均 embedding，一人始终只有一条记录。
    sample_count 累积，样本越多识别越稳定。
    """
    mac = request.headers.get("X-Device-MAC")
    tag = get_device_tag(mac)

    contents = await file.read()
    img_pil = Image.open(io.BytesIO(contents)).convert("RGB")
    img_pil = apply_orientation(img_pil)
    img_np = np.array(img_pil)

    faces = face_app.get(img_np)
    if not faces:
        return JSONResponse(
            status_code=422,
            content={"status": "error", "error": "No face detected in image"}
        )

    face = max(faces, key=lambda f: f.det_score)
    new_emb = face.embedding.tolist()
    det_score = round(float(face.det_score), 3)
    image_path = save_image_file(img_pil, tag, suffix="_face")

    try:
        with get_conn() as (conn, cur):
            # 查是否已有同名记录
            cur.execute(
                "SELECT id, embedding, sample_count FROM faces WHERE name = %s",
                (name,)
            )
            existing = cur.fetchone()

            if existing:
                face_id, old_emb_raw, count = existing
                # pgvector returns embedding as string "[0.1,0.2,...]" from psycopg2
                if isinstance(old_emb_raw, str):
                    old_emb = [float(x) for x in old_emb_raw.strip("[]").split(",")]
                else:
                    old_emb = [float(x) for x in old_emb_raw]
                # 滚动平均 + L2 归一化
                avg_emb = [
                    (old_emb[i] * count + new_emb[i]) / (count + 1)
                    for i in range(len(new_emb))
                ]
                norm = sum(x ** 2 for x in avg_emb) ** 0.5
                avg_emb = [x / norm for x in avg_emb]
                cur.execute(
                    """UPDATE faces
                       SET embedding    = %s::vector,
                           sample_count = %s,
                           image_url    = %s,
                           det_score    = %s,
                           updated_at   = NOW()
                       WHERE id = %s""",
                    (str(avg_emb), count + 1, image_path, det_score, face_id)
                )
                new_count = count + 1
                msg = f"Updated '{name}': sample {new_count}"
            else:
                cur.execute(
                    """INSERT INTO faces
                       (name, label, embedding, image_url, det_score,
                        source_device, sample_count)
                       VALUES (%s, %s, %s::vector, %s, %s, %s, 1)
                       RETURNING id""",
                    (name, label or name, str(new_emb),
                     image_path, det_score, mac)
                )
                face_id = cur.fetchone()[0]
                new_count = 1
                msg = f"Registered '{name}' with 1 sample"

        log.info("face_register: %s", msg)
        return {
            "status": "ok",
            "message": msg,
            "face_id": face_id,
            "name": name,
            "det_score": det_score,
            "sample_count": new_count,
            "image_path": image_path,
        }
    except Exception as e:
        log.error("face_register error: %s", e)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "error": str(e)}
        )


@router.post("/face/identify")
async def face_identify(request: Request,
                        file: UploadFile = File(...),
                        threshold: float = Form(None)):
    """
    识别图中所有人脸，三档置信度处理：

    sim >= threshold_high (0.75)
        → 高置信匹配，直接返回

    threshold_low <= sim < threshold_high (0.40 ~ 0.75)
        → 低置信匹配：返回结果 + 滚动平均自动学习

    sim < threshold_low (< 0.40)
        → unknown，不触发学习
    """
    high_th, default_low = face_thresholds()
    low_th = threshold if threshold is not None else default_low

    mac = request.headers.get("X-Device-MAC")
    tag = get_device_tag(mac)

    contents = await file.read()
    img_pil = Image.open(io.BytesIO(contents)).convert("RGB")
    img_pil = apply_orientation(img_pil)
    img_np = np.array(img_pil)

    faces = face_app.get(img_np)
    if not faces:
        return {"status": "ok", "results": [], "message": "No face detected"}

    results = []
    try:
        with get_conn() as (conn, cur):
            for face in faces:
                emb = face.embedding.tolist()
                det_score = round(float(face.det_score), 3)
                bbox = [round(x, 1) for x in face.bbox.tolist()]

                # 余弦相似度最近邻
                cur.execute(
                    """SELECT id, name, label, embedding, sample_count,
                              1 - (embedding <=> %s::vector) AS similarity
                       FROM faces
                       ORDER BY embedding <=> %s::vector
                       LIMIT 1""",
                    (str(emb), str(emb))
                )
                row = cur.fetchone()

                if not row:
                    results.append({
                        "name": "unknown", "similarity": 0.0,
                        "det_score": det_score, "bbox": bbox,
                        "matched": False, "learned": False,
                    })
                    continue

                face_id, name, label, old_emb_raw, count, similarity = row
                similarity = round(float(similarity), 3)
                # pgvector returns embedding as string from psycopg2
                if isinstance(old_emb_raw, str):
                    old_emb = [float(x) for x in old_emb_raw.strip("[]").split(",")]
                else:
                    old_emb = [float(x) for x in old_emb_raw]

                if similarity < low_th:
                    # 完全不认识
                    results.append({
                        "name": "unknown", "similarity": similarity,
                        "det_score": det_score, "bbox": bbox,
                        "matched": False, "learned": False,
                    })

                elif similarity < high_th:
                    # 低置信度 → 自动学习
                    avg_emb = [
                        (old_emb[i] * count + emb[i]) / (count + 1)
                        for i in range(len(emb))
                    ]
                    norm = sum(x ** 2 for x in avg_emb) ** 0.5
                    avg_emb = [x / norm for x in avg_emb]

                    learn_image = save_image_file(
                        img_pil, tag, suffix=f"_learn_{name}"
                    )
                    cur.execute(
                        """UPDATE faces
                           SET embedding    = %s::vector,
                               sample_count = %s,
                               image_url    = %s,
                               updated_at   = NOW()
                           WHERE id = %s""",
                        (str(avg_emb), count + 1, learn_image, face_id)
                    )
                    log.info(
                        "Auto-learned: %s sim=%.3f count=%d->%d",
                        name, similarity, count, count + 1
                    )
                    results.append({
                        "name": name, "label": label,
                        "face_id": face_id,
                        "similarity": similarity,
                        "det_score": det_score, "bbox": bbox,
                        "matched": True, "confidence": "low",
                        "learned": True,
                        "sample_count": count + 1,
                        "learn_image": learn_image,
                    })

                else:
                    # 高置信度匹配
                    results.append({
                        "name": name, "label": label,
                        "face_id": face_id,
                        "similarity": similarity,
                        "det_score": det_score, "bbox": bbox,
                        "matched": True, "confidence": "high",
                        "learned": False,
                        "sample_count": count,
                    })

    except Exception as e:
        log.error("face_identify error: %s", e)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "error": str(e)}
        )

    return {
        "status": "ok",
        "results": results,
        "count": len(results),
        "thresholds": {"high": high_th, "low": low_th},
    }


@router.get("/faces")
async def list_faces():
    """返回已注册人脸列表。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """SELECT id, name, label, det_score, source_device,
                          registered_at, sample_count
                   FROM faces ORDER BY registered_at DESC"""
            )
            rows = cur.fetchall()
            return {
                "faces": [
                    {
                        "id": r[0], "name": r[1], "label": r[2],
                        "det_score": r[3], "source_device": r[4],
                        "registered_at": r[5].isoformat(),
                        "sample_count": r[6] or 1,
                    }
                    for r in rows
                ]
            }
    except Exception as e:
        return {"error": str(e)}


@router.delete("/faces/{name}")
async def delete_face(name: str):
    """删除已注册人脸（按姓名完全匹配，删除所有同名记录）。"""
    from fastapi import HTTPException
    try:
        with get_conn() as (conn, cur):
            cur.execute("DELETE FROM faces WHERE name = %s RETURNING name", (name,))
            rows = cur.fetchall()
            if not rows:
                raise HTTPException(status_code=404, detail=f"Face '{name}' not found")
        return {"status": "ok", "deleted": name, "count": len(rows)}
    except HTTPException:
        raise
    except Exception as e:
        from fastapi import HTTPException as _HTTPException
        raise _HTTPException(status_code=500, detail=str(e))
