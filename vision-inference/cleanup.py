"""
cleanup.py - vision-inference image cleanup daemon
IMAGE_STORAGE=retention mode, runs hourly
"""
import os, time, logging, psycopg2
from datetime import datetime, timedelta
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s [cleanup] %(message)s')
log = logging.getLogger(__name__)

IMAGE_STORAGE         = os.getenv('IMAGE_STORAGE', 'retention')
IMAGE_RETENTION_HOURS = int(os.getenv('IMAGE_RETENTION_HOURS', '48'))
NAS_PATH              = os.getenv('NAS_PATH', '/app/images')
CLEANUP_INTERVAL_SEC  = int(os.getenv('CLEANUP_INTERVAL_SEC', '3600'))
DB_CONFIG = {
    'host': os.getenv('DB_HOST','192.168.50.118'), 'port': int(os.getenv('DB_PORT','5432')),
    'user': os.getenv('DB_USER','wenlei'), 'password': os.getenv('DB_PASS','Homelab@2025'),
    'database': os.getenv('DB_NAME','vision_db'), 'client_encoding': 'utf8'
}

def get_db(): return psycopg2.connect(**DB_CONFIG)

def cleanup_once():
    if IMAGE_STORAGE != 'retention':
        log.info('IMAGE_STORAGE=%s, skip', IMAGE_STORAGE); return
    cutoff = datetime.utcnow() - timedelta(hours=IMAGE_RETENTION_HOURS)
    log.info('Cleanup cutoff: %s', cutoff.isoformat())
    deleted_files = deleted_db = errors = 0
    try:
        conn = get_db(); cur = conn.cursor()
        cur.execute("""SELECT id, image_url FROM vision_log
                       WHERE captured_at < %s AND image_url IS NOT NULL
                       AND image_url != '' AND image_url NOT LIKE 'data:%%'""", (cutoff,))
        rows = cur.fetchall()
        log.info('Expired records: %d', len(rows))
        ids_to_clear = []
        for row_id, path in rows:
            if path and os.path.isfile(path):
                try: os.remove(path); deleted_files += 1
                except Exception as e: log.warning('Delete failed %s: %s', path, e); errors += 1
            ids_to_clear.append(row_id)
        if ids_to_clear:
            cur.execute('UPDATE vision_log SET image_url = NULL WHERE id = ANY(%s)', (ids_to_clear,))
            deleted_db = cur.rowcount
        image_dir = Path(NAS_PATH)
        if image_dir.exists():
            cur.execute('SELECT image_url FROM vision_log WHERE image_url IS NOT NULL')
            db_paths = {r[0] for r in cur.fetchall()}
            for f in image_dir.glob('*.jpg'):
                if str(f) not in db_paths:
                    try: f.unlink(); deleted_files += 1
                    except Exception as e: log.warning('Orphan delete failed %s: %s', f, e); errors += 1
        conn.commit(); cur.close(); conn.close()
    except Exception as e: log.error('DB error: %s', e); errors += 1
    log.info('Done: %d files deleted, %d DB rows cleared, %d errors', deleted_files, deleted_db, errors)

def main():
    log.info('Cleanup daemon started (retention=%sh, interval=%ss)', IMAGE_RETENTION_HOURS, CLEANUP_INTERVAL_SEC)
    cleanup_once()
    while True:
        time.sleep(CLEANUP_INTERVAL_SEC)
        cleanup_once()

if __name__ == '__main__': main()
