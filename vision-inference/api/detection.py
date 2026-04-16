"""
detection.py -- 目标检测路由

路由：
  POST /detect   — YOLO 检测 + CLIP 自定义物品匹配，返回标注图
  POST /describe — 轻量描述，不生成标注图
"""

import io
import logging
import asyncio
from collections import Counter

import httpx
import numpy as np
from fastapi import APIRouter, UploadFile, File, Form, Request
from PIL import Image

from api.models import yolo, clip_model, clip_preprocess, get_clip_embedding, DEVICE
from api.db import get_conn, save_to_db
from api.storage import save_image_file, save_annotated_file, apply_orientation
from api.device_layer import get_device_tag
from api.config import cfg

log = logging.getLogger(__name__)
router = APIRouter()


def _resolve_camera_ip(camera_ip: str) -> str:
    """If camera_ip is unknown, extract from configured stream source URL."""
    if camera_ip and camera_ip != "unknown":
        return camera_ip
    try:
        source = cfg.get("camera", {}).get("source", "")
        if source:
            # e.g. http://192.168.50.87:81/ → 192.168.50.87
            return source.split("//")[-1].split(":")[0].split("/")[0]
    except Exception:
        pass
    return camera_ip


def _resolve_device_mac(ip: str):
    """Look up device MAC from devices table by IP or stream_url."""
    if not ip or ip == "unknown":
        return None
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT mac FROM devices WHERE ip = %s OR stream_url LIKE %s LIMIT 1",
                (ip, f"%/{ip}%")
            )
            row = cur.fetchone()
            return row[0] if row else None
    except Exception:
        return None


def _search_custom_items(cur, embedding, threshold=0.60):
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


def _match_bbox_custom_items(img: Image.Image, boxes, threshold=0.60):
    """
    对每个 YOLO bbox 裁切后做 CLIP，匹配自定义物品。
    boxes: list of {"label", "confidence", "bbox": [x1,y1,x2,y2]}
    返回: list of {"label", "confidence", "bbox", "custom_label", "custom_sim"}
    同一 custom_label 只保留相似度最高的一条。
    """
    if not boxes:
        return []
    # 检查是否有注册物品
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT COUNT(*) FROM custom_items")
            if cur.fetchone()[0] == 0:
                return []
    except Exception:
        return []

    best: dict[str, dict] = {}  # custom_label → best match
    w, h = img.size
    for det in boxes:
        if det["confidence"] < 0.5:
            continue
        x1, y1, x2, y2 = det["bbox"]
        # clamp to image bounds
        x1, y1 = max(0, int(x1)), max(0, int(y1))
        x2, y2 = min(w, int(x2)), min(h, int(y2))
        if x2 - x1 < 10 or y2 - y1 < 10:
            continue
        crop = img.crop((x1, y1, x2, y2))
        emb = get_clip_embedding(crop)
        try:
            with get_conn() as (conn, cur):
                matches = _search_custom_items(cur, emb, threshold)
        except Exception:
            continue
        for clabel, csim in matches:
            if clabel not in best or csim > best[clabel]["custom_sim"]:
                best[clabel] = {
                    "yolo_label": det["label"],
                    "custom_label": clabel,
                    "custom_sim": csim,
                    "bbox": det["bbox"],
                }
    return list(best.values())


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
    ip = _resolve_camera_ip(camera_ip or request.headers.get("X-Device-IP", "unknown"))
    if not mac:
        mac = _resolve_device_mac(ip)
    tag = get_device_tag(mac)

    contents = await file.read()
    try:
        img = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Invalid image: camera capture failed or returned non-image data")
    img = apply_orientation(img, mac)
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

    # CLIP 自定义物品匹配（per-bbox 裁切）
    bbox_matches = _match_bbox_custom_items(img, detections)
    custom_matches = [(m["custom_label"], m["custom_sim"]) for m in bbox_matches]

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
    ip = _resolve_camera_ip(ip)
    if not mac:
        mac = _resolve_device_mac(ip)
    tag = get_device_tag(mac)

    contents = await file.read()
    try:
        img = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Invalid image: camera capture failed or returned non-image data")
    img = apply_orientation(img, mac)
    img_np = np.array(img)

    results = yolo(img_np)
    labels, conf_data, detections = [], {}, []
    for r in results:
        for box in r.boxes:
            lbl = yolo.names[int(box.cls)]
            conf = round(float(box.conf), 2)
            detections.append({"label": lbl, "confidence": conf,
                                "bbox": [round(x, 1) for x in box.xyxy[0].tolist()]})
            if conf > 0.5:
                labels.append(lbl)
                conf_data[lbl] = conf

    bbox_matches = _match_bbox_custom_items(img, detections)
    custom_matches = [(m["custom_label"], m["custom_sim"]) for m in bbox_matches]

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


async def _capture_one(device: dict) -> tuple[dict, bytes | None]:
    """从单台设备抓取一帧，返回 (device_dict, jpeg_bytes or None)。"""
    stream_url = device.get("stream_url", "")
    if not stream_url:
        return device, None
    # Derive /capture endpoint: strip :81/ → base_url/capture
    base = stream_url.rsplit(":", 1)[0]   # http://192.168.50.87
    capture_url = base + "/capture"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(6.0)) as client:
            r = await client.get(capture_url)
            if r.status_code == 200:
                return device, r.content
    except Exception as e:
        log.warning("Capture from %s failed: %s", capture_url, e)
    return device, None


def _run_detect_on_bytes(contents: bytes, mac: str, ip: str):
    """同步推理逻辑，供 detect_all 并行调用。"""
    tag = get_device_tag(mac)
    try:
        img = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        return None
    img = apply_orientation(img, mac)
    img_np = np.array(img)

    results = yolo(img_np)
    detections, labels, conf_data = [], [], {}
    for r in results:
        for box in r.boxes:
            lbl = yolo.names[int(box.cls)]
            conf = round(float(box.conf), 3)
            detections.append({
                "label": lbl, "confidence": conf,
                "bbox": [round(x, 1) for x in box.xyxy[0].tolist()],
            })
            if conf > 0.5:
                labels.append(lbl)
                conf_data[lbl] = conf

    bbox_matches = _match_bbox_custom_items(img, detections)
    custom_matches = [(m["custom_label"], m["custom_sim"]) for m in bbox_matches]

    annotated = results[0].plot()
    image_path = save_image_file(img, tag)
    ann_path = save_annotated_file(annotated, tag)

    all_labels = labels + [m[0] for m in custom_matches]
    counts = Counter(all_labels)
    desc = ("Detected: " + ", ".join(
        f"{v}x{k}" if v > 1 else k for k, v in counts.items()
    )) if counts else "No objects detected"

    device_name, location = save_to_db(
        ip, all_labels, desc, image_path, conf_data,
        {"detections": detections, "custom_matches": custom_matches, "annotated": ann_path},
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


@router.post("/detect/all")
async def detect_all():
    """
    对所有已注册且有流地址的设备同时抓帧并运行目标检测。
    并行抓取，顺序推理（YOLO 单线程），返回各设备结果列表。
    """
    # 1. 查��所有有 stream_url 的设备
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT mac, name, location, ip, stream_url"
                " FROM devices WHERE stream_url IS NOT NULL ORDER BY registered_at"
            )
            rows = cur.fetchall()
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    devices = [
        {"mac": r[0], "name": r[1], "location": r[2], "ip": r[3], "stream_url": r[4]}
        for r in rows
    ]
    if not devices:
        return {"results": [], "count": 0}

    # 2. 并行抓帧
    captures = await asyncio.gather(*[_capture_one(d) for d in devices])

    # 3. 逐台推理（YOLO 非线程安全，顺序执行）
    results = []
    for device, jpeg in captures:
        mac = device["mac"]
        ip_val = device["ip"] or ""
        entry = {"device_mac": mac, "device_name": device["name"], "location": device["location"]}
        if jpeg is None:
            entry["error"] = "capture failed"
            entry["detections"] = []
            entry["count"] = 0
        else:
            result = _run_detect_on_bytes(jpeg, mac, ip_val)
            if result is None:
                entry["error"] = "invalid image"
                entry["detections"] = []
                entry["count"] = 0
            else:
                entry.update(result)
        results.append(entry)

    return {"results": results, "count": len(results)}


@router.post("/detect/group/{group_name}")
async def detect_group(group_name: str):
    """
    对 tag = group_name 的所有设备同时抓帧并运行目标检测。

    示例：
      curl -X POST http://192.168.50.71:8000/detect/group/desk
    """
    from fastapi import HTTPException
    import re as _re
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT mac, name, location, ip, stream_url, tag FROM devices"
                " WHERE stream_url IS NOT NULL ORDER BY registered_at",
            )
            all_rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    # Match devices whose tag list (split by , or ;) contains group_name
    rows = [r for r in all_rows if r[5] and group_name in _re.split(r'[,;]\s*', r[5])]

    if not rows:
        raise HTTPException(status_code=404, detail=f"No devices with tag '{group_name}'")

    devices = [
        {"mac": r[0], "name": r[1], "location": r[2], "ip": r[3], "stream_url": r[4]}
        for r in rows
    ]

    captures = await asyncio.gather(*[_capture_one(d) for d in devices])

    results = []
    for device, jpeg in captures:
        entry = {"device_mac": device["mac"], "device_name": device["name"], "location": device["location"]}
        if jpeg is None:
            entry.update({"error": "capture failed", "detections": [], "count": 0})
        else:
            r = _run_detect_on_bytes(jpeg, device["mac"], device["ip"] or "")
            if r is None:
                entry.update({"error": "invalid image", "detections": [], "count": 0})
            else:
                entry.update(r)
        results.append(entry)

    return {"results": results, "count": len(results), "group": group_name}


@router.post("/detect/{identifier}")
async def detect_from_device(identifier: str):
    """
    按 MAC 或设备名从指定设备抓帧并运行完整目标检测。
    优先匹配 MAC（大写），匹配失败时按设备名（不区分大小写）查找。

    示例：
      curl -X POST http://192.168.50.71:8000/detect/desk-cam-01
      curl -X POST http://192.168.50.71:8000/detect/AA:BB:CC:DD:EE:FF
    """
    from fastapi import HTTPException
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT mac, name, location, ip, stream_url FROM devices"
                " WHERE mac = %s OR LOWER(name) = LOWER(%s) LIMIT 1",
                (identifier.upper(), identifier)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device '{identifier}' not found (tried MAC and name)")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    device = {"mac": row[0], "name": row[1], "location": row[2], "ip": row[3], "stream_url": row[4]}
    _, jpeg = await _capture_one(device)
    if jpeg is None:
        raise HTTPException(status_code=502, detail=f"Failed to capture frame from {device['name']}")

    result = _run_detect_on_bytes(jpeg, device["mac"], device["ip"] or "")
    if result is None:
        raise HTTPException(status_code=422, detail="Invalid image data from device")

    result["device_mac"]  = device["mac"]
    result["device_name"] = device["name"]
    result["location"]    = device["location"]
    return result
