"""
models.py -- AI 模型加载模块

职责：
  在服务启动时加载所有 AI 模型，并提供全局访问对象。
  模型只加载一次（进程级单例），避免重复占用显存/内存。

包含模型：
  - YOLO11L   : 目标检测（GPU 路线）/ YOLO11N（CPU 路线）
  - CLIP      : ViT-B/32 语义 embedding，用于自定义物品检索
  - InsightFace: buffalo_l（GPU）/ buffalo_s（CPU），人脸 embedding

使用方式：
  from api.models import yolo, clip_model, clip_preprocess, face_app, DEVICE
"""

import logging
import torch
import clip
import insightface
from ultralytics import YOLO
from api.config import cfg

log = logging.getLogger(__name__)

# -- 推理设备 --------------------------------------------------
# 优先使用 GPU（CUDA），无 GPU 时自动降级到 CPU
DEVICE: str = "cuda" if torch.cuda.is_available() else "cpu"

# 根据配置决定模型规格
# gpu 路线使用大模型（高精度），cpu 路线使用小模型（低功耗）
_mode         = cfg.get("device", "gpu")
_YOLO_MODEL   = "yolo11l.pt"  if _mode == "gpu" else "yolo11n.pt"
_FACE_MODEL   = "buffalo_l"   if _mode == "gpu" else "buffalo_s"
_FACE_PROVIDERS = (
    ["CUDAExecutionProvider"] if DEVICE == "cuda"
    else ["CPUExecutionProvider"]
)
log.info("Device mode: %s | Inference device: %s", _mode, DEVICE)


# -- YOLO 模型 -------------------------------------------------
# 用于目标检测，返回 bounding box 和类别标签
log.info("Loading YOLO: %s", _YOLO_MODEL)
yolo: YOLO = YOLO(_YOLO_MODEL)
log.info("YOLO loaded OK")


# -- CLIP 模型 -------------------------------------------------
# 用于图像语义 embedding，支持自定义物品注册和检索
log.info("Loading CLIP ViT-B/32 on %s", DEVICE)
clip_model, clip_preprocess = clip.load("ViT-B/32", device=DEVICE)
log.info("CLIP loaded OK")


# -- InsightFace 人脸模型 -------------------------------------
# 用于人脸检测和 512 维 embedding 提取
# det_size(640,640): 检测分辨率，精度和速度的平衡点
log.info("Loading InsightFace %s", _FACE_MODEL)
face_app = insightface.app.FaceAnalysis(
    name=_FACE_MODEL,
    providers=_FACE_PROVIDERS,
)
face_app.prepare(
    ctx_id=0 if DEVICE == "cuda" else -1,
    det_size=(640, 640),
)
log.info("InsightFace loaded OK")


# -- CLIP embedding 工具函数 -----------------------------------

def get_clip_embedding(img_pil) -> list:
    """
    从 PIL 图像提取 CLIP 语义 embedding。

    对图像进行归一化处理后送入 CLIP 图像编码器，
    返回 L2 归一化后的 512 维浮点数列表。

    Args:
        img_pil: PIL.Image.Image，RGB 格式

    Returns:
        list[float]: 512 维归一化 embedding 向量
    """
    img_t = clip_preprocess(img_pil).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        emb = clip_model.encode_image(img_t)
        emb = emb / emb.norm(dim=-1, keepdim=True)   # L2 归一化
    return emb.cpu().numpy()[0].tolist()
