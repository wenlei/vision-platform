"""
storage.py -- 图片存储与方向处理

职责：
  - 将推理结果图片保存到本地目录，返回文件路径
  - 根据配置的存储模式（none/retention/permanent）决定是否落盘
  - 提供图像方向矫正（旋转、镜像、翻转）

使用方式：
  from api.storage import save_image_file, save_annotated_file, apply_orientation
"""

import uuid
import logging

import cv2
import numpy as np
from PIL import Image, ImageOps
from datetime import datetime

from api.config import image_dir, storage_mode
from api.db import get_conn

log = logging.getLogger(__name__)


def save_image_file(img_pil: Image.Image, device_tag: str,
                    suffix: str = "") -> str:
    """
    保存 PIL 图像到存储目录，返回文件路径。

    文件名格式：{时间戳}_{设备标识}{后缀}_{随机ID}.jpg
    存储模式为 none 时返回空字符串，不落盘。

    Args:
        img_pil:    PIL Image 对象（RGB）
        device_tag: 设备短标识（如 MAC 后6位 "F4:44" → "F444"）
        suffix:     可选后缀（如 "_face", "_learn_alice"）

    Returns:
        文件路径字符串，mode=none 时返回 ""
    """
    if storage_mode() == "none":
        return ""

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    uid = uuid.uuid4().hex[:6]
    name = f"{ts}_{device_tag}{suffix}_{uid}.jpg"
    path = image_dir() / name
    img_pil.save(str(path), "JPEG", quality=90)
    return str(path)


def save_annotated_file(bgr_array: np.ndarray, device_tag: str) -> str:
    """
    保存 YOLO 标注后的图像（BGR numpy 数组），返回文件路径。
    存储模式为 none 时返回空字符串。
    """
    if storage_mode() == "none":
        return ""

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    uid = uuid.uuid4().hex[:6]
    name = f"{ts}_{device_tag}_ann_{uid}.jpg"
    path = image_dir() / name
    cv2.imwrite(str(path), bgr_array)
    return str(path)


def apply_orientation(img_pil: Image.Image, device_mac: str = None) -> Image.Image:
    """
    根据设备方向配置矫正图像（从 DB 按 MAC 查询，无 MAC 或未注册则不做变换）。
    """
    rotate = hmirror = vflip = 0
    if device_mac:
        try:
            with get_conn() as (conn, cur):
                cur.execute(
                    "SELECT rotate, hmirror, vflip FROM devices WHERE mac = %s",
                    (device_mac.upper(),)
                )
                row = cur.fetchone()
                if row:
                    rotate, hmirror, vflip = int(row[0]), int(row[1]), int(row[2])
        except Exception:
            pass
    # No MAC or unregistered device → no transform (0/0/0)

    if rotate:
        img_pil = img_pil.rotate(-rotate, expand=True)
    if hmirror:
        img_pil = ImageOps.mirror(img_pil)
    if vflip:
        img_pil = ImageOps.flip(img_pil)

    return img_pil
