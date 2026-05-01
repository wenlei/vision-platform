"""test_devices.py -- /devices CRUD + scan 测试"""

import requests
import time

TEST_MAC = "AA:BB:CC:DD:EE:01"
TEST_NAME = "test-device-pytest"


def test_devices_list(base_url):
    r = requests.get(f"{base_url}/devices", timeout=10)
    assert r.status_code == 200
    assert "devices" in r.json()


def test_device_register_and_delete(base_url):
    payload = {
        "mac": TEST_MAC,
        "name": TEST_NAME,
        "ip": "192.168.50.99",
        "stream_url": "http://192.168.50.99:81/",
        "tag": "test",
    }
    r = requests.post(f"{base_url}/devices", json=payload, timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert d["mac"] == TEST_MAC
    assert d["name"] == TEST_NAME

    r = requests.delete(f"{base_url}/devices/{TEST_MAC}", timeout=10)
    assert r.status_code == 200


def test_device_not_found(base_url):
    r = requests.get(f"{base_url}/devices/FF:FF:FF:FF:FF:FF", timeout=10)
    assert r.status_code in (200, 404, 405)


def test_device_scan(base_url):
    r = requests.get(f"{base_url}/devices/scan", timeout=15)
    assert r.status_code in (200, 422)
