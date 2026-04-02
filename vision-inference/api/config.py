"""
config.py -- ??????

???
  1. ?? .env ??????????????
  2. ?? app-runtime.yaml
  3. ?? yaml ?? ${VAR} ???
  4. ???????? cfg??????????

?????
  from api.config import cfg, get, db_config
  host = cfg["database"]["host"]
"""

import os
import re
import yaml
from pathlib import Path

# ??????vision-inference/?
BASE_DIR = Path(__file__).parent.parent


def _load_env(env_path):
    """
    ?? .env ????????? os.environ?
    ??????????????docker compose environment ???????
    """
    if not env_path.exists():
        return
    with open(env_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value


def _expand_vars(obj):
    """
    ???????? ${VAR} ????
    ????????????????????
    """
    if isinstance(obj, str):
        def replacer(match):
            var_name = match.group(1)
            val = os.environ.get(var_name)
            if val is None:
                print(f'[config] WARNING: ${{var_name}} not set in environment')
                return match.group(0)
            return val
        return re.sub(r'\$\{([^}]+)\}', replacer, obj)
    elif isinstance(obj, dict):
        return {k: _expand_vars(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_expand_vars(i) for i in obj]
    return obj


def _load_config():
    """
    ?????????
      1. ?? .env??????????? docker compose environment ???
      2. ?? app-runtime.yaml
      3. ?? ${VAR} ???
    """
    _load_env(BASE_DIR / '.env')
    runtime_path = BASE_DIR / 'app-runtime.yaml'
    if not runtime_path.exists():
        print(f'[config] WARNING: {runtime_path} not found, using empty config')
        return {}
    with open(runtime_path, encoding='utf-8') as f:
        raw = yaml.safe_load(f) or {}
    result = _expand_vars(raw)
    print(f'[config] Loaded: {runtime_path}')
    return result


# ??????????import ??????
cfg = _load_config()


# ?? ?????? ??????????????????????????????????????????????

def get(section, key, default=None):
    """??????????get('database', 'host') ? '192.168.50.118'"""
    return cfg.get(section, {}).get(key, default)


def db_config():
    """?? psycopg2.connect() ??????????"""
    db = cfg.get('database', {})
    return {
        'host':            db.get('host',     'localhost'),
        'port':            int(db.get('port', 5432)),
        'user':            db.get('user',     'postgres'),
        'password':        db.get('password', ''),
        'database':        db.get('name',     'vision_db'),
        'client_encoding': 'utf8',
    }


def storage_mode():
    """?????????none | retention | permanent"""
    return cfg.get('storage', {}).get('mode', 'retention')


def image_dir():
    """????????? Path ??????????"""
    path = cfg.get('storage', {}).get('path', '/app/images')
    p = Path(path)
    if storage_mode() != 'none':
        p.mkdir(parents=True, exist_ok=True)
    return p


def face_thresholds():
    """???????? (threshold_high, threshold_low)?"""
    face = cfg.get('face', {})
    return (
        float(face.get('threshold_high', 0.75)),
        float(face.get('threshold_low',  0.40)),
    )


def camera_defaults():
    """??????????????"""
    return cfg.get('camera', {
        'default_vflip':      0,
        'default_hmirror':    0,
        'default_css_rotate': 0,
    })


def cleanup_config():
    """?? cleanup ???????"""
    return cfg.get('storage', {}).get('cleanup', {
        'schedule':       'interval',
        'interval_hours': 6,
        'daily_time':     '03:00',
    })


def log_level():
    """??????????? INFO / DEBUG"""
    return cfg.get('logging', {}).get('level', 'INFO')


def log_format():
    """?????????"""
    return cfg.get('logging', {}).get(
        'format', '%(asctime)s %(levelname)s %(name)s %(message)s'
    )
