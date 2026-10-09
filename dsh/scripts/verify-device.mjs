#!/usr/bin/env node
/**
 * Real-device closed loop, driven from a DSH session.
 *
 * This is the goal-4 acceptance: a DSH session, not a shell wrapper, must
 * reach a physically connected iPhone, read its screen/state, perform a safe
 * action, and return a checkable result. It refuses to run without a real
 * device so it can never be mistaken for a mock passing as hardware.
 *
 * Usage:
 *   node dsh/scripts/verify-device.mjs [--bundle <id>]
 *
 * Requires: a USB iPhone that is trusted, unlocked and in Developer Mode, and
 * a WDA service already READY (see dsh/docs/install.md, section 3).
 * Nothing here changes user data: the default action only opens Settings.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const WORK = mkdtempSync(join(tmpdir(), 'dsh-iu-device-'))
const HOME = join(WORK, 'home')
const PROFILE = 'iudevice'
const bundleArg = process.argv.indexOf('--bundle')
const BUNDLE = bundleArg === -1 ? 'com.apple.Preferences' : process.argv[bundleArg + 1]
mkdirSync(HOME, { recursive: true })

const results = []
const record = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + step + (detail === undefined ? '' : ' - ' + detail))
}

/** Run the bridge directly; this is the device prerequisite probe. */
function bridge(action, payload) {
  const output = execFileSync('python3', ['scripts/phone.py', action, JSON.stringify(payload)], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, IPHONE_USE_ANALYTICS: '0' },
  })
  return JSON.parse(output)
}

/** One DSH session whose scripted model calls exactly one phone tool. */
async function sessionStep(port, tool, args) {
  const profileDir = join(HOME, 'profiles', PROFILE)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), TEMPLATE.replace('__PORT__', String(port)))
  const mockPath = join(WORK, 'mock-' + port + '.mjs')
  writeFileSync(mockPath, "import { startMockLlmServer } from '" + MOCK + "'\n" +
    'const s = await startMockLlmServer({ host: "127.0.0.1", port: ' + port + ', apiKey: "iu-mock-key", ' +
    "sequence: ['tool_call_success','success'], toolName: " + JSON.stringify(tool) + ', toolArguments: ' +
    JSON.stringify(JSON.stringify(args)) + ", successText: 'STEP-DONE' })\n" +
    'await new Promise(() => {})\n' +
    "process.on('SIGTERM', async () => { await s.close(); process.exit(0) })\n")
  const mock = (await import('node:child_process')).spawn(process.execPath, [mockPath], { stdio: 'ignore' })
  try {
    await new Promise((done) => setTimeout(done, 2000))
    const stdout = execFileSync('dsh', ['--profile', PROFILE, 'headless', '--json', 'run it'], {
      cwd: WORK, encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, DSH_HOME: HOME, IU_MOCK_KEY: 'iu-mock-key', IPHONE_USE_ANALYTICS: '0' },
    })
    const events = stdout.trim().split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return undefined } })
      .filter(Boolean)
    return {
      call: events.find((event) => event.type === 'tool_call'),
      result: events.find((event) => event.type === 'tool_result'),
    }
  } finally {
    mock.kill('SIGTERM')
  }
}

/**
 * Fetch the official mock LLM server into this run's own work directory.
 *
 * The scripted model is only a front end that decides which phone tool to
 * call; the device work itself is always real. Packing it per run keeps this
 * script free of machine-specific paths.
 *
 * @returns the absolute path of the package's library entry.
 */
/**
 * Read one tool result back into an object.
 *
 * A result the host considers too large to keep inline arrives truncated,
 * so a failed parse is reported as a partial value rather than thrown: the
 * caller asserts on the fields it cares about and the failure stays visible
 * instead of being mistaken for a successful read.
 *
 * @param entry - the parsed tool_result event.
 * @returns the bridge payload, or a marker describing why it has none.
 */
function parseResult(entry) {
  const text = entry?.result
  if (typeof text !== 'string') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { __unparsable: true, __bytes: text.length, __tail: text.slice(-120) }
  }
}

function prepareMock() {
  const vendor = join(WORK, 'mock')
  mkdirSync(vendor, { recursive: true })
  const packed = execFileSync('npm', ['pack', '@deepseek-ai/dsh-llm-mock-server', '--pack-destination', vendor], {
    encoding: 'utf8', stdio: 'pipe',
  }).trim().split('\n').pop()
  execFileSync('tar', ['xzf', join(vendor, packed), '-C', vendor], { stdio: 'ignore' })
  const entry = join(vendor, 'package', 'lib', 'index.js')
  if (!existsSync(entry)) throw new Error('the mock package shipped no library entry')
  return entry
}

/** Set once the mock package is fetched; used by every scripted session. */
let MOCK = ''
const TEMPLATE = `- id: llm-pi-ai
  config:
    providers:
      m:
        displayName: M
        api: openai-completions
        baseURL: http://127.0.0.1:__PORT__/v1
        apiKeyEnv: IU_MOCK_KEY
        models: [{ id: mock-model, name: M, contextWindow: 200000, maxTokens: 8192 }]
- id: agent-default-model
  config: { provider: m, model: mock-model }
- id: session-title-llm
  disabled: true
`

async function main() {
  // 1. There must be a physical device. A simulated one must never pass here.
  const listed = execFileSync('xcrun', ['devicectl', 'list', 'devices'], { encoding: 'utf8' })
  const physical = listed.split('\n').filter((line) => /physical/.test(line))
  record('a physical iPhone is connected', physical.length > 0, physical[0]?.trim() ?? 'none')
  if (physical.length === 0) throw new Error('no physical device: refusing to run, a simulator is not a real-device acceptance')

  // 2. The device bridge must already be READY.
  const ready = bridge('pua_ready', { recover: false, screenshot: false })
  record('the phone is READY', ready.ready === true, JSON.stringify(ready.proof ?? ready.error ?? {}))

  // 3. Install the built plugin into an isolated DSH home.
  execFileSync('node', [join(HERE, 'build.mjs')], { cwd: ROOT, stdio: 'ignore' })
  const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh', 'plugin', 'package.json'), 'utf8'))
  const tarball = join(ROOT, 'dsh', 'dist', manifest.name + '-' + manifest.version + '.tgz')
  const env = { ...process.env, DSH_HOME: HOME }
  execFileSync('dsh', ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], { cwd: ROOT, env, stdio: 'ignore' })
  execFileSync('dsh', ['plugin', '--profile', PROFILE, 'add', tarball], { cwd: ROOT, env, stdio: 'ignore' })
  record('the plugin installs into an isolated DSH home', existsSync(join(HOME, 'profiles', PROFILE, 'node_modules', 'dsh-iphone-use')))

  // 4. Read the real screen and state from a DSH session.
  MOCK = prepareMock()
  const observe = await sessionStep(19031, 'pua_observe', { mode: 'screenshot' })
  const observed = parseResult(observe.result)
  record('a DSH session read the screen/state', observe.result?.status === 'completed' && observed.app !== undefined,
    'app=' + observed.app + ' viewport=' + JSON.stringify(observed.viewport ?? null))
  const shot = observed.image?.path
  record('the observation carried a real screenshot on disk', typeof shot === 'string' && existsSync(shot), shot ?? 'none')

  // 5. Perform one safe action from a DSH session.
  const action = await sessionStep(19032, 'pua_launch_app', { bundle_id: BUNDLE })
  const acted = parseResult(action.result)
  record('a DSH session performed a safe action', action.result?.status === 'completed' && acted.action_executed === true,
    JSON.stringify(acted))

  // 6. Verify the result independently, outside the session.
  const after = bridge('pua_observe', { mode: 'screenshot' })
  record('the action is verifiable in the device state', (after.app ?? after.apps) === BUNDLE,
    'foreground=' + (after.app ?? after.apps) + ' expected=' + BUNDLE)

  const failed = results.filter((row) => !row.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
  if (failed.length > 0) process.exitCode = 1
}

main()
  .catch((error) => { console.error('device verification failed:', error.message); process.exitCode = 1 })
  .finally(() => rmSync(WORK, { recursive: true, force: true }))
