# api/ — FastAPI Service Modules

## Directory Structure

```
api/
├── __init__.py        Package entry
├── config.py          Config loader (app-runtime.yaml + .env)
├── models.py          Model loading (YOLO11L / CLIP / InsightFace)
├── db.py              DB connection pool and common queries
├── storage.py         Image storage (save / path generation)
├── device_layer.py    Device abstraction (MAC → name, location, orientation)
├── detection.py       /detect, /describe, /detect/all, /detect/group/{tag}, /detect/{name-or-mac}
├── devices.py         /devices CRUD + /devices/scan, /devices/ping, /devices/camstatus
├── groups.py          /groups CRUD (detection groups — legacy, tag-based preferred)
├── bindings.py        /bindings — tag ↔ endpoint binding management
├── faces.py           /face/register, /face/identify, /faces
├── items.py           /register, /items (custom item CRUD)
├── search.py          /search — detection history queries
├── health.py          /health
├── stream_proxy.py    /stream, /stream/capture, /stream/snapshot, /stream/config
├── cleanup.py         Scheduled image cleanup daemon
└── main.py            FastAPI app entry — mounts all routers, runs DB migrations
```

## Module Dependencies

```
main.py
  ├── config.py          ← loaded first, no internal deps
  ├── models.py          ← config
  ├── db.py              ← config
  ├── storage.py         ← config
  ├── device_layer.py    ← db, config
  ├── detection.py       ← models, db, storage, device_layer
  ├── devices.py         ← db
  ├── groups.py          ← db
  ├── bindings.py        ← db
  ├── faces.py           ← models, db, storage, device_layer
  ├── items.py           ← models, db
  ├── search.py          ← db
  ├── health.py          ← config, models
  └── stream_proxy.py    ← config, db, storage
```

## Key Routes

### Detection

```
POST /detect                  Upload image → YOLO + CLIP, returns detections + annotated path
POST /describe                Upload image → text description only (no annotated image)
POST /detect/all              All registered devices: parallel capture → sequential inference
POST /detect/group/{tag}      Devices matching tag: parallel capture → sequential inference
POST /detect/{name-or-mac}    Single device by name (preferred) or MAC — no upload needed
```

`/detect/group/{tag}` matches devices whose `tag` field (comma/semicolon separated) contains the given tag exactly.  
`/detect/{name-or-mac}` tries MAC match first (uppercase), then case-insensitive name match.

### Bindings

```
GET  /bindings           All tag bindings + endpoint definitions
PUT  /bindings/{tag}     Replace enabled endpoint list for tag
                         Body: { "enabled": ["detect", "describe", "capture_snapshot"] }
```

Endpoint keys: `detect`, `describe`, `capture_snapshot`

### Devices

```
GET    /devices                   List all devices
POST   /devices                   Register { mac, name, ip, stream_url, tag, ... }
PUT    /devices/{mac}             Update fields
DELETE /devices/{mac}             Remove
PUT    /devices/{mac}/set-default Set as default
GET    /devices/scan?ip=…         Probe ESP32 at IP
GET    /devices/ping?ip=…         Online status check
GET    /devices/camstatus/{mac}   Camera resolution / RSSI / uptime
POST   /devices/camconfig/{mac}   Set camera framesize
```

`devices.tag` is a VARCHAR(64) storing comma or semicolon separated tags, e.g. `desk,front`.  
The API page groups devices by tag for batch endpoint binding.

## Startup

```bash
# From vision-inference/ root
uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 1
```

## Configuration Files

| File | Description | In Git |
|------|-------------|--------|
| `app-runtime.yaml` | Runtime config (camera source, storage, face thresholds) | YES |
| `.env` | DB password and secrets | NO |
| `.env.example` | Template | YES |

## DB Schema

Key tables (see `init_db.sql` for full schema):

| Table | Purpose |
|-------|---------|
| `devices` | ESP32 registration (mac, name, ip, stream_url, tag, rotate/hmirror/vflip) |
| `vision_log` | Detection history (labels, confidence, image_url, raw_result) |
| `tag_endpoints` | Tag ↔ enabled endpoint bindings |
| `custom_items` | CLIP-registered custom objects (512-dim embedding) |
| `faces` | InsightFace registrations (512-dim embedding, adaptive learning) |

## Face Recognition Thresholds

| Similarity | Behaviour |
|------------|-----------|
| ≥ 0.75 | High confidence match |
| 0.40 – 0.75 | Low confidence + auto adaptive learning |
| < 0.40 | Unknown, no learning triggered |
