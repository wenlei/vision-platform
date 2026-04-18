# vision-platform

> **Version:** 20260418

ESP32-S3 desk camera system with GPU-accelerated vision inference — YOLO11L detection, CLIP custom item matching, InsightFace face recognition.

## Architecture

```
ESP32-S3 Cameras (MJPEG stream + /capture)
        │  HTTP
        ▼
Vision Inference Service  (FastAPI · 192.168.50.71:8000)
  ├── YOLO11L   object detection
  ├── CLIP      custom item matching (few-shot)
  ├── InsightFace  face recognition + adaptive learning
  └── PostgreSQL + pgvector  (192.168.50.118 · vision_db)
        │
        ▼
Web UI  (served at :8000/)
  Live · History · Items · Faces · Devices · API
```

## Repository Layout

```
vision-platform/
├── esp32-cam/               PlatformIO firmware (MJPEG + /capture endpoint)
├── vision-inference/
│   ├── api/                 FastAPI service modules
│   ├── UI/                  Single-page web app
│   ├── init_db.sql          PostgreSQL schema (idempotent)
│   ├── app-runtime.yaml     Runtime config
│   └── .env.example         Secret template (copy → .env)
└── .scripts/
    └── deploy.py            Mac → Win deployment script
```

## API Reference

Base URL: `http://192.168.50.71:8000`

### Detection

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/detect` | Upload image (form-data: `file`) → YOLO + CLIP, returns labels + annotated image |
| `POST` | `/describe` | Upload image → text description only, no annotated image |
| `POST` | `/detect/all` | All registered devices: parallel capture → sequential inference |
| `POST` | `/detect/group/{tag}` | Devices with matching tag: parallel capture → sequential inference |
| `POST` | `/detect/{name-or-mac}` | Single device by name (e.g. `desk-cam-01`) or MAC — no upload needed |

### History & Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search` | Detection history. Params: `?label=person`, `?limit=50`, `?device_mac=…` |
| `GET` | `/images/{filename}` | Serve captured image by filename |

### Devices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/devices` | List all registered devices |
| `POST` | `/devices` | Register device `{mac, name, ip, stream_url, tag, …}` |
| `PUT` | `/devices/{mac}` | Update device fields |
| `DELETE` | `/devices/{mac}` | Remove device |
| `PUT` | `/devices/{mac}/set-default` | Set as default device |
| `GET` | `/devices/scan` | Scan LAN for ESP32 devices |
| `GET` | `/devices/discovered` | List discovered but unregistered devices |
| `GET` | `/devices/ping` | Ping all registered devices |
| `GET` | `/devices/camstatus/{mac}` | Camera resolution, RSSI, uptime |
| `POST` | `/devices/camconfig/{mac}` | Set camera framesize |

### Tag ↔ Endpoint Bindings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bindings` | All tag bindings + available endpoint definitions |
| `PUT` | `/bindings/{tag}` | Set enabled endpoints for tag `{enabled: ["detect", "describe", "capture_snapshot"]}` |

### Face Recognition

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/face/register` | Register face embedding (form-data: `file`, `name`) |
| `POST` | `/face/identify` | Identify face in uploaded image |
| `GET` | `/faces` | List all registered faces |

### Custom Items

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Register custom item via CLIP (form-data: `file`, `label`) |
| `GET` | `/items` | List registered items |

### Stream

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stream` | MJPEG stream (default device, orientation-corrected) |
| `GET` | `/stream/{mac}` | MJPEG stream for specific device |
| `GET` | `/stream/capture` | Single frame JPEG (default device) |
| `GET` | `/stream/snapshot` | Timestamped snapshot saved to disk |
| `GET` | `/stream/status` | Broadcaster status |
| `GET` | `/stream/health` | Stream online check |
| `GET` | `/stream/config` | Current stream source + orientation config |
| `POST` | `/stream/config` | Update stream source + orientation (rotate/hmirror/vflip) |

### Detection Groups (legacy)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/groups` | List all detection groups |
| `POST` | `/groups` | Create group `{name, description, macs: […]}` |
| `PUT` | `/groups/{name}` | Update group |
| `DELETE` | `/groups/{name}` | Delete group |

### Health & UI

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service status, CUDA device, DB connection |
| `GET` | `/version` | Current service version string `{"version": "YYYYMMDD"}` |
| `GET` | `/` | Web UI (index.html, no-cache) |

## Device Tags

Devices carry a `tag` field (comma or semicolon separated, e.g. `desk,front`). Tags define detection groups — same tag = same group for `/detect/group/{tag}`.

Tag ↔ endpoint bindings are managed in the **API** page of the web UI. Each tag can have any combination of `detect`, `describe`, `capture_snapshot` enabled.

## Face Recognition Thresholds

| Similarity | Behaviour |
|------------|-----------|
| ≥ 0.75 | High confidence — return match |
| 0.40 – 0.75 | Low confidence — return + adaptive learning |
| < 0.40 | Unknown — no action |

## Quick Start

```bash
# 1. DB schema (idempotent, safe to re-run)
psql -U wenlei -d vision_db -f vision-inference/init_db.sql

# 2. Config
cp vision-inference/.env.example vision-inference/.env
# fill in DB password

# 3. Start service
cd vision-inference
uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 1
```

## Deploy (Mac → Win container)

```bash
# Upload changed files only
python3 .scripts/deploy.py

# Git pull on Win + upload + restart container
python3 .scripts/deploy.py pull

# Upload + restart container
python3 .scripts/deploy.py restart
```
