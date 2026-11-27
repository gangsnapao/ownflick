'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../../spooly/static/caption_format.js'), 'utf8');

function loadCaption(storage) {
  const window = {
    localStorage: {
      getItem: (key) => (storage && storage[key]) || null,
      setItem: (key, value) => { if (storage) storage[key] = value; },
    },
  };
  vm.runInNewContext(source, { window });
  return window.SpoolyCaption;
}

const cases = JSON.parse(readFileSync(path.join(__dirname, '../caption_cases.json'), 'utf8'));

test('formatCaption matches the shared caption case table', () => {
  const caption = loadCaption();
  for (const entry of cases) {
    assert.equal(
      caption.format(entry.file), entry.caption,
      `${entry.file} should display as ${entry.caption}`,
    );
  }
});

test('formatCaption falls back to the base name when everything is stripped', () => {
  const caption = loadCaption();
  assert.equal(caption.format('12345.mp4'), '12345.mp4');
  assert.equal(caption.format(''), '');
  assert.equal(caption.format(null), '');
});

test('baseName keeps the full file name for tooltips', () => {
  const caption = loadCaption();
  assert.equal(caption.baseName('@default/私密/a b.mp4'), 'a b.mp4');
  assert.equal(caption.baseName('a\\b\\c.jpg'), 'c.jpg');
});

test('display honours the caption / filename toggle', () => {
  const storage = {};
  const caption = loadCaption(storage);
  assert.equal(caption.mode(), 'caption');
  assert.equal(caption.display('2022-12-30 17.15.06 文案_9.mp4'), '文案');
  caption.setMode('filename');
  assert.equal(caption.mode(), 'filename');
  assert.equal(caption.display('2022-12-30 17.15.06 文案_9.mp4'), '2022-12-30 17.15.06 文案_9.mp4');
  caption.setMode('caption');
  assert.equal(caption.display('2022-12-30 17.15.06 文案_9.mp4'), '文案');
});
