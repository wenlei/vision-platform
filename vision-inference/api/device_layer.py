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

log = logging.getLogger(__name__)


def resolve_device(cur, mac):
    """
    通过 MAC 地址解析完整设备语义信息（名称、位置、方向均从 DB 读取）。
    未注册设备返回 unknown 占位值，方向默认 0/0/0。
    """
    info = {
        "mac":        mac,
        "name":       None,
        "location":   None,
        "tag":        get_device_tag(mac),
        "vflip":      0,
        "hmirror":    0,
        "css_rotate": 0,
    }

    if not mac:
        return info

    cur.execute(
        "SELECT name, location, rotate, hmirror, vflip FROM devices WHERE mac = %s",
        (mac.upper(),)
    )
    row = cur.fetchone()
    if row:
        info["name"]       = row[0]
        info["location"]   = row[1]
        info["css_rotate"] = int(row[2]) if row[2] else 0
        info["hmirror"]    = int(row[3]) if row[3] else 0
        info["vflip"]      = int(row[4]) if row[4] else 0

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
