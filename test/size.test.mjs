import test from 'node:test'
import assert from 'node:assert/strict'
import { sizeLevel, normalizeThresholds, DEFAULT_WARN_EVENTS, DEFAULT_DANGER_EVENTS } from '../lib/size.js'

test('below, at and above the thresholds', () => {
  assert.equal(sizeLevel(0, 1500, 3000), 'ok')
  assert.equal(sizeLevel(1499, 1500, 3000), 'ok')
  assert.equal(sizeLevel(1500, 1500, 3000), 'warn')
  assert.equal(sizeLevel(2999, 1500, 3000), 'warn')
  assert.equal(sizeLevel(3000, 1500, 3000), 'danger')
  assert.equal(sizeLevel(5458, 1500, 3000), 'danger')
})

test('unknown size gives no level instead of a guess', () => {
  assert.equal(sizeLevel(undefined, 1500, 3000), null)
  assert.equal(sizeLevel(null, 1500, 3000), null)
  assert.equal(sizeLevel(Number.NaN, 1500, 3000), null)
  assert.equal(sizeLevel(-1, 1500, 3000), null)
})

test('thresholds typed in the wrong order are swapped', () => {
  assert.deepEqual(normalizeThresholds(3000, 1500), { warn: 1500, danger: 3000 })
  assert.equal(sizeLevel(2000, 3000, 1500), 'warn')
})

test('unusable thresholds fall back to defaults', () => {
  assert.deepEqual(normalizeThresholds(0, -5), { warn: DEFAULT_WARN_EVENTS, danger: DEFAULT_DANGER_EVENTS })
  assert.deepEqual(normalizeThresholds('abc', undefined), { warn: DEFAULT_WARN_EVENTS, danger: DEFAULT_DANGER_EVENTS })
})

test('equal thresholds keep the red badge reachable', () => {
  assert.deepEqual(normalizeThresholds(2000, 2000), { warn: 2000, danger: 2001 })
})
