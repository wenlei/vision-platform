import os
import pytest

BASE_URL = os.environ.get("VISION_API_URL", "http://192.168.50.3:8000")


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def sample_image_path():
    path = os.path.join(os.path.dirname(__file__), "fixtures", "test.jpg")
    if os.path.exists(path):
        return path
    return None


@pytest.fixture(scope="session")
def sample_image_bytes():
    import struct

    path = os.path.join(os.path.dirname(__file__), "fixtures", "test.jpg")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()

    minimal = (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        b"\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t"
        b"\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a"
        b"\x1f\x1e\x1d\x1a\x1c\x1c $.\x27 \x22,+1C1C333333333333"
        b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
        b"\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00"
        b"\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b"
        b"\xff\xda\x00\x08\x01\x01\x00\x00?\x00T\xdb\x9e\xa7\x93\xdd"
        b"\xff\xd9"
    )
    return minimal
