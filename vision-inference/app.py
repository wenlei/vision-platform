"""
vision-inference app.py
GPU 路线 — YOLO11L + CLIP ViT-B/32 + InsightFace buffalo_l

图片存储模式（IMAGE_STORAGE 环境变量）：
  retention  — 图片存本地 /app/images，cleanup.py 定时清理
  permanent  — 图片存 NAS 挂载路径（NAS_PATH），永久保留
"""

import os, io, time, uuid, logging
import torch, cv2, numpy as np, psycopg2, clip
from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from ultralytics import YOLO
from collections import Counter
from psycopg2.extras import Json
from datetime import datetime
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="Vision Inference Service")

# ── 静态文件服务（Web UI）────────────────────────────────────
STATIC_DIR = Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    log.info("Static files mounted at /static")

# ── 模型加载 ─────────────────────────────────────────────────
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
log.info("Loading YOLO11L...")
yolo_model = YOLO("yolo11l.pt")
log.info("Loading CLIP ViT-B/32 on %s...", DEVICE)
clip_model, clip_preprocess = clip.load("ViT-B/32", device=DEVICE)

# InsightFace（人脸识别）
log.info("Loading InsightFace buffalo_l...")
import insightface
face_app = insightface.app.FaceAnalysis(
    name="buffalo_l",
    providers=["CUDAExecutionProvider"] if DEVICE == "cuda" else ["CPUExecutionProvider"]
)
face_app.prepare(ctx_id=0 if DEVICE == "cuda" else -1, det_size=(640, 640))
log.info("All models ready on %s", DEVICE)

# ── 环境变量 ─────────────────────────────────────────────────
IMAGE_ROTATE          = int(os.getenv("IMAGE_ROTATE", "0"))
IMAGE_FLIP            = os.getenv("IMAGE_FLIP", "none")
IMAGE_STORAGE         = os.getenv("IMAGE_STORAGE", "retention")   # retention | permanent
IMAGE_RETENTION_HOURS = int(os.getenv("IMAGE_RETENTION_HOURS", "48"))
NAS_PATH              = os.getenv("NAS_PATH", "/app/images")
IMAGE_DIR             = Path(NAS_PATH)
IMAGE_DIR.mkdir(parents=True, exist_ok=True)

# 人脸识别阈值
# sim >= FACE_THRESHOLD_HIGH : 高置信匹配，直接返回
# FACE_THRESHOLD_LOW <= sim < HIGH : 低置信匹配，返回 + 自动学习
# sim < FACE_THRESHOLD_LOW : unknown，不触发学习
FACE_THRESHOLD_HIGH = float(os.getenv("FACE_THRESHOLD_HIGH", "0.75"))
FACE_THRESHOLD_LOW  = float(os.getenv("FACE_THRESHOLD_LOW",  "0.40"))

DB_CONFIG = {
    "host":     os.getenv("DB_HOST", "192.168.50.118"),
    "port":     int(os.getenv("DB_PORT", "5432")),
    "user":     os.getenv("DB_USER", "wenlei"),
    "password": os.getenv("DB_PASS", "Homelab@2025"),
    "database": os.getenv("DB_NAME", "vision_db"),
    "client_encoding": "utf8"
}


# ── DB helpers ───────────────────────────────────────────────
def get_db():
    return psycopg2.connect(**DB_CONFIG)


def lookup_device(cur, mac):
    if not mac:
        return None, None
    cur.execute("SELECT name, location FROM devices WHERE mac = %s", (mac.upper(),))
    row = cur.fetchone()
    return (row[0], row[1]) if row else (None, None)


# ── 图片存储 ─────────────────────────────────────────────────
def save_image_file(img_pil: Image.Image, device_tag: str, suffix: str = "") -> str:
    """
    把图片保存到 IMAGE_DIR，返回文件路径（存入 DB 的 image_url）
    """
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    uid  = uuid.uuid4().hex[:6]
    name = f"{ts}_{device_tag}{suffix}_{uid}.jpg"
    path = IMAGE_DIR / name
    img_pil.save(str(path), "JPEG", quality=90)
    return str(path)


def save_annotated_file(bgr_array: np.ndarray, device_tag: str) -> str:
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    uid  = uuid.uuid4().hex[:6]
    name = f"{ts}_{device_tag}_ann_{uid}.jpg"
    path = IMAGE_DIR / name
    cv2.imwrite(str(path), bgr_array)
    return str(path)


# ── 图像方向 ─────────────────────────────────────────────────
def apply_orientation(img_pil: Image.Image) -> Image.Image:
    if IMAGE_ROTATE != 0:
        img_pil = img_pil.rotate(-IMAGE_ROTATE, expand=True)
    if IMAGE_FLIP == "h":
        img_pil = ImageOps.mirror(img_pil)
    elif IMAGE_FLIP == "v":
        img_pil = ImageOps.flip(img_pil)
    elif IMAGE_FLIP == "both":
        img_pil = ImageOps.mirror(ImageOps.flip(img_pil))
    return img_pil


# ── CLIP embedding ───────────────────────────────────────────
def get_clip_embedding(img_pil: Image.Image):
    img_t = clip_preprocess(img_pil).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        emb = clip_model.encode_image(img_t)
        emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb.cpu().numpy()[0].tolist()


def search_custom_items(cur, embedding, threshold=0.75):
    cur.execute(
        "SELECT label, 1-(embedding<=>%s::vector) AS sim FROM custom_items "
        "ORDER BY embedding<=>%s::vector LIMIT 3",
        (str(embedding), str(embedding))
    )
    return [(r[0], round(float(r[1]), 3)) for r in cur.fetchall() if float(r[1]) >= threshold]


# ── DB 写入（image_url 存文件路径）───────────────────────────
def save_to_db(camera_ip, labels, description, image_path,
               confidence_data, raw_result, device_mac=None):
    try:
        conn = get_db()
        cur  = conn.cursor()
        device_name, location = lookup_device(cur, device_mac)
        cur.execute(
            """INSERT INTO vision_log
               (camera_ip, labels, description, image_url,
                confidence, raw_result, device_mac, device_name)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (camera_ip, labels, description, image_path,
             Json(confidence_data), Json(raw_result), device_mac, device_name)
        )
        conn.commit()
        cur.close()
        conn.close()
        return device_name, location
    except Exception as e:
        log.error("DB save error: %s", e)
        return None, None


# ── / → Web UI ───────────────────────────────────────────────
@app.get("/")
def index():
    ui = STATIC_DIR / "index.html"
    if ui.exists():
        return FileResponse(str(ui))
    return JSONResponse({"status": "ok", "ui": "not found, place static/index.html"})


# ── /health ──────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status":         "ok",
        "cuda":           torch.cuda.is_available(),
        "device":         torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "image_rotate":   IMAGE_ROTATE,
        "image_flip":     IMAGE_FLIP,
        "image_storage":  IMAGE_STORAGE,
        "image_dir":      str(IMAGE_DIR),
        "face_threshold": {
            "high": FACE_THRESHOLD_HIGH,
            "low":  FACE_THRESHOLD_LOW,
        },
    }


# ── /detect ──────────────────────────────────────────────────
@app.post("/detect")
async def detect(request: Request,
                 file: UploadFile = File(...),
                 camera_ip: str   = Form("unknown"),
                 device_mac: str  = Form(None)):
    mac = device_mac or request.headers.get("X-Device-MAC")
    ip  = camera_ip  or request.headers.get("X-Device-IP", "unknown")
    device_tag = (mac or "unknown").replace(":", "")[-6:]

    contents = await file.read()
    img = Image.open(io.BytesIO(contents)).convert("RGB")
    img = apply_orientation(img)
    img_np = np.array(img)

    results = yolo_model(img_np)
    detections, labels, conf_data = [], [], {}
    for r in results:
        for box in r.boxes:
            lbl  = yolo_model.names[int(box.cls)]
            conf = round(float(box.conf), 3)
            detections.append({"label": lbl, "confidence": conf,
                                "bbox": [round(x, 1) for x in box.xyxy[0].tolist()]})
            if conf > 0.5:
                labels.append(lbl)
                conf_data[lbl] = conf

    embedding     = get_clip_embedding(img)
    custom_matches = []
    try:
        conn = get_db(); cur = conn.cursor()
        custom_matches = search_custom_items(cur, embedding)
        cur.close(); conn.close()
    except Exception as e:
        log.warning("Custom item search failed: %s", e)

    annotated = results[0].plot()

    # A8: 保存文件，image_url 存路径
    image_path = save_image_file(img, device_tag)
    ann_path   = save_annotated_file(annotated, device_tag)

    all_labels = labels + [m[0] for m in custom_matches]
    counts     = Counter(all_labels)
    desc = ("Detected: " + ", ".join(
        [f"{v}x{k}" if v > 1 else k for k, v in counts.items()]
    )) if counts else "No objects detected"

    device_name, location = save_to_db(
        ip, all_labels, desc, image_path, conf_data,
        {"detections": detections, "custom_matches": custom_matches, "annotated": ann_path},
        mac
    )

    return {
        "detections":    detections,
        "custom_matches": custom_matches,
        "count":         len(detections),
        "description":   desc,
        "image_path":    image_path,
        "annotated_path": ann_path,
        "saved":         True,
        "device_name":   device_name,
        "location":      location,
    }


# ── /describe ────────────────────────────────────────────────
@app.post("/describe")
async def describe(request: Request,
                   file: UploadFile = File(...),
                   camera_ip: str   = Form("unknown"),
                   device_mac: str  = Form(None)):
    mac = device_mac or request.headers.get("X-Device-MAC")
    ip  = camera_ip  or request.headers.get("X-Device-IP", "unknown")
    device_tag = (mac or "unknown").replace(":", "")[-6:]

    contents = await file.read()
    img = Image.open(io.BytesIO(contents)).convert("RGB")
    img = apply_orientation(img)
    img_np = np.array(img)

    results = yolo_model(img_np)
    labels, conf_data, detections = [], {}, []
    for r in results:
        for box in r.boxes:
            lbl  = yolo_model.names[int(box.cls)]
            conf = round(float(box.conf), 2)
            detections.append({"label": lbl, "confidence": conf})
            if conf > 0.5:
                labels.append(lbl)
                conf_data[lbl] = conf

    embedding     = get_clip_embedding(img)
    custom_matches = []
    try:
        conn = get_db(); cur = conn.cursor()
        custom_matches = search_custom_items(cur, embedding)
        cur.close(); conn.close()
    except Exception as e:
        log.warning("Custom item search failed: %s", e)

    # A8: 保存原图文件路径
    image_path = save_image_file(img, device_tag)

    all_labels = labels + [m[0] for m in custom_matches]
    counts     = Counter(all_labels)
    desc = ("Detected: " + ", ".join(
        [f"{v}x{k}" if v > 1 else k for k, v in counts.items()]
    )) if counts else "No objects detected"

    device_name, location = save_to_db(
        ip, all_labels, desc, image_path, conf_data,
        {"detections": detections, "custom_matches": custom_matches},
        mac
    )

    return {
        "description":   desc,
        "custom_matches": custom_matches,
        "saved":         True,
        "image_path":    image_path,
        "device_name":   device_name,
        "location":      location,
    }


# ── /face/register ── 滚动平均，一人一条记录 ─────────────────
@app.post("/face/register")
async def face_register(request: Request,
                        file:   UploadFile = File(...),
                        name:   str        = Form(...),
                        label:  str        = Form("")):
    """
    注册人脸。
    - 同一 name 多次注册：滚动平均 embedding，一人始终只有一条记录
    - sample_count 累积，样本越多识别越稳定
    """
    mac        = request.headers.get("X-Device-MAC")
    device_tag = (mac or "unknown").replace(":", "")[-6:]

    contents = await file.read()
    img_pil  = Image.open(io.BytesIO(contents)).convert("RGB")
    img_pil  = apply_orientation(img_pil)
    img_np   = np.array(img_pil)

    faces = face_app.get(img_np)
    if not faces:
        return JSONResponse(status_code=422,
            content={"status": "error", "error": "No face detected in image"})

    face      = max(faces, key=lambda f: f.det_score)
    new_emb   = face.embedding.tolist()
    det_score = round(float(face.det_score), 3)
    image_path = save_image_file(img_pil, device_tag, suffix="_face")

    try:
        conn = get_db()
        cur  = conn.cursor()

        # 查是否已有同名记录
        cur.execute(
            "SELECT id, embedding, sample_count FROM faces WHERE name = %s",
            (name,)
        )
        existing = cur.fetchone()

        if existing:
            face_id, old_emb, count = existing
            # 滚动平均 + L2 归一化
            avg_emb = [(old_emb[i] * count + new_emb[i]) / (count + 1)
                       for i in range(len(new_emb))]
            norm    = sum(x**2 for x in avg_emb) ** 0.5
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
            face_id   = cur.fetchone()[0]
            new_count = 1
            msg = f"Registered '{name}' with 1 sample"

        conn.commit()
        cur.close()
        conn.close()
        log.info("face_register: %s", msg)

        return {
            "status":       "ok",
            "message":      msg,
            "face_id":      face_id,
            "name":         name,
            "det_score":    det_score,
            "sample_count": new_count,
            "image_path":   image_path,
        }
    except Exception as e:
        log.error("face_register error: %s", e)
        return JSONResponse(status_code=500,
            content={"status": "error", "error": str(e)})


# ── /face/identify ── 三档置信度 + 低置信自动学习 ─────────────
@app.post("/face/identify")
async def face_identify(request: Request,
                        file:      UploadFile = File(...),
                        threshold: float      = Form(None)):
    """
    识别图中所有人脸，三档置信度处理：

    sim >= FACE_THRESHOLD_HIGH (0.75)
        → 高置信匹配，直接返回，不触发学习

    FACE_THRESHOLD_LOW <= sim < HIGH (0.40 ~ 0.75)
        → 低置信匹配：返回结果 + 自动将此帧 embedding
          滚动平均合并到已知人脸（自适应学习）
          同时保存图片文件用于审计

    sim < FACE_THRESHOLD_LOW (< 0.40)
        → unknown，不触发学习
    """
    low_th  = threshold if threshold is not None else FACE_THRESHOLD_LOW
    high_th = FACE_THRESHOLD_HIGH

    mac        = request.headers.get("X-Device-MAC")
    device_tag = (mac or "unknown").replace(":", "")[-6:]

    contents = await file.read()
    img_pil  = Image.open(io.BytesIO(contents)).convert("RGB")
    img_pil  = apply_orientation(img_pil)
    img_np   = np.array(img_pil)

    faces = face_app.get(img_np)
    if not faces:
        return {"status": "ok", "results": [], "message": "No face detected"}

    results = []
    try:
        conn = get_db()
        cur  = conn.cursor()

        for face in faces:
            emb       = face.embedding.tolist()
            det_score = round(float(face.det_score), 3)
            bbox      = [round(x, 1) for x in face.bbox.tolist()]

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

            face_id, name, label, old_emb, count, similarity = row
            similarity = round(float(similarity), 3)

            if similarity < low_th:
                # 完全不认识，不学习
                results.append({
                    "name": "unknown", "similarity": similarity,
                    "det_score": det_score, "bbox": bbox,
                    "matched": False, "learned": False,
                })

            elif similarity < high_th:
                # 低置信度匹配 → 自动追加训练样本（自适应学习）
                avg_emb = [(old_emb[i] * count + emb[i]) / (count + 1)
                           for i in range(len(emb))]
                norm    = sum(x**2 for x in avg_emb) ** 0.5
                avg_emb = [x / norm for x in avg_emb]

                # 保存低置信度帧图片（供审计/回溯）
                learn_image = save_image_file(
                    img_pil, device_tag, suffix=f"_learn_{name}"
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
                    "Auto-learned: %s sim=%.3f count=%d→%d",
                    name, similarity, count, count + 1
                )
                results.append({
                    "name":         name,
                    "label":        label,
                    "face_id":      face_id,
                    "similarity":   similarity,
                    "det_score":    det_score,
                    "bbox":         bbox,
                    "matched":      True,
                    "confidence":   "low",
                    "learned":      True,
                    "sample_count": count + 1,
                    "learn_image":  learn_image,
                })

            else:
                # 高置信度匹配，直接返回，不触发学习
                results.append({
                    "name":         name,
                    "label":        label,
                    "face_id":      face_id,
                    "similarity":   similarity,
                    "det_score":    det_score,
                    "bbox":         bbox,
                    "matched":      True,
                    "confidence":   "high",
                    "learned":      False,
                    "sample_count": count,
                })

        conn.commit()
        cur.close()
        conn.close()

    except Exception as e:
        log.error("face_identify error: %s", e)
        return JSONResponse(status_code=500,
            content={"status": "error", "error": str(e)})

    return {
        "status":  "ok",
        "results": results,
        "count":   len(results),
        "thresholds": {"high": high_th, "low": low_th},
    }


# ── /register (CLIP 自定义物品) ──────────────────────────────
@app.post("/register")
async def register(file:        UploadFile = File(...),
                   label:       str        = Form(...),
                   description: str        = Form("")):
    contents = await file.read()
    img      = Image.open(io.BytesIO(contents)).convert("RGB")
    img      = apply_orientation(img)
    embedding = get_clip_embedding(img)

    try:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT id, embedding, sample_count FROM custom_items WHERE label = %s", (label,))
        existing = cur.fetchone()
        if existing:
            old_emb = existing[1]; count = existing[2]
            avg_emb = [(old_emb[i] * count + embedding[i]) / (count + 1) for i in range(len(embedding))]
            norm    = sum(x**2 for x in avg_emb) ** 0.5
            avg_emb = [x / norm for x in avg_emb]
            cur.execute("UPDATE custom_items SET embedding=%s::vector, sample_count=%s WHERE label=%s",
                        (str(avg_emb), count + 1, label))
            msg = f"Updated '{label}' with sample {count + 1}"
        else:
            cur.execute(
                "INSERT INTO custom_items (label, description, embedding, sample_count) VALUES (%s,%s,%s::vector,%s)",
                (label, description, str(embedding), 1)
            )
            msg = f"Registered new item '{label}' with 1 sample"
        conn.commit(); cur.close(); conn.close()
        return {"status": "ok", "message": msg, "label": label}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── /search ──────────────────────────────────────────────────
@app.get("/search")
async def search(label: str, limit: int = 5):
    try:
        conn = get_db(); cur = conn.cursor()
        cur.execute(
            """SELECT id, captured_at, camera_ip, device_mac, device_name,
                      labels, description, image_url
               FROM vision_log
               WHERE %s = ANY(labels)
               ORDER BY captured_at DESC LIMIT %s""",
            (label, limit)
        )
        rows = cur.fetchall(); cur.close(); conn.close()
        return {
            "results": [
                {"id": r[0], "captured_at": r[1].isoformat(), "camera_ip": r[2],
                 "device_mac": r[3], "device_name": r[4], "labels": r[5],
                 "description": r[6], "image_url": r[7]}
                for r in rows
            ],
            "count": len(rows),
            "query": label,
        }
    except Exception as e:
        return {"error": str(e)}


# ── /items ───────────────────────────────────────────────────
@app.get("/items")
async def list_items():
    try:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT label, description, sample_count, registered_at FROM custom_items ORDER BY registered_at DESC")
        rows = cur.fetchall(); cur.close(); conn.close()
        return {"items": [{"label": r[0], "description": r[1],
                           "sample_count": r[2], "registered_at": r[3].isoformat()}
                          for r in rows]}
    except Exception as e:
        return {"error": str(e)}


# ── /faces ───────────────────────────────────────────────────
@app.get("/faces")
async def list_faces():
    try:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT id, name, label, det_score, source_device, registered_at FROM faces ORDER BY registered_at DESC")
        rows = cur.fetchall(); cur.close(); conn.close()
        return {"faces": [{"id": r[0], "name": r[1], "label": r[2],
                           "det_score": r[3], "source_device": r[4],
                           "registered_at": r[5].isoformat()}
                          for r in rows]}
    except Exception as e:
        return {"error": str(e)}
