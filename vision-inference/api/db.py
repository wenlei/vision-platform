"""
db.py -- 数据库连接与公共查询

职责：
  提供统一的数据库连接管理和常用查询函数。
  所有模块通过 get_conn() 上下文管理器获取连接，
  自动处理 commit/rollback/close。

使用方式：
  from api.db import get_conn

  with get_conn() as (conn, cur):
      cur.execute("SELECT ...")
      rows = cur.fetchall()
  # 自动 commit + close
"""

import logging
from contextlib import contextmanager

import psycopg2
from psycopg2.extras import Json

from api.config import db_config

log = logging.getLogger(__name__)


@contextmanager
def get_conn():
    """
    数据库连接上下文管理器。

    用法：
      with get_conn() as (conn, cur):
          cur.execute(...)
          rows = cur.fetchall()

    正常退出自动 commit + close；
    异常时自动 rollback + close 并重新抛出。
    """
    conn = psycopg2.connect(**db_config())
    cur = conn.cursor()
    try:
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


def get_raw_conn():
    """
    返回裸连接（不带上下文管理器）。
    仅用于需要手动控制事务的特殊场景。
    """
    return psycopg2.connect(**db_config())


def lookup_device(cur, mac):
    """
    通过 MAC 地址查询设备名称和位置。

    Args:
        cur: 数据库游标
        mac: MAC 地址字符串（如 "E8:F6:0A:8C:F4:44"）

    Returns:
        (device_name, location) 元组，未找到返回 (None, None)
    """
    if not mac:
        return None, None
    cur.execute(
        "SELECT name, location FROM devices WHERE mac = %s",
        (mac.upper(),)
    )
    row = cur.fetchone()
    return (row[0], row[1]) if row else (None, None)


def save_to_db(camera_ip, labels, description, image_path,
               confidence_data, raw_result, device_mac=None):
    """
    将检测结果写入 vision_log 表。

    同时通过 MAC 查询设备名称和位置，一并写入记录。
    image_url 字段存储文件路径（非 base64）。

    Returns:
        (device_name, location) 元组，写入失败返回 (None, None)
    """
    try:
        with get_conn() as (conn, cur):
            device_name, location = lookup_device(cur, device_mac)
            cur.execute(
                """INSERT INTO vision_log
                   (camera_ip, labels, description, image_url,
                    confidence, raw_result, device_mac, device_name)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (camera_ip, labels, description, image_path,
                 Json(confidence_data), Json(raw_result),
                 device_mac, device_name)
            )
            return device_name, location
    except Exception as e:
        log.error("DB save error: %s", e)
        return None, None
