"""
device_layer.py -- 设备抽象层（R3 核心）

职责：
  将 ESP32 原始数据（MAC、心跳时间戳）映射为应用层语义。
  所有路由通过此层访问设备信息，不直接查 DB。

映射关系：
  MAC: E8:F6:0A:8C:F4:44  →  device_name: desk-cam-01
  MAC                      →  location: study-desk
  MAC                      →  orientation: {vflip, hmirror, css_rotate}
  心跳时间戳               →  last_seen, online_status

使用方式：
  from api.device_layer import resolve_device, get_device_tag

  info = resolve_device(cur, mac)
  # info = {"name": "desk-cam-01", "location": "study-desk", ...}

  tag = get_device_tag(mac)
  # tag = "F444"（用于文件名）
"""

import logging

from api.config import camera_defaults

log = logging.getLogger(__name__)


def resolve_device(cur, mac):
    """
    通过 MAC 地址解析完整设备语义信息。

    查询 devices 表获取设备名和位置，合并全局默认方向配置。
    未注册设备返回 unknown 占位值。

    Args:
        cur: 数据库游标
        mac: MAC 地址字符串（如 "E8:F6:0A:8C:F4:44"），可为 None

    Returns:
        dict: {
            "mac":        "E8:F6:0A:8C:F4:44",
            "name":       "desk-cam-01" | None,
            "location":   "study-desk" | None,
            "tag":        "F444"（MAC 后6位，文件名用）,
            "vflip":      0,
            "hmirror":    0,
            "css_rotate": 0,
        }
    """
    cam = camera_defaults()
    info = {
        "mac":        mac,
        "name":       None,
        "location":   None,
        "tag":        get_device_tag(mac),
        "vflip":      cam.get("default_vflip", 0),
        "hmirror":    cam.get("default_hmirror", 0),
        "css_rotate": cam.get("default_css_rotate", 0),
    }

    if not mac:
        return info

    cur.execute(
        "SELECT name, location FROM devices WHERE mac = %s",
        (mac.upper(),)
    )
    row = cur.fetchone()
    if row:
        info["name"] = row[0]
        info["location"] = row[1]

    return info


def get_device_tag(mac):
    """
    从 MAC 地址提取短标识，用于文件命名。

    "E8:F6:0A:8C:F4:44" → "F444"
    None / 空字符串 → "unknown"
    """
    if not mac:
        return "unknown"
    return mac.replace(":", "")[-6:]
