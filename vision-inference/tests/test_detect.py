"""test_detect.py -- /detect 检测推理测试"""

import requests
import os

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "test.jpg")


def test_detect_upload(base_url):
    if not os.path.exists(FIXTURE):
        import pytest
        pytest.skip("test.jpg not found")
    with open(FIXTURE, "rb") as f:
        r = requests.post(
            f"{base_url}/detect",
            files={"file": ("test.jpg", f, "image/jpeg")},
            timeout=120,
        )
    assert r.status_code == 200
    d = r.json()
    assert "description" in d


def test_detect_device_not_registered(base_url):
    r = requests.post(
        f"{base_url}/detect/AA:BB:CC:DD:EE:FF", timeout=30
    )
    assert r.status_code in (404, 400, 500)


def test_describe_upload(base_url):
    if not os.path.exists(FIXTURE):
        import pytest
        pytest.skip("test.jpg not found")
    with open(FIXTURE, "rb") as f:
        r = requests.post(
            f"{base_url}/describe",
            files={"file": ("test.jpg", f, "image/jpeg")},
            timeout=120,
        )
    assert r.status_code == 200
    d = r.json()
    assert "description" in d
