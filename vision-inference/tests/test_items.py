"""test_items.py -- /register /items CLIP 物品测试"""

import requests


def test_items_list(base_url):
    r = requests.get(f"{base_url}/items", timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert "items" in d


def test_register_no_image(base_url):
    r = requests.post(f"{base_url}/register", timeout=10)
    assert r.status_code in (400, 422, 200)
