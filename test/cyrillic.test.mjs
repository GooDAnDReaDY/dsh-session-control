import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.resolve(__dirname, '../lib')

test('zero Cyrillic characters in lib/*.js code and comments', () => {
  const cyrillicRegex = /[\u0400-\u04FF]/
  const files = fs.readdirSync(libDir).filter((f) => f.endsWith('.js'))

  assert.ok(files.length > 0, 'lib directory should contain .js files')

  const violations = []
  for (const file of files) {
    const fullPath = path.join(libDir, file)
    const content = fs.readFileSync(fullPath, 'utf8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (cyrillicRegex.test(lines[i])) {
        violations.push({
          file,
          line: i + 1,
          content: lines[i].trim()
        })
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Expected zero Cyrillic lines in lib/*.js, found ${violations.length}:\n` +
      violations.map((v) => `  ${v.file}:${v.line} -> ${v.content}`).join('\n')
  )
})
