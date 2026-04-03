# api/ -- Application Service Modules

vision-inference application code directory. FastAPI service is provided from this directory.

## Directory Structure

```
api/
├── __init__.py        # Package entry
├── config.py          # Config loader (app-runtime.yaml + .env)
├── models.py          # Model loading (YOLO / CLIP / InsightFace)
├── db.py              # DB connection and common queries
├── storage.py         # Image storage (save / path generation)
├── device_layer.py    # Device abstraction layer (MAC -> device info)
├── detection.py       # Routes: /detect, /describe
├── faces.py           # Routes: /face/register, /face/identify, /faces
├── items.py           # Routes: /register, /items
├── search.py          # Routes: /search
├── health.py          # Routes: /, /health
├── cleanup.py         # Scheduled cleanup daemon
└── main.py            # FastAPI app entry, mounts all routers
```

## Module Dependencies

```
main.py
  ├── config.py          <- loaded first, no dependencies
  ├── models.py          <- depends on config.py
  ├── db.py              <- depends on config.py
  ├── storage.py         <- depends on config.py
  ├── device_layer.py    <- depends on db.py, config.py
  ├── detection.py       <- depends on models, db, storage, device_layer
  ├── faces.py           <- depends on models, db, storage, device_layer
  ├── items.py           <- depends on models, db
  ├── search.py          <- depends on db
  └── health.py          <- depends on config, models
```

## Startup Command

```bash
# Run from vision-inference/ root directory
uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 1
```

## Configuration

Ensure the following files exist in vision-inference/ before starting:

| File | Description | In Git |
|------|-------------|--------|
| app-runtime.yaml | Application runtime config | YES |
| .env | Sensitive config (DB password etc.) | NO |
| .env.example | Sensitive config template | YES |

```bash
# First-time setup
cp .env.example .env
# Edit .env and fill in actual password
```

## config.py Usage

```python
from api.config import cfg, get, db_config, face_thresholds

host       = get("database", "host")         # read single value
conn       = psycopg2.connect(**db_config())  # get DB connection params
high, low  = face_thresholds()               # face recognition thresholds
mode       = storage_mode()                  # storage mode
path       = image_dir()                     # storage path as Path object
```

## Face Recognition Thresholds

| Similarity | Behavior |
|------------|----------|
| >= threshold_high (0.75) | High confidence match, return directly |
| 0.40 ~ 0.75 | Low confidence match, return + auto-learn |
| < threshold_low (0.40) | Unknown, no action triggered |

## Design Principles

### R1 - ESP32 Responsibility Boundary
ESP32 is a pure hardware collection endpoint. All computation happens in the container:
- MAC -> device name/location mapping: done in device_layer.py via DB lookup
- Image storage path generation: done in storage.py
- Orientation state management: done in device_layer.py

### R3 - Device Abstraction Layer
device_layer.py translates raw ESP32 data (MAC, image bytes) into application-layer
semantics (device name, location, storage path, orientation state).
All routes access device info through this layer, never via direct DB queries.
