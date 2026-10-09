import pytest

from categorize import is_out_of_box

# Each text below is a real Issue note from Spirit Web DB.
CASES = [
    ("console damaged oob", True),
    ("Gen. Help, E50H error oob.", True),
    ("Other, UNIT HAS AN E5 ERROR OUT OF BOX", True),
    ("the fan has not worked since it was taken out of the box", True),
    ("Gen. Help, E5oob", True),
    ("Other, E5 ERROR OOBassembly", True),
    ("controller sent was doa. needs replacement asap", False),
    ("noise, from rear roller", False),
]


@pytest.mark.parametrize("text,expected", CASES)
def test_is_out_of_box(text, expected):
    assert is_out_of_box(text) is expected
