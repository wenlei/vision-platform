"""test_search.py -- /search 检测历史测试"""

import requests


def test_search_default(base_url):
    r = requests.get(f"{base_url}/search", timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert isinstance(d, dict)


def test_search_with_limit(base_url):
    r = requests.get(f"{base_url}/search?limit=5", timeout=10)
    assert r.status_code == 200


def test_search_with_label(base_url):
    r = requests.get(f"{base_url}/search?label=person&limit=1", timeout=10)
    assert r.status_code == 200


def test_images_endpoint(base_url):
    r = requests.get(f"{base_url}/images/nonexistent.jpg", timeout=10)
    assert r.status_code in (404, 200)
