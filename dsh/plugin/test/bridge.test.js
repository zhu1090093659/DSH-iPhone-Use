#!/usr/bin/env node
/**
 * Transport tests for the phone-bridge client: the failure paths a user can
 * actually hit when the device bridge is missing, hung, or being shut down.
 *
 * A tiny scripted stdio server stands in for the Python bridge, so these run
 * with plain Node, no DSH, no Python and no device.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { BridgeError, BridgeTransportError, PROTOCOLS, startBridge } from '../lib/bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Write a throwaway stdio server and return its path. */
function scriptedServer(body) {
  const file = join(tmpdir(), `iu-bridge-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, body)
  return file
}

/**
 * The smallest MCP stdio server: it reads newline-delimited JSON-RPC and
 * answers initialize, tools/list and tools/call from the provided handlers.
 */
const SERVER = `
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  const fail = (code, text) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: text } }) + '\\n')
  if (message.method === 'initialize') return send({ protocolVersion: '2025-11-25', capabilities: {} })
  if (message.method === 'tools/list') return send({ tools: [{ name: 'pua_doctor' }] })
  if (message.method === 'tools/call') {
    if (message.params?.name === 'boom') return fail(-32000, 'the phone bridge refused the call')
    if (message.params?.name === 'hang') return
    return send({ content: [{ type: 'text', text: JSON.stringify({ ok: true, name: message.params?.name }) }], isError: false })
  }
  return fail(-32601, 'method not found: ' + message.method)
})
process.stdin.on('end', () => process.exit(0))
`

test('a missing interpreter fails with an actionable transport error', async () => {
  const client = startBridge({
    command: '/nonexistent/definitely-not-python',
    args: [],
    cwd: HERE,
    env: process.env,
  })
  await assert.rejects(
    () => client.request('initialize', {}, 5_000),
    (error) => {
      assert.ok(error instanceof BridgeTransportError, String(error?.name))
      assert.match(error.message, /could not be started/)
      assert.match(error.message, /ENOENT/)
      return true
    },
  )
  // The failure is terminal: a later call reports the cause rather than hanging
  // until its own timeout, which is what a user would otherwise experience.
  await assert.rejects(
    () => client.request('tools/list', {}, 5_000),
    (error) => {
      assert.ok(error instanceof BridgeTransportError)
      assert.match(error.message, /could not be started/)
      return true
    },
  )
  // Shutdown must also complete: no exit event follows a failed spawn.
  await client.stop(1_000)
})

test('a bridge that dies before answering rejects the pending call', async () => {
  const file = scriptedServer('process.exit(3)\n')
  const client = startBridge({ command: process.execPath, args: [file], cwd: HERE, env: process.env })
  await assert.rejects(
    () => client.request('initialize', {}, 5_000),
    (error) => {
      assert.ok(error instanceof BridgeTransportError)
      assert.match(error.message, /exited/)
      return true
    },
  )
  await client.stop(1_000)
})

test('a hung bridge hits the per-request timeout instead of hanging the host', async () => {
  const file = scriptedServer(SERVER)
  const client = startBridge({ command: process.execPath, args: [file], cwd: HERE, env: process.env })
  await client.request('initialize', {}, 5_000)
  await assert.rejects(
    () => client.request('tools/call', { name: 'hang', arguments: {} }, 400),
    (error) => {
      assert.ok(error instanceof BridgeTransportError)
      assert.match(error.message, /did not answer tools\/call within 400 ms/)
      return true
    },
  )
  await client.stop(1_000)
})

test('a bridge error becomes a BridgeError carrying code and data', async () => {
  const file = scriptedServer(SERVER)
  const client = startBridge({ command: process.execPath, args: [file], cwd: HERE, env: process.env })
  await client.request('initialize', {}, 5_000)
  await assert.rejects(
    () => client.request('tools/call', { name: 'boom', arguments: {} }, 5_000),
    (error) => {
      assert.ok(error instanceof BridgeError)
      assert.equal(error.code, -32000)
      assert.match(error.message, /refused the call/)
      return true
    },
  )
  await client.stop(1_000)
})

test('a normal call round-trips, then stop() ends the child', async () => {
  const file = scriptedServer(SERVER)
  const client = startBridge({ command: process.execPath, args: [file], cwd: HERE, env: process.env })
  const ready = await client.request('initialize', {}, 5_000)
  assert.equal(ready.protocolVersion, PROTOCOLS[0])
  const listed = await client.request('tools/list', {}, 5_000)
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['pua_doctor'])
  const called = await client.request('tools/call', { name: 'pua_doctor', arguments: {} }, 5_000)
  assert.equal(JSON.parse(called.content[0].text).name, 'pua_doctor')
  await client.stop(5_000)
  // The child is gone: a later request must fail rather than silently queue.
  await assert.rejects(() => client.request('tools/list', {}, 1_000), (error) => {
    assert.ok(error instanceof BridgeTransportError)
    return true
  })
})

test('a non-protocol stdout line is reported, not parsed as a frame', async () => {
  const file = scriptedServer(`
process.stdout.write('this is a diagnostic, not JSON\\n')
${SERVER}
`)
  const diagnostics = []
  const client = startBridge({
    command: process.execPath,
    args: [file],
    cwd: HERE,
    env: process.env,
    onStderr: (line) => diagnostics.push(line),
  })
  const ready = await client.request('initialize', {}, 5_000)
  assert.equal(ready.protocolVersion, PROTOCOLS[0])
  assert.ok(diagnostics.some((line) => line.includes('diagnostic')), 'the stray line was not reported')
  await client.stop(1_000)
})
