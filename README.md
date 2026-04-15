# vision-platform

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

### Detection — by Tag group

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/detect/group/{tag}` | YOLO + CLIP on all devices with this tag (parallel capture, annotated results) |
| `POST` | `/describe/group/{tag}` | Lightweight — text description only, no annotated image |
| `POST` | `/capture/group/{tag}` | Snapshot only, no inference |

### Detection — by Device

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/detect/{name-or-mac}` | Single device by name (e.g. `desk-cam-01`) or MAC address |
| `POST` | `/detect/all` | All registered devices simultaneously |
| `POST` | `/detect` | Upload image file (form-data: `file`, optional `camera_ip`/`device_mac`) |
| `POST` | `/describe` | Upload image — lightweight description, no annotated image |

### History & Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search` | Detection history. Params: `?label=person`, `?limit=50`, `?device_mac=…` |

### Devices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/devices` | List all registered devices |
| `POST` | `/devices` | Register device `{mac, name, ip, stream_url, tag, …}` |
| `PUT` | `/devices/{mac}` | Update device |
| `DELETE` | `/devices/{mac}` | Remove device |
| `PUT` | `/devices/{mac}/set-default` | Set as default device |
| `GET` | `/devices/scan?ip=…` | Probe ESP32 at IP, return MAC + info |
| `GET` | `/devices/ping?ip=…` | Online check (RSSI, uptime) |

### Tag ↔ Endpoint Bindings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bindings` | All tag bindings + endpoint definitions |
| `PUT` | `/bindings/{tag}` | Set enabled endpoint keys for a tag `{enabled: ["detect", "describe"]}` |

### Face Recognition

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/face/register` | Register face (form-data: `file`, `name`) |
| `POST` | `/face/identify` | Identify face in uploaded image |
| `GET` | `/faces` | List registered faces |

### Custom Items

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Register custom item (form-data: `file`, `label`) |
| `GET` | `/items` | List registered items |

### Stream

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stream` | MJPEG stream (proxy from ESP32, orientation applied) |
| `GET` | `/stream/capture` | Single frame JPEG |
| `GET` | `/stream/snapshot` | Orientation-corrected JPEG save |
| `GET/POST` | `/stream/config` | Get / set stream source + orientation (rotate/hmirror/vflip) |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service status, CUDA, DB connection |

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
