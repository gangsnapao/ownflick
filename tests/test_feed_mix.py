import json
import os
import time
import sqlite3
from urllib.parse import quote

import pytest
from flask import template_rendered

from spooly.app import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    media_root = tmp_path / "media"
    media_root.mkdir(parents=True, exist_ok=True)
    (media_root / "v1.mp4").write_bytes(b"00")
    (media_root / "v2.mp4").write_bytes(b"00")
    (media_root / "nested").mkdir(parents=True, exist_ok=True)
    (media_root / "nested" / "v 3.mp4").write_bytes(b"00")

    (media_root / "i1.jpg").write_bytes(b"00")
    (media_root / "i2.png").write_bytes(b"00")

    monkeypatch.setenv("MEDIA_ROOT", str(media_root))

    app = create_app({"TESTING": True, "MEDIA_ROOT": media_root})
    return app.test_client()


def test_mix_feed_returns_typed_items(client):
    res = client.get("/api/feed/mix?page=1&size=12&seed=fixed-seed&snapshot=1")
    assert res.status_code == 200
    data = res.get_json()

    assert isinstance(data, dict)
    assert "items" in data
    assert "seed" in data
    assert "has_more" in data
    assert data["has_more"] is False
    assert data['page'] == 1
    assert data['seed'] == 'fixed-seed'

    items = data["items"]
    assert isinstance(items, list)
    assert len(items) > 0

    types = {item.get("type") for item in items}
    assert "video" in types
    assert "image" in types

    for item in items:
        assert "name" in item
        assert "media_url" in item
        assert "detail_url" in item
        assert item["recommendation_reason"]
        assert item["type"] in {"video", "image"}
        assert item['id'] == item['name']
        assert item['is_liked'] is False and item['liked_at'] is None
        assert item['is_favorited'] is False and item['favorited_at'] is None
        if item["type"] == "video":
            assert item["detail_url"].startswith("/detail/")
        else:
            assert item["detail_url"].startswith("/image?uri=")


def _assert_reactions(item, state=None):
    expected = state or {
        'is_liked': False, 'liked_at': None, 'is_favorited': False, 'favorited_at': None,
    }
    assert item['id'] == item['name']
    for key in ('is_liked', 'liked_at', 'is_favorited', 'favorited_at'):
        assert item[key] == expected[key]


def _set_reaction(client, name, kind):
    response = client.post(f'/api/media/{quote(name, safe="")}/{kind}', json={'state': True})
    assert response.status_code == 200
    return response.get_json()['data']


def test_mix_feed_hydrates_saved_states_in_one_batch_without_writing(client, monkeypatch):
    reactions = client.application.extensions['media_reactions']
    initial = client.get('/api/feed/mix?seed=fixed-seed').get_json()
    assert initial['items']
    with reactions.database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM media_reactions').fetchone()[0] == 0
    expected = {}
    for name, kind in (
        ('v1.mp4', 'like'), ('v1.mp4', 'favorite'), ('v2.mp4', 'like'),
        ('i1.jpg', 'favorite'), ('nested/v 3.mp4', 'like'),
    ):
        expected[f'@default/{name}'] = _set_reaction(client, name, kind)
    with reactions.database.connect() as conn:
        before = [dict(row) for row in conn.execute('SELECT * FROM media_reactions ORDER BY uri')]
    calls = []
    get_many = reactions.get_many

    def track_batch(uris):
        calls.append(uris)
        return get_many(uris)

    monkeypatch.setattr(reactions, 'get_many', track_batch)
    monkeypatch.setattr(reactions, 'get', lambda _uri: pytest.fail('Feed reads must be batched.'))
    for _ in range(3):
        response = client.get('/api/feed/mix?seed=fixed-seed')
        assert response.status_code == 200
        payload = response.get_json()
        assert {item['name'] for item in payload['items']} == {item['name'] for item in initial['items']}
        for item in payload['items']:
            _assert_reactions(item, expected.get(item['name']))
            assert item['recommendation_reason']
    assert len(calls) == 3
    assert all(len(uris) == len(initial['items']) for uris in calls)
    with reactions.database.connect() as conn:
        assert [dict(row) for row in conn.execute('SELECT * FROM media_reactions ORDER BY uri')] == before


def test_mix_feed_ignores_legacy_recommendations_and_hydrates_saved_state(tmp_path, monkeypatch):
    (tmp_path / 'clip.mp4').write_bytes(b'video')
    monkeypatch.setattr(
        'spooly.services.recommendation.RecommendService.get_weighted_selection',
        lambda *_args, **_kwargs: pytest.fail('Flow must not use weighted recommendations.'),
    )
    client = create_app({'TESTING': True, 'MEDIA_ROOT': tmp_path}).test_client()
    saved = _set_reaction(client, 'clip.mp4', 'like')
    response = client.get('/api/feed/mix?seed=legacy-name&mode=forgotten&filter=liked')
    assert response.status_code == 200
    items = response.get_json()['items']
    assert len(items) == 1
    item = items[0]
    assert item['name'] == '@default/clip.mp4'
    assert item['id'] == saved['uri'] == '@default/clip.mp4'
    for key in ('is_liked', 'liked_at', 'is_favorited', 'favorited_at'):
        assert item[key] == saved[key]


def test_mix_feed_preserves_distinct_index_uris_without_aliasing_reactions(tmp_path):
    media_root = tmp_path / 'media'
    media_root.mkdir()
    for name in ('clip.mp4', ' clip.mp4'):
        (media_root / name).write_bytes(b'video')
    client = create_app({'TESTING': True, 'MEDIA_ROOT': media_root}).test_client()
    saved = _set_reaction(client, 'clip.mp4', 'like')
    saved = _set_reaction(client, 'clip.mp4', 'favorite')
    response = client.get('/api/feed/mix?seed=distinct-uris')
    assert response.status_code == 200
    items = {item['name']: item for item in response.get_json()['items']}
    assert set(items) == {'@default/clip.mp4', '@default/ clip.mp4'}
    _assert_reactions(items['@default/clip.mp4'], saved)
    _assert_reactions(items['@default/ clip.mp4'])
    reactions = client.application.extensions['media_reactions']
    with reactions.database.connect() as conn:
        conn.execute(
            'INSERT INTO media_reactions(uri, is_liked, liked_at, updated_at) VALUES (?, 1, ?, ?)',
            ('@default/ clip.mp4', '2020-01-01T00:00:00+00:00', '2020-01-01T00:00:00+00:00'),
        )
    response = client.get('/api/feed/mix?seed=distinct-uris')
    assert response.status_code == 200
    items = {item['name']: item for item in response.get_json()['items']}
    _assert_reactions(items['@default/clip.mp4'], saved)
    _assert_reactions(items['@default/ clip.mp4'], {
        'is_liked': True, 'liked_at': '2020-01-01T00:00:00+00:00',
        'is_favorited': False, 'favorited_at': None,
    })


@pytest.mark.parametrize('flow_filter', [None, 'liked', 'favorited', 'forgotten', 'invalid', 'LIKED'])
def test_flow_view_ignores_legacy_reaction_filters(client, flow_filter):
    contexts = []

    def capture_context(_sender, template, context, **_extra):
        contexts.append(context)

    query = {} if flow_filter is None else {'filter': flow_filter}
    with template_rendered.connected_to(capture_context, client.application):
        response = client.get('/flow', query_string=query)
    assert response.status_code == 200
    assert len(contexts) == 1
    assert contexts[0]['menu'] == 'flow'
    assert contexts[0]['flow_filter'] == ''


@pytest.mark.parametrize('extension,grouped,count', [
    ('mp4', False, 24), ('jpg', False, 24), ('jpg', True, 24),
    ('mixed', False, 24), ('jpg', False, 0),
])
def test_feed_cards_and_groups_preserve_all_media_across_pages(tmp_path, monkeypatch, extension, grouped, count):
    media_root = tmp_path / 'media'
    media_root.mkdir()
    names = [
        f'item-{index:02d}.{("mp4" if index < 6 else "jpg") if extension == "mixed" else extension}'
        for index in range(count)
    ]
    for name in names:
        (media_root / name).write_bytes(b'media')
    data_root = tmp_path / 'spooly-data'
    data_root.mkdir()
    if grouped:
        (data_root / 'download_sources.json').write_text(json.dumps({
            'version': 1,
            'items': {f'@default/{name}': {
                'source_url_raw': 'https://example.com/post/1',
                'source_url_display': 'https://example.com/post/1',
                'source_domain': 'example.com',
                'job_id': 'one-post',
            } for name in names},
        }))
    client = create_app({'TESTING': True, 'MEDIA_ROOT': media_root}).test_client()

    seen, seen_types = [], []
    pages = max(1, (count + 7) // 8)
    for page in range(1, pages + 1):
        response = client.get('/api/feed/mix', query_string={'page': page, 'size': 8, 'seed': 'fixed'})
        assert response.status_code == 200
        payload = response.get_json()
        page_names = []
        for item in payload['items']:
            seen_types.append(item['type'])
            assert item['type'] in {'image', 'video'}
            assert item['type'] != 'image_group'
            page_names.append(item['name'])
        assert len(page_names) == min(8, max(0, count - (page - 1) * 8))
        assert not set(page_names).intersection(seen)
        assert payload['has_more'] is (page < pages and count > 0)
        seen.extend(page_names)
    assert set(seen) == {f'@default/{name}' for name in names}
    assert len(seen) == count
    assert set(seen_types) <= {'image', 'video'}


def _age(path, days):
    stamp = time.time() - days * 86400
    os.utime(path, (stamp, stamp))


def test_mix_feed_ignores_legacy_gallery_inputs_and_covers_full_library(tmp_path, monkeypatch):
    media_root = tmp_path / 'media'
    media_root.mkdir()
    photos = [f'photo-{index}.jpg' for index in range(3)]
    for name in photos:
        (media_root / name).write_bytes(b'image')
        _age(media_root / name, 400)
    videos = [f'video-{index}.mp4' for index in range(18)]
    for name in videos:
        (media_root / name).write_bytes(b'video')
    (media_root / 'audio.mp3').write_bytes(b'audio')
    data_root = tmp_path / 'spooly-data'
    data_root.mkdir()
    (data_root / 'download_sources.json').write_text(json.dumps({
        'version': 1,
        'items': {f'@default/{name}': {
            'source_url_raw': 'https://example.com/gallery/1', 'job_id': 'gallery',
        } for name in photos},
    }))
    monkeypatch.setattr(
        'spooly.services.recommendation.RecommendService.get_weighted_selection',
        lambda *_args, **_kwargs: pytest.fail('The full-library Flow must not use recommendations.'),
    )
    app = create_app({'TESTING': True, 'MEDIA_ROOT': media_root})
    client = app.test_client()
    reactions = app.extensions['media_reactions']
    expected = {
        '@default/photo-0.jpg': _set_reaction(client, photos[0], 'like'),
        '@default/video-0.mp4': _set_reaction(client, videos[0], 'favorite'),
    }
    with reactions.database.connect() as conn:
        before = [dict(row) for row in conn.execute('SELECT * FROM media_reactions ORDER BY uri')]

    baseline = client.get('/api/feed/mix?seed=full-library&size=8&page=1').get_json()
    expected_names = {f'@default/{name}' for name in photos + videos}
    seen = []
    pages = max(1, (len(photos + videos) + 7) // 8)
    for page in range(1, pages + 1):
        payload = client.get(
            '/api/feed/mix', query_string={'seed': 'full-library', 'size': 8, 'page': page},
        ).get_json()
        names = [item['name'] for item in payload['items']]
        assert len(names) == min(8, len(photos + videos) - (page - 1) * 8)
        assert not set(names).intersection(seen)
        assert all(item['type'] in {'image', 'video'} for item in payload['items'])
        assert payload['has_more'] is (page < pages)
        seen.extend(names)
    assert set(seen) == expected_names
    assert len(seen) == len(expected_names)

    for legacy_query in (
        {'mode': 'forgotten'}, {'filter': 'liked'}, {'folder': '@default/album'},
        {'collection': 'old-collection'}, {'order': 'recent'},
    ):
        query = {'seed': 'full-library', 'size': 8, 'page': 1, **legacy_query}
        payload = client.get('/api/feed/mix', query_string=query).get_json()
        assert [item['name'] for item in payload['items']] == [item['name'] for item in baseline['items']]

    for item in client.get('/api/feed/mix?seed=full-library&size=24').get_json()['items']:
        state = expected.get(item['name'])
        _assert_reactions(item, state)
    with reactions.database.connect() as conn:
        assert [dict(row) for row in conn.execute('SELECT * FROM media_reactions ORDER BY uri')] == before


def test_flow_activity_builds_and_clears_local_profile(client, tmp_path):
    events = [
        {
            "session_id": "session-1",
            "uri": "@default/nested/v 3.mp4",
            "media_type": "video",
            "surface": "flow",
            "event": "impression",
        },
        {
            "session_id": "session-1",
            "uri": "@default/nested/v 3.mp4",
            "media_type": "video",
            "surface": "flow",
            "event": "complete",
            "ratio": 0.94,
            "visible_ms": 12000,
        },
    ]
    res = client.post("/api/activity", json={"events": events})

    assert res.status_code == 200
    assert res.get_json()["data"]["accepted"] == 2
    db_path = tmp_path / "spooly-data" / "spooly.sqlite3"
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT impressions, completes, affinity_score FROM media_affinity WHERE uri = ?",
            ("@default/nested/v 3.mp4",),
        ).fetchone()
        dimensions = dict(conn.execute(
            """
            SELECT dimension_type, positive_score
            FROM preference_dimensions
            WHERE dimension_value IN ('video', 'default', 'default/nested')
            """
        ).fetchall())
    assert row[0:2] == (1, 1)
    assert row[2] > 0
    assert set(dimensions) == {"media_type", "source", "directory"}
    assert all(score > 0 for score in dimensions.values())

    assert client.delete("/api/activity").get_json()["success"] is True
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM media_affinity").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM preference_dimensions").fetchone()[0] == 0
