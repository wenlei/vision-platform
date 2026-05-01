"""test_faces.py -- /face/register /face/identify /faces 测试"""

import requests

TEST_FACE_NAME = "pytest-face-test"


def test_faces_list(base_url):
    r = requests.get(f"{base_url}/faces", timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert "faces" in d


def test_face_identify_no_image(base_url):
    r = requests.post(f"{base_url}/face/identify", timeout=10)
    assert r.status_code in (400, 422, 200)


def test_face_register_cleanup(base_url):
    payload = {"name": TEST_FACE_NAME}
    r = requests.post(
        f"{base_url}/face/register",
        data=payload,
        timeout=30,
    )
    assert r.status_code in (200, 400, 422)
