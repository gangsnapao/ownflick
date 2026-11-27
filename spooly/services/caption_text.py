"""Filename → caption cleanup for display (module J).

Pure display-layer text shaping: the cleaned caption never replaces the file
name in URIs, search, dedupe or downloads (J4). The canonical behaviour table
lives in ``tests/caption_cases.json`` and is shared with the JavaScript port
(``spooly/static/caption_format.js``) so both implementations stay in sync.
"""

import re

# Extension suffix: real media suffixes start with a letter (``v2.0`` keeps its
# ``.0``). The suffix is stripped first so later rules see the bare stem.
EXTENSION_RE = re.compile(r'\.[A-Za-z][A-Za-z0-9]{0,4}$')

# Leading date/time prefixes, newest formats first. Each is stripped at most
# once, then separators are cleaned up below.
LEADING_PATTERNS = [
    # 2022-12-30 17.15.06 / 2022-12-30_17-15-06 / 20221230-171506
    re.compile(r'^\d{4}[-_. ]?\d{2}[-_. ]?\d{2}[-_. ]+\d{2}[-_.:. ]?\d{2}[-_.:. ]?\d{2}'),
    # 20221230171506（无分隔的紧凑日期时间）
    re.compile(r'^\d{14}[-_ ]*'),
    # 2022-12-30 / 2022.12.30（仅日期）
    re.compile(r'^\d{4}[-_. ]\d{2}[-_. ]\d{2}[-_. ]*'),
    # 20221230文案（紧凑日期直接接文案）
    re.compile(r'^\d{8}(?=[^\d])'),
]

# Trailing numbering: 123 / _123 / -123456 / (2) and repeated groups of them.
TRAILING_NUMBERING_RE = re.compile(r'(?:\s*[-_]\s*\d+|\s*\(\d+\)|\d+)+$')

# Stray separators left over after stripping, at both edges.
EDGE_SEPARATOR_RE = re.compile(r'^[\s\-_\.]+|[\s\-_\.]+$')

# Optional extra rules (J3): e.g. stripping type markers like ``-视频-`` or
# author prefixes. Kept disabled by default; enable by flipping ``enabled``.
OPTIONAL_RULES = [
    # {'pattern': re.compile(r'^[\w一-鿿]+?[-_](?=视频|图集)'), 'enabled': False},
]

def base_name(filename: str) -> str:
    """Last path segment of a URI or path, keeping the extension."""
    text = str(filename or '').replace('\\', '/').rstrip('/')
    return text.rsplit('/', 1)[-1]

def format_caption(filename: str) -> str:
    """Return the display caption for a filename/URI (J1 rules).

    Falls back to the full base name when every rule empties the stem.
    """
    name = base_name(filename)
    stem = EXTENSION_RE.sub('', name)
    for pattern in LEADING_PATTERNS:
        stripped = pattern.sub('', stem, count=1)
        if stripped != stem:
            stem = stripped
            break
    stem = TRAILING_NUMBERING_RE.sub('', stem, count=1)
    stem = EDGE_SEPARATOR_RE.sub('', stem)
    for rule in OPTIONAL_RULES:
        if rule.get('enabled'):
            stem = rule['pattern'].sub('', stem)
            stem = EDGE_SEPARATOR_RE.sub('', stem)
    return stem.strip() or name
