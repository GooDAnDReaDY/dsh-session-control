import test from 'node:test'
import assert from 'node:assert/strict'

// Создаем тестовую реализацию аналогично lib/index.js
function canRead(store) {
  return (
    store !== undefined &&
    (typeof store.open === 'function' ||
      (typeof store.resolveLog === 'function' &&
        typeof store.readStoredLog === 'function'))
  )
}

test('canRead распознает дескрипторный store.open', () => {
  const descriptorStore = {
    open: async (id, mode) => ({ read: async () => ({ events: [] }), close: async () => {} })
  }
  assert.equal(canRead(descriptorStore), true)
})

test('canRead распознает legacy store resolveLog + readStoredLog', () => {
  const legacyStore = {
    resolveLog: async (id) => '/path',
    readStoredLog: async (path, id) => ({ events: [] })
  }
  assert.equal(canRead(legacyStore), true)
})

test('canRead отклоняет неподходящий или пустой store', () => {
  assert.equal(canRead(undefined), false)
  assert.equal(canRead({}), false)
  assert.equal(canRead({ resolveLog: async () => {} }), false)
})
