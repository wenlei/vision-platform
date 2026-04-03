"""
detection.py -- 目标检测路由

路由：
  POST /detect   — YOLO 检测 + CLIP 自定义物品匹配，返回标注图
  POST /describe — 轻量描述，不生成标注图
"""

import io
import logging
from collections import Counter

import numpy as np
from fastapi import APIRouter, UploadFile, File, Form, Request
from PIL import Image

from api.models import yolo, clip_model, clip_preprocess, get_clip_embedding, DEVICE
from api.db import get_conn, save_to_db
from api.storage import save_image_file, save_annotated_file, apply_orientation
from api.device_layer import get_device_tag

log = logging.getLogger(__name__)
router = APIRouter()


def _search_custom_items(cur, embedding, threshold=0.75):
    """在 custom_items 表中搜索与 CLIP embedding 相似的自定义物品。"""
    cur.execute(
        "SELECT label, 1-(embedding<=>%s::vector) AS sim FROM custom_items "
        "ORDER BY embedding<=>%s::vector LIMIT 3",
        (str(embedding), str(embedding))
    )
    return [
        (r[0], round(float(r[1]), 3))
        for r in cur.fetchall()
        if float(r[1]) >= threshold
    ]


@router.post("/detect")
async def detect(request: Request,
                 file: UploadFile = File(...),
                 camera_ip: str = Form("unknown"),
                 device_mac: str = Form(None)):
    """
    完整目标检测：YOLO 检测 + CLIP 自定义物品匹配。
    返回检测列表、标注图路径、描述文本。
    """
    mac = device_mac or request.headers.get("X-Device-MAC")
    ip = camera_ip or request.headers.get("X-Device-IP", "unknown")
    tag = get_device_tag(mac)

    contents = await file.read()
    img = Image.open(io.BytesIO(contents)).convert("RGB")
    img = apply_orientation(img)
    img_np = np.array(img)

    # YOLO 推理
    results = yolo(img_np)
    detections, labels, conf_data = [], [], {}
    for r in results:
        for box in r.boxes:
            lbl = yolo.names[int(box.cls)]
            conf = round(float(box.conf), 3)
            detections.append({
                "label": lbl,
                "confidence": conf,
                "bbox": [round(x, 1) for x in box.xyxy[0].tolist()],
            })
            if conf > 0.5:
                labels.append(lbl)
                conf_data[lbl] = conf

    # CLIP 自定义物品匹配
    embedding = get_clip_embedding(img)
    custom_matches = []
    try:
        with get_conn() as (conn, cur):
            custom_matches = _search_custom_items(cur, embedding)
    except Exception as e:
        log.warning("Custom item search failed: %s", e)

    # 保存图片
    annotated = results[0].plot()
    image_path = save_image_file(img, tag)
    ann_path = save_annotated_file(annotated, tag)

    # 生成描述
    all_labels = labels + [m[0] for m in custom_matches]
    counts = Counter(all_labels)
    desc = ("Detected: " + ", ".join(
        f"{v}x{k}" if v > 1 else k for k, v in counts.items()
    )) if counts else "No objects detected"

    # 写入 DB
    device_name, location = save_to_db(
        ip, all_labels, desc, image_path, conf_data,
        {"detections": detections, "custom_matches": custom_matches,
         "annotated": ann_path},
        mac
    )

    return {
        "detections": detections,
        "custom_matches": custom_matches,
        "count": len(detections),
        "description": desc,
        "image_path": image_path,
        "annotated_path": ann_path,
        "saved": True,
        "device_name": device_name,
        "location": location,
    }


@router.post("/describe")
async def describe(request: Request,
                   file: UploadFile = File(...),
                   camera_ip: str = Form("unknown"),
                   device_mac: str = Form(None)):
    """
    轻量描述：YOLO 检测 + CLIP 自定义物品匹配，不生成标注图。
    """
    mac = device_mac or request.headers.get("X-Device-MAC")
    ip = camera_ip or request.headers.get("X-Device-IP", "unknown")
    tag = get_device_tag(mac)

    contents = await file.read()
    img = Image.open(io.BytesIO(contents)).convert("RGB")
    img = apply_orientation(img)
    img_np = np.array(img)

    results = yolo(img_np)
    labels, conf_data, detections = [], {}, []
    for r in results:
        for box in r.boxes:
            lbl = yolo.names[int(box.cls)]
            conf = round(float(box.conf), 2)
            detections.append({"label": lbl, "confidence": conf})
            if conf > 0.5:
                labels.append(lbl)
                conf_data[lbl] = conf

    embedding = get_clip_embedding(img)
    custom_matches = []
    try:
        with get_conn() as (conn, cur):
            custom_matches = _search_custom_items(cur, embedding)
    except Exception as e:
        log.warning("Custom item search failed: %s", e)

    image_path = save_image_file(img, tag)

    all_labels = labels + [m[0] for m in custom_matches]
    counts = Counter(all_labels)
    desc = ("Detected: " + ", ".join(
        f"{v}x{k}" if v > 1 else k for k, v in counts.items()
    )) if counts else "No objects detected"

    device_name, location = save_to_db(
        ip, all_labels, desc, image_path, conf_data,
        {"detections": detections, "custom_matches": custom_matches},
        mac
    )

    return {
        "description": desc,
        "custom_matches": custom_matches,
        "saved": True,
        "image_path": image_path,
        "device_name": device_name,
        "location": location,
    }
