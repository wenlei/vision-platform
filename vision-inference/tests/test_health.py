"""test_health.py -- /health /version / 接口测试"""

import requests


def test_health(base_url):
    r = requests.get(f"{base_url}/health", timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "ok"
    assert "device" in d


def test_health_has_db(base_url):
    d = requests.get(f"{base_url}/health", timeout=10).json()
    assert d.get("db_host") is not None


def test_version(base_url):
    r = requests.get(f"{base_url}/version", timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert "version" in d
    assert len(d["version"]) == 8


def test_root_returns_html(base_url):
    r = requests.get(f"{base_url}/", timeout=10)
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
    assert "Vision" in r.text or "vision" in r.text
