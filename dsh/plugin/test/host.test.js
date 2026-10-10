#!/usr/bin/env node
/**
 * Host-half tests for the DSH plugin: the pure logic plus the error behavior
 * every failure path must show a user.
 *
 * These run with plain Node and no DSH, no device and no network, which is what
 * makes them useful in CI and on a machine with no iPhone attached.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'
import {
  DEFAULTS,
  ROUTES,
  isLoopbackHostname,
  isTrustedRequest,
  loadToolTable,
  renderToolResult,
  resolveConfig,
  unwrapPanel,
  unwrapToolResult,
} from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')

/** Build one MCP tools/call result carrying a JSON text block. */
function textResult(value, extra = {}) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false, ...extra }
}

test('config resolves the shipped bridge and honours every override', () => {
  const base = resolveConfig(undefined)
  // The packaged layout embeds `server/` beside the entry; running from the
  // repository instead resolves the repository's own bridge. Either way the
  // resolved path must be a real bridge, never a path outside the project.
  assert.ok(existsSync(base.entrypoint), 'resolved entrypoint does not exist: ' + base.entrypoint)
  assert.match(base.entrypoint, /(^|\/)server\/iphone_use\.py$/)
  // Confined to the project: the package root when installed, the repository
  // root when run from source. It must never resolve elsewhere on the machine.
  const projectRoot = resolve(PLUGIN, '..', '..')
  assert.ok(base.entrypoint.startsWith(projectRoot), base.entrypoint)
  assert.equal(base.python, '')
  assert.equal(base.panel, true)
  assert.equal(base.callTimeoutMs, DEFAULTS.callTimeoutMs)

  const custom = resolveConfig({
    python: '/opt/homebrew/bin/python3',
    entrypoint: './elsewhere/bridge.py',
    env: { IPHONE_USE_STATE_DIR: '/tmp/state' },
    callTimeoutMs: 1000,
    panel: false,
  })
  assert.equal(custom.python, '/opt/homebrew/bin/python3')
  assert.equal(custom.entrypoint, resolve('./elsewhere/bridge.py'))
  assert.equal(custom.env.IPHONE_USE_STATE_DIR, '/tmp/state')
  assert.equal(custom.callTimeoutMs, 1000)
  assert.equal(custom.panel, false)
  // Nested defaults survive a partial override.
  assert.equal(custom.shutdownGraceMs, DEFAULTS.shutdownGraceMs)
})

test('the generated tool table loads and matches the bridge', async () => {
  const table = await loadToolTable()
  // Derived from the bridge, not pinned: a literal here would have to be edited
  // on every bridge release and would hide a stale generated table as "passing".
  const declared = /^VERSION="([^"]+)"/m.exec(
    readFileSync(join(HERE, '..', '..', '..', 'server', 'iphone_use.py'), 'utf8'),
  )?.[1]
  assert.equal(table.version, declared)
  assert.equal(table.tools.length, 19)
  assert.equal(table.tools.filter((tool) => tool.appOnly).length, 2)
})

test('a successful bridge result becomes the canonical value', () => {
  const value = unwrapToolResult(textResult({ ok: true, count: 2 }))
  assert.deepEqual(value, { ok: true, count: 2 })
})

test('a bridge failure surfaces the bridge\'s own message and code', () => {
  const result = {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'device_busy', message: 'Another iPhone Use operation is running.', uncertain: false } }) }],
    isError: true,
  }
  assert.throws(
    () => unwrapToolResult(result),
    (error) => {
      assert.equal(error.name, 'IPhoneUseError')
      assert.equal(error.code, 'device_busy')
      assert.match(error.message, /Another iPhone Use operation/)
      return true
    },
  )
})

test('a flat error object is still read, and an unknown shape is honest', () => {
  assert.throws(
    () => unwrapToolResult({ content: [{ type: 'text', text: JSON.stringify({ code: 'x', message: 'flat' }) }], isError: true }),
    (error) => error.message === 'flat',
  )
  assert.throws(
    () => unwrapToolResult({ content: [{ type: 'text', text: '{}' }], isError: true }),
    (error) => error.message === 'the phone operation failed',
  )
})

test('an existing screenshot is named on disk for read_image', () => {
  const value = unwrapToolResult(textResult({ image: { path: '/tmp/shot.png' }, ok: true }))
  assert.equal(value.image_saved_to, '/tmp/shot.png')
  const nested = unwrapToolResult(textResult({ observation: { image: { path: '/tmp/obs.png' } } }))
  assert.equal(nested.image_saved_to, '/tmp/obs.png')
  const last = unwrapToolResult(textResult({ results: [{ observation: { image: { path: '/tmp/last.png' } } }] }))
  assert.equal(last.image_saved_to, '/tmp/last.png')
})

test('a failed operation still names its evidence screenshot on the error', () => {
  const result = {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: { code: 'element_not_found', message: 'no target', observation: { image: { path: '/tmp/fail.png' } } } }),
    }],
    isError: true,
  }
  assert.throws(
    () => unwrapToolResult(result),
    (error) => {
      // The model must be able to open the screenshot of the failed state even
      // though the call failed, so the path rides the thrown error.
      assert.equal(error.details.image_saved_to, '/tmp/fail.png')
      assert.equal(error.message, 'no target')
      return true
    },
  )
})

test('a malformed bridge result never yields a value', () => {
  assert.throws(() => unwrapToolResult(null), /malformed/)
  assert.throws(() => unwrapToolResult('nope'), /malformed/)
})

test('a panel frame keeps its structured payload', () => {
  const frame = { frame: { seq: 3, data: 'abc', mimeType: 'image/png' }, paused: false }
  assert.deepEqual(unwrapPanel({ content: [], structuredContent: frame, isError: false }), frame)
  // Older bridges answer with one text block.
  assert.deepEqual(unwrapPanel({ content: [{ type: 'text', text: JSON.stringify(frame) }] }), frame)
  assert.deepEqual(unwrapPanel({ content: [] }), {})
  assert.equal(unwrapPanel({ content: [{ type: 'text', text: 'not json' }] }).error, 'invalid_response')
})

test('every rendered result is one JSON text block', () => {
  const blocks = renderToolResult({ ok: true })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.deepEqual(JSON.parse(blocks[0].text), { ok: true })
})

test('the panel fence rejects anything but a same-origin loopback request', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('192.168.1.10'), false)
  assert.equal(isLoopbackHostname('evil.example.com'), false)

  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:19387' } }), true)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' } }), true)
  // No host at all is not a browser request this fence should serve.
  assert.equal(isTrustedRequest({ headers: {} }), false)
  // A public authority is refused unless the deployment names it trusted.
  assert.equal(isTrustedRequest({ headers: { host: 'dsh.example.com' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: 'dsh.example.com' } }, ['dsh.example.com']), true)
  // Cross-site and cross-origin requests are refused even on loopback.
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', origin: 'http://evil.example.com' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } }), true)
})

test('the panel routes are namespaced and stable', () => {
  assert.deepEqual(ROUTES, {
    state: '/iphone-use/state',
    frame: '/iphone-use/frame',
    action: '/iphone-use/action',
  })
})

test('the plugin declares no dependency and never imports a Codex module', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  for (const file of ['index.js', 'lib/bridge.js', 'client.js']) {
    const source = readFileSync(join(PLUGIN, file), 'utf8')
    assert.doesNotMatch(source, /require\(['"]@deepseek-ai/)
    assert.doesNotMatch(source, /from ['"]@deepseek-ai/)
    assert.doesNotMatch(source, /\.codex/)
  }
})
test('the guide entry carries the order the tab registry requires', () => {
  // The registry's SidebarRightGuideEntry makes `order` mandatory; omitting it
  // used to leave the tab type out of the column's guide entirely, so the
  // feature existed but could not be reached from the UI.
  const source = readFileSync(join(PLUGIN, 'client.js'), 'utf8')
  const guide = source.slice(source.indexOf('guide: ['), source.indexOf('guide: [') + 500)
  assert.match(guide, /order:\s*\d+/, 'the guide entry must declare a numeric order')
  assert.match(guide, /id:\s*TAB_KIND/, 'the guide entry must name the kind it opens')
  assert.match(guide, /title:\s*function/, 'title must be a lazy thunk as the type declares')
})

test('the panel keeps the newest frame instead of blanking on a repeat poll', () => {
  // The bridge serves each frame once and answers a repeat poll with a null
  // frame. Replacing the whole preview every poll blanked a live device half a
  // second after its first frame, so the panel must accumulate.
  const source = readFileSync(join(PLUGIN, 'client.js'), 'utf8')
  assert.match(source, /lastFrame\.current\s*=/, 'the panel must retain the newest frame')
  assert.match(source, /merged\.frame\s*=\s*lastFrame\.current/, 'a poll must re-attach the retained frame')
})

test('the panel reveal watcher lives on the plugin, not inside the panel body', () => {
  // A body only mounts once its tab is open, so a watcher inside it could
  // never open the tab it lives in.
  const source = readFileSync(join(PLUGIN, 'client.js'), 'utf8')
  const applyAt = source.indexOf('function apply(ctx)')
  const revealAt = source.indexOf('ctx.sidebarRight.openTab(TAB_KIND)')
  assert.ok(applyAt !== -1 && revealAt !== -1, 'both the plugin body and the reveal call must exist')
  assert.ok(revealAt > applyAt, 'the reveal call must be inside apply(), not in PhonePanel')
})
