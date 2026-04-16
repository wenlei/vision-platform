"""main.py -- FastAPI 应用入口"""
import logging
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from api.config import log_level, log_format
from api.db import get_conn

logging.basicConfig(level=log_level(), format=log_format())
log = logging.getLogger(__name__)

app = FastAPI(title="Vision Inference Service")

from api import models  # noqa: E402, F401
log.info("All models loaded")

from api.health import router as health_router
from api.detection import router as detection_router
from api.faces import router as faces_router
from api.items import router as items_router
from api.search import router as search_router
from api.stream_proxy import router as stream_router
from api.devices import router as devices_router
from api.groups import router as groups_router
from api.bindings import router as bindings_router
from api.ota import router as ota_router

app.include_router(health_router)
app.include_router(detection_router)
app.include_router(faces_router)
app.include_router(items_router)
app.include_router(search_router)
app.include_router(stream_router)
app.include_router(devices_router)
app.include_router(groups_router)
app.include_router(bindings_router)
app.include_router(ota_router)

# ── 自动 migration：按需添加新列 ──────────────────────────────
try:
    with get_conn() as (conn, cur):
        cur.execute("ALTER TABLE devices ADD COLUMN IF NOT EXISTS rotate      SMALLINT NOT NULL DEFAULT 0")
        cur.execute("ALTER TABLE devices ADD COLUMN IF NOT EXISTS hmirror     SMALLINT NOT NULL DEFAULT 0")
        cur.execute("ALTER TABLE devices ADD COLUMN IF NOT EXISTS vflip       SMALLINT NOT NULL DEFAULT 0")
        cur.execute("ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_default  BOOLEAN  NOT NULL DEFAULT FALSE")
        cur.execute("ALTER TABLE devices ADD COLUMN IF NOT EXISTS tag         VARCHAR(64)")
        cur.execute("""CREATE TABLE IF NOT EXISTS tag_endpoints (
            tag          VARCHAR(64) NOT NULL,
            endpoint_key VARCHAR(64) NOT NULL,
            PRIMARY KEY (tag, endpoint_key)
        )""")
        # vision_log timezone migration
        cur.execute("""
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='vision_log' AND column_name='captured_at'
                      AND data_type='timestamp without time zone'
                ) THEN
                    ALTER TABLE vision_log
                        ALTER COLUMN captured_at TYPE TIMESTAMPTZ
                        USING captured_at AT TIME ZONE 'UTC';
                END IF;
            END $$
        """)
        cur.execute("""CREATE TABLE IF NOT EXISTS detection_groups (
            id          SERIAL PRIMARY KEY,
            name        VARCHAR(64) NOT NULL UNIQUE,
            description TEXT,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW()
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS group_devices (
            group_id   INTEGER     NOT NULL REFERENCES detection_groups(id) ON DELETE CASCADE,
            device_mac VARCHAR(17) NOT NULL REFERENCES devices(mac)         ON DELETE CASCADE,
            PRIMARY KEY (group_id, device_mac)
        )""")
    log.info("DB migration: devices columns + detection_groups tables OK")
except Exception as e:
    log.warning("DB migration failed: %s", e)

_BASE  = Path(__file__).parent.parent
UI_DIR = _BASE / "UI"

@app.get("/")
async def root():
    """GET / → 返回 index.html，no-cache"""
    content = (UI_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(content=content, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache", "Expires": "0",
    })

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")
    log.info("UI mounted at /ui → %s", UI_DIR)

_IMG_DIR = Path("/app/images")
if _IMG_DIR.exists():
    app.mount("/images", StaticFiles(directory=str(_IMG_DIR)), name="images")
    log.info("Images mounted at /images → %s", _IMG_DIR)

log.info("Vision Inference Service ready")
