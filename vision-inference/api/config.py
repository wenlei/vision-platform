"""
config.py -- 应用运行时配置加载

加载流程：
  1. 读取 .env 文件，将变量注入到环境变量中
  2. 读取 app-runtime.yaml
  3. 将 yaml 中的 ${VAR} 占位符替换为实际环境变量值
  4. 导出全局字典 cfg，供各模块直接引用

使用方式：
  from api.config import cfg, get, db_config
  host = cfg["database"]["host"]
"""

import os
import re
import yaml
from pathlib import Path

# 项目根目录：vision-inference/
BASE_DIR = Path(__file__).parent.parent


def _load_env(env_path):
    """
    读取 .env 文件，将键值对注入 os.environ。
    仅补充缺失的变量（docker compose environment 已设置的不覆盖）。
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
            # Set if not in env, or if env has an empty value (docker compose placeholder)
            if key and (key not in os.environ or os.environ[key] == ''):
                os.environ[key] = value


def _expand_vars(obj):
    """
    递归遍历配置树，将 ${VAR} 占位符替换为环境变量值。
    未定义的变量保留原始占位符并打印警告。
    """
    if isinstance(obj, str):
        def replacer(match):
            var_name = match.group(1)
            val = os.environ.get(var_name)
            if val is None:
                print(f'[config] WARNING: ${{{var_name}}} not set in environment')
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
    主加载流程：
      1. 读取 .env（补充环境变量，不覆盖 docker compose environment 已有值）
      2. 读取 app-runtime.yaml
      3. 展开 ${VAR} 占位符
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


# 模块级单例：首次 import 时自动加载配置
cfg = _load_config()


# ── 便捷访问函数 ─────────────────────────────────────────────
# 以下函数封装常用配置段，避免各业务模块重复解析字典结构。

def get(section, key, default=None):
    """二级键值读取。get('database', 'host') → '192.168.50.118'"""
    return cfg.get(section, {}).get(key, default)


def db_config():
    """返回 psycopg2.connect() 可直接展开的参数字典。"""
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
    """返回图片存储模式：none | retention | permanent"""
    return cfg.get('storage', {}).get('mode', 'retention')


def image_dir():
    """返回图片存储目录 Path 对象，目录不存在时自动创建。"""
    path = cfg.get('storage', {}).get('path', '/app/images')
    p = Path(path)
    if storage_mode() != 'none':
        p.mkdir(parents=True, exist_ok=True)
    return p


def face_thresholds():
    """返回人脸识别阈值 (threshold_high, threshold_low)。"""
    face = cfg.get('face', {})
    return (
        float(face.get('threshold_high', 0.75)),
        float(face.get('threshold_low',  0.40)),
    )


def cleanup_config():
    """返回 cleanup 调度配置字典。"""
    return cfg.get('storage', {}).get('cleanup', {
        'schedule':       'interval',
        'interval_hours': 6,
        'daily_time':     '03:00',
    })


def log_level():
    """返回日志级别字符串：INFO / DEBUG"""
    return cfg.get('logging', {}).get('level', 'INFO')


def log_format():
    """返回日志格式字符串。"""
    return cfg.get('logging', {}).get(
        'format', '%(asctime)s %(levelname)s %(name)s %(message)s'
    )
