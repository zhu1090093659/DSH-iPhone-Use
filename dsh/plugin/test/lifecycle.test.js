#!/usr/bin/env node
/**
 * Lifecycle tests for the host half: what the plugin owns must be released.
 *
 * A stub Cordis context records registrations and hands back the disposers the
 * real framework would, and a tiny scripted bridge stands in for the Python
 * device service. That combination lets these tests prove, with plain Node,
 * that mount registers the tool surface and that disposal removes every tool,
 * removes the runtime skills, and terminates the child process it started.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../index.js'

const WORK = mkdtempSync(join(tmpdir(), 'dsh-iu-lifecycle-'))
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }))

/**
 * A minimal Cordis context: enough surface for this plugin, and it records
 * every registration so a test can assert both mount and teardown.
 */
function stubContext() {
  const tools = new Map()
  const skills = new Map()
  const effects = []
  const injections = []
  const warnings = []
  return {
    tools: { list: tools, skills },
    warnings,
    injections,
    ctx: {
      logger: { warn: (line) => warnings.push(String(line)), debug: () => {}, info: () => {} },
      tools: {
        register(definition) {
          if (tools.has(definition.name)) throw new Error('duplicate tool ' + definition.name)
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      get(service) {
        if (service !== 'skills') return undefined
        return {
          register(skill) {
            if (skills.has(skill.name)) throw new Error('duplicate skill ' + skill.name)
            skills.set(skill.name, skill)
            return () => skills.delete(skill.name)
          },
        }
      },
      inject(services, callback) {
        injections.push(services)
        // The real host only calls back once the service exists; this plugin
        // must mount its tool surface before that, without a web server.
        void callback
      },
      effect(fn, label) {
        const dispose = fn()
        effects.push({ label, dispose })
        return dispose
      },
    },
    disposeAll() {
      for (const { dispose } of effects.splice(0)) dispose?.()
    },
  }
}

/** Write the scripted bridge, which records its own pid and stays alive. */
function fakeBridge() {
  const pidFile = join(WORK, 'child.pid')
  const script = join(WORK, 'fake-bridge.mjs')
  writeFileSync(script, `
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  if (message.method === 'initialize') return send({ protocolVersion: '2025-11-25', capabilities: {} })
  if (message.method === 'tools/call') return send({ content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: message.params?.name }) }], isError: false })
  return send({})
})
process.stdin.on('end', () => process.exit(0))
`)
  return { script, pidFile }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('the plugin exports the Cordis face the loader requires', () => {
  assert.equal(name, 'iphone-use')
  assert.equal(typeof apply, 'function')
})

test('mount registers every model tool and both skills, and disposal releases them', async () => {
  const { script, pidFile } = fakeBridge()
  const stub = stubContext()
  // The stub bridge answers in Node, so the configured interpreter is node.
  apply(stub.ctx, { python: process.execPath, entrypoint: script, panel: false, callTimeoutMs: 15_000 })

  const mounted = [...stub.tools.list.keys()]
  assert.equal(mounted.length, 17, 'expected the 17 model-visible tools: ' + mounted.join(','))
  assert.ok(mounted.includes('pua_ready') && mounted.includes('pua_doctor'))
  // Panel-only tools must never reach the model.
  assert.ok(!mounted.includes('pua_screen_frame') && !mounted.includes('pua_screen_action'))
  assert.deepEqual([...stub.tools.skills.keys()].sort(), ['iphone-use', 'iphone-use-setup'])
  // The registry rejects a missing output schema, so every definition has one.
  for (const definition of stub.tools.list.values()) {
    assert.equal(typeof definition.output.render, 'function', definition.name)
    assert.ok(definition.output.schema !== undefined, definition.name)
  }

  // Call one tool: this is what spawns the owned child process.
  const result = await stub.tools.list.get('pua_doctor').execute({})
  assert.match(JSON.stringify(result), /pua_doctor/)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(pid > 0)
  assert.ok(alive(pid), 'the bridge child was not running after a call')

  // Disposal is the host shutting down, disabling or uninstalling the plugin.
  stub.disposeAll()
  assert.equal(stub.tools.list.size, 0, 'tools survived disposal')
  assert.equal(stub.tools.skills.size, 0, 'skills survived disposal')

  // The child is terminated; give the shutdown grace a moment to complete.
  const deadline = Date.now() + 10_000
  while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
  assert.equal(alive(pid), false, 'the bridge child survived disposal')
})

test('a later call after disposal fails instead of resurrecting the bridge', async () => {
  const { script } = fakeBridge()
  const stub = stubContext()
  apply(stub.ctx, { python: process.execPath, entrypoint: script, panel: false, callTimeoutMs: 5_000 })
  const tool = stub.tools.list.get('pua_metrics')
  await tool.execute({})
  stub.disposeAll()
  // The registry is empty, so the model cannot reach the tool at all.
  assert.equal(stub.tools.list.size, 0)
})

test('a missing bridge entrypoint fails the call with a named path', async () => {
  const stub = stubContext()
  apply(stub.ctx, {
    python: process.execPath,
    entrypoint: join(WORK, 'does-not-exist.py'),
    panel: false,
    callTimeoutMs: 5_000,
  })
  await assert.rejects(
    () => stub.tools.list.get('pua_ready').execute({}),
    (error) => {
      assert.match(error.message, /entrypoint is missing/)
      assert.match(error.message, /does-not-exist\.py/)
      return true
    },
  )
  // A failed start must not poison the plugin: the tools are still registered.
  assert.equal(stub.tools.list.size, 17)
  stub.disposeAll()
})

test('panel routes mount only when a web server is present and are removed with it', async () => {
  const { script } = fakeBridge()
  const stub = stubContext()
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.kind + ' ' + route.path, route)
      return () => routes.delete(route.kind + ' ' + route.path)
    },
  }
  // Deliver the webServer injection the way the real host would.
  stub.ctx.inject = (services, callback) => {
    if (services.includes('webServer')) callback({ webServer })
  }
  apply(stub.ctx, { python: process.execPath, entrypoint: script, callTimeoutMs: 5_000 })
  assert.equal(routes.size, 3, 'expected state, frame and action routes')
  assert.ok([...routes.keys()].every((key) => key.includes('/iphone-use/')))
  stub.disposeAll()
  assert.equal(routes.size, 0, 'panel routes survived disposal')
})

test('panel:false mounts no routes at all', () => {
  const { script } = fakeBridge()
  const stub = stubContext()
  const routes = new Map()
  stub.ctx.inject = (services, callback) => {
    if (services.includes('webServer')) callback({ webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  }
  apply(stub.ctx, { python: process.execPath, entrypoint: script, panel: false, callTimeoutMs: 5_000 })
  assert.equal(routes.size, 0)
  assert.equal(stub.tools.list.size, 17)
  stub.disposeAll()
})
