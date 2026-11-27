"""Public behavior of the single full-library random Flow."""

import os
from pathlib import Path

import pytest

from spooly.app import create_app
from spooly.services.shuffle import ShuffleService


@pytest.fixture
def shuffled(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    for index in range(47):
        suffix = 'mp4' if index < 13 else 'jpg'
        path = root / f'{index:03d}.{suffix}'
        path.write_bytes(b'media')
        os.utime(path, (1_600_000_000 + index * 86400, 1_600_000_000 + index * 86400))
    (root / 'song.mp3').write_bytes(b'audio')
    app = create_app({'TESTING': True, 'MEDIA_ROOT': root})
    return app.test_client(), root


def request_page(client, **query):
    response = client.get('/api/feed/mix', query_string=query)
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def names(page):
    return [item['name'] for item in page['items']]


def all_pages(client, seed='fixed', size=8, **query):
    seen, after = [], ''
    for _ in range(100):
        page = request_page(client, seed=seed, size=size, after=after, **query)
        batch = names(page)
        assert not set(seen).intersection(batch)
        seen.extend(batch)
        if not page['has_more']:
            return seen
        assert page['next_after'] and page['next_after'] != after
        after = page['next_after']
    pytest.fail('Random pagination failed to terminate')


def test_whole_library_permutation_is_stable_and_covers_both_types(shuffled):
    client, _root = shuffled
    first = all_pages(client)
    assert len(first) == len(set(first)) == 47
    assert sum(name.endswith('.mp4') for name in first) == 13
    assert sum(name.endswith('.jpg') for name in first) == 34
    assert first == all_pages(client)
    assert first != all_pages(client, seed='another-seed')
    page_names = []
    for page in range(1, 7):
        page_names.extend(names(request_page(client, seed='fixed', size=8, page=page)))
    assert first == page_names
    assert first != sorted(first) and first != sorted(first, reverse=True)


def test_order_ignores_timestamps_and_activity(shuffled):
    client, root = shuffled
    before = all_pages(client)
    for index, path in enumerate(root.iterdir()):
        stamp = 1_800_000_000 - index * 100
        os.utime(path, (stamp, stamp))
    app = create_app({'TESTING': True, 'MEDIA_ROOT': root})
    other = app.test_client()
    for uri in before[:12]:
        other.post('/api/activity', json={'uri': uri, 'media_type': 'video' if uri.endswith('.mp4') else 'image', 'event': 'impression'})
        other.post(f'/api/media/{uri}/favorite', json={'state': True})
    assert all_pages(other) == before


def test_new_seed_has_256_bits_and_round_boundary_never_repeats(shuffled):
    client, _root = shuffled
    one = request_page(client, size=1)
    two = request_page(client, size=1)
    assert len(one['seed']) == 64 and int(one['seed'], 16) >= 0
    assert one['seed'] != two['seed']
    previous = names(one)[0]
    following = request_page(client, size=8, avoid_uri=previous)
    sequence = all_pages(client, seed=following['seed'], avoid_uri=previous)
    assert len(sequence) == 47
    assert sequence[0] != previous
    assert names(following) == sequence[:8]
    assert previous in sequence


def test_boundary_collision_redraws_seed_without_changing_seeded_cursors(shuffled, monkeypatch):
    client, root = shuffled
    collision_seed = 'colliding-round'
    previous = all_pages(client, seed=collision_seed)[0]
    accepted_seed = next(
        str(index) for index in range(100)
        if names(request_page(client, seed=str(index), size=1))[0] != previous
    )
    candidates = iter([collision_seed, accepted_seed])
    monkeypatch.setattr(ShuffleService, 'new_seed', staticmethod(lambda: next(candidates)))
    first = request_page(client, size=8, avoid_uri=previous)
    assert first['seed'] == accepted_seed and names(first)[0] != previous
    order = all_pages(client, seed=first['seed'], avoid_uri=previous)
    assert len(order) == 47 and order == all_pages(client, seed=accepted_seed)
    # Explicit seeds reconstruct the original permutation, even with a boundary URI.
    assert all_pages(client, seed=collision_seed, avoid_uri=previous)[0] == previous
    (root / Path(order[0]).name).unlink()
    following = request_page(client, seed=accepted_seed, after=first['next_after'],
                             size=8, avoid_uri=previous)
    assert names(following) == order[8:16]


def test_automatic_rounds_do_not_pin_the_previous_last_item(shuffled, monkeypatch):
    client, _root = shuffled
    candidates = iter(f'round-{index}' for index in range(1000))
    monkeypatch.setattr(ShuffleService, 'new_seed', staticmethod(lambda: next(candidates)))
    previous = ''
    tails = set()
    for _ in range(8):
        page = request_page(client, size=100, avoid_uri=previous)
        sequence = names(page)
        assert len(sequence) == len(set(sequence)) == 47
        assert sequence[0] != previous
        previous = sequence[-1]
        tails.add(previous)
    assert len(tails) > 1


def test_resume_reconstructs_anchor_and_deleted_current_chooses_successor(shuffled):
    client, root = shuffled
    order = all_pages(client)
    target = order[21]
    restored = request_page(client, seed='fixed', size=8, resume_uri=target)
    assert restored['resume_found'] is True
    assert names(restored) == order[21:29]
    (root / Path(target).name).unlink()
    restored = request_page(client, seed='fixed', size=8, resume_uri=target)
    assert restored['resume_found'] is False
    assert names(restored) == order[22:30]
    assert target not in names(restored)


def test_keyset_survives_removal_before_cursor_and_revalidates_additions(shuffled):
    client, root = shuffled
    order = all_pages(client)
    first = request_page(client, seed='fixed', size=8)
    (root / Path(order[0]).name).unlink()
    following = request_page(client, seed='fixed', size=8, after=first['next_after'])
    assert names(following) == order[8:16]
    assert following['revision'] != first['revision']
    new_file = root / 'new-image.png'
    new_file.write_bytes(b'new')
    other = create_app({'TESTING': True, 'MEDIA_ROOT': root}).test_client()
    updated = all_pages(other)
    assert len(updated) == 47 and '@default/new-image.png' in updated
    assert order[0] not in updated


def test_deleted_last_anchor_and_single_item_fallback(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    only = root / 'one.jpg'
    only.write_bytes(b'image')
    client = create_app({'TESTING': True, 'MEDIA_ROOT': root}).test_client()
    one = request_page(client, seed='s', avoid_uri='@default/one.jpg')
    assert names(one) == ['@default/one.jpg'] and not one['has_more']
    missing = request_page(client, seed='s', resume_uri='@default/deleted.jpg')
    assert names(missing) == ['@default/one.jpg'] and not missing['resume_found']
    only.unlink()
    empty = request_page(client, seed='s', resume_uri='@default/one.jpg')
    assert empty['items'] == [] and empty['total'] == 0 and not empty['has_more']


def test_excludes_unavailable_and_outside_symlink_targets(shuffled, tmp_path):
    client, root = shuffled
    order = all_pages(client)
    (root / Path(order[0]).name).unlink()
    target = root / Path(order[1]).name
    target.unlink()
    outside = tmp_path / 'outside.jpg'
    outside.write_bytes(b'private')
    target.symlink_to(outside)
    visible = all_pages(client)
    assert len(visible) == 45
    assert order[0] not in visible and order[1] not in visible


def test_random_key_has_no_metadata_or_input_order_dependency():
    # Broad deterministic seed coverage catches type quotas and filename-order shortcuts.
    pool = [f'@default/{index:02d}.jpg' for index in range(12)]
    counts = {uri: 0 for uri in pool}
    for seed in range(1200):
        ordered = sorted(pool, key=lambda uri: ShuffleService.key(str(seed), uri))
        assert ordered == sorted(reversed(pool), key=lambda uri: ShuffleService.key(str(seed), uri))
        counts[ordered[0]] += 1
    assert all(65 <= count <= 140 for count in counts.values())


@pytest.mark.parametrize('query', [{'seed': 'x' * 513}, {'seed': '\x00'}, {'resume_uri': 'x' * 4097}])
def test_shuffle_rejects_unbounded_or_invalid_identifiers(shuffled, query):
    client, _root = shuffled
    assert client.get('/api/feed/mix', query_string=query).status_code == 400
