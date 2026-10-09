#!/usr/bin/env node
/**
 * Reproducible end-to-end verification of the DSH plugin, with no real LLM,
 * no API key, no iPhone and no network beyond loopback.
 *
 * It proves, in one isolated DSH home, that:
 *   1. the built tarball installs through the supported `dsh plugin` CLI;
 *   2. the profile composes and the plugin module loads (`--dump-config-schema`);
 *   3. a real DSH session discovers all 17 model-visible `pua_*` tools;
 *   4. the session calls one and receives the device bridge's own answer;
 *   5. uninstall removes the row and the dependency;
 *   6. the user's real DSH home is never written.
 *
 * Usage:
 *   node dsh/scripts/verify-e2e.mjs [--keep]
 *
 * Requirements: `dsh` and `node` on PATH, and Python 3 for the bridge. The
 * script fetches @deepseek-ai/dsh-llm-mock-server with `npm pack`; when that
 * fails it reports SKIP for the session step and still checks the rest.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const KEEP = process.argv.includes('--keep')
const WORK = mkdtempSync(join(tmpdir(), 'dsh-iphone-use-e2e-'))
const HOME = join(WORK, 'home')
const PROFILE = 'iue2e'
const PORT = 18996
mkdirSync(HOME, { recursive: true })

const results = []
function record(step, ok, detail) {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`)
}

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME, IPHONE_USE_ANALYTICS: '0', ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  return result ?? ''
}

async function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = execFile(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, DSH_HOME: HOME, IPHONE_USE_ANALYTICS: '0', ...options.env },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => resolvePromise({ error, stdout, stderr }))
    void child
  })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function main() {
  // 6 (baseline): the user's own DSH home must stay untouched.
  const realHome = join(process.env.HOME ?? '', '.dsh')
  const realBefore = existsSync(realHome) ? statSync(realHome).mtimeMs : null

  console.log('== 1. build and install ==')
  run('node', [join(HERE, 'build.mjs')])
  const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh', 'plugin', 'package.json'), 'utf8'))
  const tarball = join(ROOT, 'dsh', 'dist', `${manifest.name}-${manifest.version}.tgz`)
  record('build produces a tarball', existsSync(tarball), tarball)

  run('dsh', ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'])
  run('dsh', ['plugin', '--profile', PROFILE, 'add', tarball])
  const profileManifest = JSON.parse(readFileSync(join(HOME, 'profiles', PROFILE, 'package.json'), 'utf8'))
  const bundles = profileManifest.dsh?.profile?.bundles ?? []
  record('install composes the bundle', bundles.includes('dsh-iphone-use'), bundles.join(', '))
  record('install records the dependency', Object.keys(profileManifest.dependencies ?? {}).includes('dsh-iphone-use'))

  console.log('== 2. compose and load without a device ==')
  const composed = run('dsh', ['--profile', PROFILE, '--dump-config'], { capture: true })
  record('--dump-config shows the row', /iphone-use/.test(composed))
  const schema = await runAsync('dsh', ['--profile', PROFILE, '--dump-config-schema'])
  record('the plugin module imports (dump-config-schema exits 0)', schema.error === null, schema.stderr.trim().slice(0, 200))

  console.log('== 3-4. a real session discovers and calls pua_* ==')
  let mock
  try {
    mock = await startMock()
  } catch (error) {
    record('model-free session', false, 'SKIP: could not fetch the mock LLM server — ' + error.message)
    mock = undefined
  }
  if (mock !== undefined) {
    writeFileSync(join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), MOCK_PATCH.replace('__PORT__', String(PORT)))
    const session = await runAsync('dsh', ['--profile', PROFILE, 'headless', '--json', 'call pua_metrics'], {
      env: { IU_MOCK_KEY: 'iu-mock-key' },
    })
    record('the session completes', session.error === null, session.error ? String(session.error.message) : '')
    const events = session.stdout.trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
    const call = events.find((event) => event.type === 'tool_call')
    const result = events.find((event) => event.type === 'tool_result')
    record('the model called a pua_* tool', call?.tool === 'pua_metrics', call?.tool)
    record('the bridge answered the call', result?.status === 'completed', result?.status)
    record('the answer is the bridge\'s own value', typeof result?.result === 'string' && result.result.includes('latency_scope'))
    const advertised = mock.advertised()
    record('all 17 model-visible pua tools reach the model', advertised.length === 17, advertised.join(','))

    // The installed copy must resolve its own assets. The fake checkout proves
    // it: a plugin that reached back into the development tree would still
    // work there, so moving that tree away must leave the installed plugin
    // untouched.
    const installed = join(HOME, 'profiles', PROFILE, 'node_modules', 'dsh-iphone-use')
    const hidden = join(WORK, 'checkout-moved-away')
    const packageManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    record('the profile installs the package itself', packageManifest.name === 'dsh-iphone-use', installed)
    for (const asset of ['server/iphone_use.py', 'skills/iphone-use/SKILL.md', 'skills/iphone-use-setup/SKILL.md', 'tools.generated.json', 'client.js']) {
      record(`the installed package ships ${asset}`, existsSync(join(installed, asset)))
    }
    renameSync(ROOT, hidden)
    try {
      // With the checkout gone the plugin can only work from its own copy.
      // The working directory must be outside the moved checkout: with cwd
      // pointing at a path that no longer exists the child cannot even start,
      // which would test the harness rather than the plugin's self-resolution.
      const isolated = await runAsync('dsh', ['--profile', PROFILE, 'headless', '--json', 'call pua_metrics'], {
        env: { IU_MOCK_KEY: 'iu-mock-key' },
        cwd: WORK,
      })
      const isolatedEvents = isolated.stdout.trim().split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
      const isolatedResult = isolatedEvents.find((event) => event.type === 'tool_result')
      record(
        'the installed plugin works with the checkout absent',
        isolatedResult?.status === 'completed',
        isolatedResult?.status ?? isolated.stderr.trim().slice(0, 200),
      )
    } finally {
      renameSync(hidden, ROOT)
    }

    // Goal 1: the DSH path must not need Codex at all. Run one more session
    // with Codex hidden from PATH and its config home pointed at nothing, so a
    // hidden fallback would fail loudly instead of passing unnoticed.
    const shim = join(WORK, 'no-codex-bin')
    mkdirSync(shim, { recursive: true })
    for (const tool of ['node', 'python3', 'sh', 'bash', 'env', 'git', 'xcrun', 'tar']) {
      const resolved = execFileSync('sh', ['-c', 'command -v ' + tool], { encoding: 'utf8' }).trim()
      if (resolved === '') continue
      const link = join(shim, tool)
      if (existsSync(link)) continue
      symlinkSync(resolved, link)
    }
    const cleanPath = [shim, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
    const codexVisible = execFileSync('sh', ['-c', 'command -v codex || true'], {
      encoding: 'utf8', env: { PATH: cleanPath },
    }).trim()
    record('codex is absent from the session PATH', codexVisible === '', codexVisible)
    // The shimmed PATH hides Codex but also hides `dsh`; call it absolutely.
    const dshBinary = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
    const noCodex = await runAsync(dshBinary, ['--profile', PROFILE, 'headless', '--json', 'call pua_doctor'], {
      env: {
        PATH: cleanPath,
        IU_MOCK_KEY: 'iu-mock-key',
        IPHONE_USE_ANALYTICS: '0',
        CODEX_HOME: join(WORK, 'no-such-codex-home'),
      },
      cwd: WORK,
    })
    const noCodexEvents = noCodex.stdout.trim().split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
    const noCodexResult = noCodexEvents.find((event) => event.type === 'tool_result')
    // The scripted call is pua_metrics, so the marker is a field only the real
    // bridge produces; a stub or a Codex-mediated path would not have it.
    const noCodexPayload = String(noCodexResult?.result ?? '')
    record(
      'a session runs with no Codex installed or configured',
      noCodexResult?.status === 'completed' && noCodexPayload.includes('latency_scope'),
      noCodexResult?.status ?? noCodex.stderr.trim().slice(0, 200),
    )

    // Stop the mock only after every session has run against it.
    await mock.stop()
  }

  console.log('== 5. uninstall cleans up ==')
  run('dsh', ['plugin', '--profile', PROFILE, 'remove', 'dsh-iphone-use'])
  const after = JSON.parse(readFileSync(join(HOME, 'profiles', PROFILE, 'package.json'), 'utf8'))
  record('the bundle row is gone', !(after.dsh?.profile?.bundles ?? []).includes('dsh-iphone-use'))
  record('the dependency is gone', !Object.keys(after.dependencies ?? {}).includes('dsh-iphone-use'))

  const realAfter = existsSync(realHome) ? statSync(realHome).mtimeMs : null
  record("the user's real DSH home was untouched", realBefore === realAfter)

  const failed = results.filter((row) => !row.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

/** The profile patch that points the default model at the loopback mock. */
const MOCK_PATCH = `- id: llm-pi-ai
  config:
    providers:
      mock-openai:
        displayName: Mock OpenAI
        api: openai-completions
        baseURL: http://127.0.0.1:__PORT__/v1
        apiKeyEnv: IU_MOCK_KEY
        models:
          - id: mock-model
            name: Mock Model
            contextWindow: 200000
            maxTokens: 8192
- id: agent-default-model
  config:
    provider: mock-openai
    model: mock-model
- id: session-title-llm
  disabled: true
`

/** Fetch the official mock LLM package and start it with a scripted sequence. */
async function startMock() {
  const vendor = join(WORK, 'mock')
  mkdirSync(vendor, { recursive: true })
  const packed = execFileSync('npm', ['pack', '@deepseek-ai/dsh-llm-mock-server', '--pack-destination', vendor], {
    encoding: 'utf8', stdio: 'pipe',
  }).trim().split('\n').pop()
  execFileSync('tar', ['xzf', join(vendor, packed), '-C', vendor])
  const entry = join(vendor, 'package', 'lib', 'index.js')
  if (!existsSync(entry)) throw new Error('the mock package shipped no library entry')
  const mod = await import(entry)
  const server = await mod.startMockLlmServer({
    host: '127.0.0.1',
    port: PORT,
    apiKey: 'iu-mock-key',
    // Two sessions run against this server, so script enough steps for both;
    // each session consumes one tool call and one final answer.
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success', 'tool_call_success', 'success'],
    toolName: 'pua_metrics',
    toolArguments: JSON.stringify({}),
    successText: 'E2E-FINAL',
  })
  const advertised = () => {
    const names = new Set()
    for (const request of server.requests ?? []) {
      let body = request.body
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch { continue }
      }
      for (const tool of body?.tools ?? []) {
        const name = tool?.function?.name ?? tool?.name
        if (typeof name === 'string' && name.startsWith('pua_')) names.add(name)
      }
    }
    return [...names].sort()
  }
  await sleep(200)
  return {
    advertised,
    stop: async () => { await server.close() },
  }
}

main()
  .catch((error) => {
    console.error('verification failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    if (KEEP) console.log('kept:', WORK)
    else rmSync(WORK, { recursive: true, force: true })
  })
