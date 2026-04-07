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

from api.config import image_dir, storage_mode, camera_defaults

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


def apply_orientation(img_pil: Image.Image) -> Image.Image:
    """
    根据 camera 方向配置矫正图像，顺序匹配 CSS transform 行为。

    CSS: transform: scaleX(-1) scaleY(-1) rotate(Ndeg)
    CSS 从右往左应用：先 rotate，再 scale。
    Pillow 必须同样：先 rotate，再 mirror/flip。
    """
    cam = camera_defaults()
    rotate = int(cam.get("rotate", 0))
    hmirror = int(cam.get("hmirror", 0))
    vflip = int(cam.get("vflip", 0))

    if rotate:
        img_pil = img_pil.rotate(-rotate, expand=True)
    if hmirror:
        img_pil = ImageOps.mirror(img_pil)
    if vflip:
        img_pil = ImageOps.flip(img_pil)

    return img_pil
