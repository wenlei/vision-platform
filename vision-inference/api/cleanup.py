"""
cleanup.py -- 图片定时清理守护进程

职责：
  在 retention 模式下，定期清理过期图片文件并清空 DB 中的 image_url。
  同时清理孤儿文件（文件存在但 DB 中无对应记录）。

调度方式由 app-runtime.yaml 的 storage.cleanup 段控制：
  - interval: 每隔固定小时数执行
  - daily:    每天在指定时间执行

启动命令：
  python -m api.cleanup
"""

import os
import time
import logging
from datetime import datetime, timedelta

from api.config import (
    storage_mode, image_dir, cleanup_config, log_level, log_format,
)
from api.db import get_conn

logging.basicConfig(level=log_level(), format=log_format())
log = logging.getLogger("cleanup")


def _retention_hours():
    """从配置获取图片保留时间（小时）。"""
    from api.config import cfg
    return int(cfg.get("storage", {}).get("retention_hours", 72))


def cleanup_once():
    """执行一次清理：删除过期文件 + 清空 DB image_url + 清理孤儿文件。"""
    if storage_mode() != "retention":
        log.info("storage mode=%s, skip cleanup", storage_mode())
        return

    retention = _retention_hours()
    cutoff = datetime.utcnow() - timedelta(hours=retention)
    log.info("Cleanup cutoff: %s (retention=%dh)", cutoff.isoformat(), retention)

    deleted_files = 0
    deleted_db = 0
    errors = 0

    try:
        with get_conn() as (conn, cur):
            # 查找过期且有图片路径的记录
            cur.execute(
                """SELECT id, image_url FROM vision_log
                   WHERE captured_at < %s
                     AND image_url IS NOT NULL
                     AND image_url != ''
                     AND image_url NOT LIKE 'data:%%'""",
                (cutoff,)
            )
            rows = cur.fetchall()
            log.info("Expired records: %d", len(rows))

            ids_to_clear = []
            for row_id, path in rows:
                if path and os.path.isfile(path):
                    try:
                        os.remove(path)
                        deleted_files += 1
                    except Exception as e:
                        log.warning("Delete failed %s: %s", path, e)
                        errors += 1
                ids_to_clear.append(row_id)

            if ids_to_clear:
                cur.execute(
                    "UPDATE vision_log SET image_url = NULL "
                    "WHERE id = ANY(%s)",
                    (ids_to_clear,)
                )
                deleted_db = cur.rowcount

            # 清理孤儿文件
            img_dir = image_dir()
            if img_dir.exists():
                cur.execute(
                    "SELECT image_url FROM vision_log "
                    "WHERE image_url IS NOT NULL"
                )
                db_paths = {r[0] for r in cur.fetchall()}
                for f in img_dir.glob("*.jpg"):
                    if str(f) not in db_paths:
                        try:
                            f.unlink()
                            deleted_files += 1
                        except Exception as e:
                            log.warning("Orphan delete failed %s: %s", f, e)
                            errors += 1

    except Exception as e:
        log.error("DB error: %s", e)
        errors += 1

    log.info(
        "Done: %d files deleted, %d DB rows cleared, %d errors",
        deleted_files, deleted_db, errors
    )


def main():
    """守护进程主循环，根据调度配置定期执行清理。"""
    conf = cleanup_config()
    schedule = conf.get("schedule", "interval")
    interval_hours = conf.get("interval_hours", 6)
    interval_sec = interval_hours * 3600

    log.info(
        "Cleanup daemon started (retention=%dh, schedule=%s, interval=%dh)",
        _retention_hours(), schedule, interval_hours,
    )

    # 启动时立即执行一次
    cleanup_once()

    while True:
        time.sleep(interval_sec)
        cleanup_once()


if __name__ == "__main__":
    main()
