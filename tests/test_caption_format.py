"""Module J caption cleanup: Python side of the shared behaviour table."""

import json
from pathlib import Path

from spooly.app import create_app
from spooly.services.caption_text import base_name, format_caption

CASES = json.loads((Path(__file__).parent / 'caption_cases.json').read_text(encoding='utf-8'))

def test_format_caption_matches_shared_case_table():
    for entry in CASES:
        assert format_caption(entry['file']) == entry['caption'], entry['file']

def test_base_name_keeps_extension_for_full_name_display():
    assert base_name('@default/私密/a b.mp4') == 'a b.mp4'
    assert base_name('a\\b\\c.jpg') == 'c.jpg'

def test_detail_page_title_uses_caption_and_keeps_full_path(tmp_path):
    media = tmp_path / 'media'
    media.mkdir()
    (media / '2022-12-30 17.15.06 文案测试_123.mp4').write_bytes(b'video')
    client = create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()
    response = client.get('/detail/@default/2022-12-30 17.15.06 文案测试_123.mp4')
    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert '文案测试' in body
    # The info panel keeps the untouched file name and path (J2).
    assert '2022-12-30 17.15.06 文案测试_123.mp4' in body
