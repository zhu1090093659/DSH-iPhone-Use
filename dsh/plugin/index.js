/**
 * iPhone Use for DeepSeek Harness - host half.
 *
 * The plugin owns the whole iPhone Use runtime inside the DSH host:
 *
 * - it starts the dependency-free Python device bridge as one owned child
 *   process, speaks MCP over its stdio, and registers every `pua_*` tool on
 *   `ctx.tools` so the model calls them exactly as it did before;
 * - it serves the panel's own loopback routes (`/iphone-use/*`) from the same
 *   bridge, so the right-Sidebar tab and the model read one set of facts;
 * - it drops both the child process and every registration when the plugin is
 *   disposed (disable, uninstall, or host shutdown).
 *
 * Nothing here re-implements the device layer: WebDriverAgent, USB forwarding,
 * setup and control all stay in the Python bridge, which is the same code the
 * Codex plugin used. This file only replaces the Codex host with the DSH host.
 *
 * @module dsh-iphone-use
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeError, BridgeTransportError, PROTOCOLS, startBridge } from './lib/bridge.js'

/** Stable Cordis plugin name (also the loader row id in cordis.patch.yml). */
export const name = 'iphone-use'

/** The host services this plugin registers into. */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The directory holding this plugin's own assets.
 *
 * In the source tree this file is `dsh/plugin/index.js`, so its package root is
 * the directory above it. An installed npm package flattens that layout: the
 * entry sits at the package root and its assets beside it. Walking up to the
 * nearest `package.json` that names this plugin resolves both without any
 * build-machine path.
 */
function findPackageRoot(start) {
  let directory = start
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) {
      try {
        if (JSON.parse(readFileSync(candidate, 'utf8')).name === 'dsh-iphone-use') return directory
      } catch {
        /* an unreadable manifest is not this plugin's root */
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return resolve(start, '..')
}

const PACKAGE_ROOT = findPackageRoot(HERE)

/**
 * Locate one shipped asset directory.
 *
 * The installed package embeds its own copies, so `PACKAGE_ROOT/<name>` is the
 * normal answer. Running this file straight from the repository is also
 * supported for development: there the assets live beside the package, one
 * directory above `dsh/plugin`. The first existing candidate wins, and the
 * packaged layout is always tried first so a shipped tarball never reaches
 * outside itself.
 *
 * @param name - the asset directory name, such as `skills` or `server`.
 * @returns the absolute directory to read, or `undefined` when neither exists.
 */
function findAssetDirectory(...names) {
  const inside = join(PACKAGE_ROOT, ...names)
  if (existsSync(inside)) return inside
  // The development fallback is gated on a positive source-tree marker: the
  // repository root holds this very package at `dsh/plugin`. An installed
  // package never satisfies that, so a shipped tarball can never read assets
  // from outside itself even if one of its own directories is missing.
  const repositoryRoot = resolve(PACKAGE_ROOT, '..', '..')
  if (resolve(repositoryRoot, 'dsh', 'plugin') !== PACKAGE_ROOT) return undefined
  const beside = join(repositoryRoot, ...names)
  return existsSync(beside) ? beside : undefined
}

/** Versioned asset names and the panel's route prefix. */
export const ROUTES = {
  state: '/iphone-use/state',
  frame: '/iphone-use/frame',
  action: '/iphone-use/action',
}

/** The skill bundles this package ships, by directory name. */
const SKILL_FILES = ['iphone-use', 'iphone-use-setup']

/** Largest accepted panel action body. */
const MAX_BODY_BYTES = 64 * 1024

/** Resolved defaults; the profile patch overrides any of them. */
export const DEFAULTS = {
  /**
   * The Python interpreter running the bridge. Empty resolves `python3` on
   * PATH, which is what a stock macOS with the Xcode command-line tools has.
   */
  python: '',
  /**
   * Absolute path to the bridge entrypoint. Empty uses the copy shipped beside
   * this plugin, so an installed package is self-contained.
   */
  entrypoint: '',
  /** Extra environment for the bridge process (state directory, WDA URL, ...). */
  env: {},
  /** Bound for one `tools/call`, in milliseconds. */
  callTimeoutMs: 300_000,
  /** Bound for one setup or panel request, in milliseconds. */
  requestTimeoutMs: 30_000,
  /** How long the bridge may take to drain after stdin closes. */
  shutdownGraceMs: 10_000,
  /** Non-loopback authorities this deployment serves (the panel's HTTP fence). */
  trustedHosts: [],
  /** Serve the panel's routes. The tools work either way. */
  panel: true,
}

/** Merge one patch config over the defaults. */
export function resolveConfig(raw) {
  const given = raw ?? {}
  const entrypoint = typeof given.entrypoint === 'string' && given.entrypoint.trim() !== ''
    ? resolve(given.entrypoint)
    : join(findAssetDirectory('server') ?? join(PACKAGE_ROOT, 'server'), 'iphone_use.py')
  return {
    ...DEFAULTS,
    ...given,
    python: typeof given.python === 'string' ? given.python : DEFAULTS.python,
    entrypoint,
    env: { ...DEFAULTS.env, ...(given.env ?? {}) },
    trustedHosts: Array.isArray(given.trustedHosts) ? given.trustedHosts : DEFAULTS.trustedHosts,
  }
}

/** Read the generated tool table: one entry per tool, already in DSH's schema subset. */
export async function loadToolTable(root = PACKAGE_ROOT) {
  const file = join(root, 'tools.generated.json')
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) {
    throw new Error('dsh-iphone-use: tools.generated.json is not a tool table')
  }
  return parsed
}

/**
 * Mount the host half.
 *
 * @param ctx - the host plugin context.
 * @param rawConfig - the loader row's config block.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  ctx.effect(() => mountBridge(ctx, config), 'dsh-iphone-use: bridge and tools')
}

/**
 * Own one bridge process, its tool registrations and its panel routes.
 *
 * @returns a disposer that unregisters everything and stops the child.
 */
function mountBridge(ctx, config) {
  let disposed = false
  let bridge
  let bridgeStart
  let disposeSkills = () => {}

  /** Start the bridge once; concurrent callers share the attempt. */
  const ensureBridge = () => {
    if (bridge !== undefined) return bridge
    if (disposed) throw new BridgeTransportError('the iPhone Use plugin is being disposed')
    if (bridgeStart === undefined) {
      bridgeStart = startOnce(config, ctx).catch((error) => {
        // A failed start must not poison every later call: the next one retries.
        bridgeStart = undefined
        throw error
      })
    }
    return bridgeStart
  }

  const callBridge = async (method, params, timeoutMs) => {
    const client = await ensureBridge()
    return client.request(method, params, timeoutMs)
  }

  const disposers = []

  // The panel watches this flag so `pua_screen` opens the live tab in the
  // session that asked for it, the way the pre-migration panel did.
  const panelRequest = { requestedAt: 0 }

  // Register the tool surface immediately from the generated table, so the
  // model sees the tools before any device or child process exists. This is
  // also what makes `--dump-config-schema` prove the plugin without a device.
  const table = loadToolTableSync()
  for (const tool of table.tools) {
    if (tool.appOnly === true) continue
    disposers.push(ctx.tools.register(defineBridgeTool(tool, callBridge, config, panelRequest)))
  }

  // Register this package's two skills as runtime skills. The same SKILL.md
  // files the repository ships become visible in every DSH session, so the
  // workflow guidance travels with the plugin instead of the checkout.
  disposeSkills = registerSkills(ctx, disposers)

  if (config.panel !== false) {
    ctx.inject(['webServer'], (injected) => {
      disposers.push(registerPanelRoutes(injected.webServer, config, callBridge, panelRequest))
    })
  }

  return () => {
    disposed = true
    disposeSkills()
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.(String(error))
      }
    }
    const started = bridgeStart
    bridgeStart = undefined
    if (started !== undefined) {
      // Disposal must not wait on a device call that is still running: stop the
      // process and let its own worker drain the accepted operation.
      started
        .then((client) => client.stop(config.shutdownGraceMs))
        .catch(() => {})
    }
  }
}

/** Read the generated tool table synchronously; it is small and read once. */
function loadToolTableSync() {
  const file = join(PACKAGE_ROOT, 'tools.generated.json')
  if (!existsSync(file)) {
    throw new Error('dsh-iphone-use: tools.generated.json is missing from the installed package')
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed.tools)) throw new Error('dsh-iphone-use: tools.generated.json is not a tool table')
  return parsed
}

/** Start the bridge and complete the MCP handshake. */
async function startOnce(config, ctx) {
  if (!existsSync(config.entrypoint)) {
    throw new BridgeTransportError(`the phone bridge entrypoint is missing: ${config.entrypoint}`)
  }
  const command = config.python !== '' ? config.python : 'python3'
  const client = startBridge({
    command,
    args: [config.entrypoint],
    cwd: dirname(config.entrypoint),
    env: { ...process.env, ...config.env },
    onStderr: (line) => ctx.logger?.debug?.(line),
  })
  try {
    await client.request('initialize', {
      protocolVersion: PROTOCOLS[0],
      capabilities: {},
      clientInfo: { name: 'dsh-iphone-use', version: '1.0.0' },
    }, config.requestTimeoutMs)
  } catch (error) {
    await client.stop(2_000)
    if (error instanceof BridgeTransportError) {
      throw new BridgeTransportError(
        'the iPhone Use phone bridge did not start. Check that python3 is on PATH and that ' +
          config.entrypoint + ' exists. Cause: ' + error.message,
        error,
      )
    }
    throw error
  }
  return client
}

/**
 * Publish this package's two skills into the session skill catalog.
 *
 * The skill bodies are the repository's own `SKILL.md` files, copied into the
 * package, so a user gets the same iPhone workflow guidance without cloning
 * anything. Registration is effect-scoped: disposing the plugin removes them.
 *
 * @param ctx - the host plugin context.
 * @param disposers - the mount's disposer list, appended to.
 * @returns a disposer that removes any skill that was actually registered.
 */
function registerSkills(ctx, disposers) {
  const skills = ctx.get('skills')
  if (skills === undefined) return () => {}
  const root = findAssetDirectory('skills')
  if (root === undefined) {
    ctx.logger?.warn?.('dsh-iphone-use: the bundled skills directory was not found; skill guidance is unavailable')
    return () => {}
  }
  const owned = []
  for (const entry of SKILL_FILES) {
    const file = join(root, entry, 'SKILL.md')
    if (!existsSync(file)) continue
    const parsed = parseSkillFile(readFileSync(file, 'utf8'))
    if (parsed === undefined) continue
    try {
      owned.push(skills.register({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: join(root, entry) },
      }))
    } catch (error) {
      ctx.logger?.warn?.(`dsh-iphone-use: skill "${entry}" was not registered: ${String(error)}`)
    }
  }
  return () => {
    for (const dispose of owned.splice(0)) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.(String(error))
      }
    }
  }
}

/** Split a `SKILL.md` into its frontmatter name/description and its body. */
function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return undefined
  const header = match[1]
  const name = /^name:\s*(.+)$/m.exec(header)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(header)?.[1]?.trim()
  if (name === undefined || description === undefined) return undefined
  return { name, description, content: text.slice(match[0].length) }
}

/**
 * Build one model-facing DSH tool from a generated table entry.
 *
 * The tool's canonical value is the bridge's own result object, so the value
 * schema stays open on purpose: the bridge owns the result contract and any
 * narrowing here would reject a valid bridge answer.
 */
function defineBridgeTool(tool, callBridge, config, panelRequest) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: {},
      render: (_args, value) => renderToolResult(value),
    },
    isConcurrencySafe: () => tool.readOnly === true,
    async execute(args, exec) {
      const params = { name: tool.name, arguments: args ?? {} }
      const result = await callBridge('tools/call', params, config.callTimeoutMs)
      // `pua_screen` opens or closes the live panel: record the request so the
      // panel in the calling session reveals itself. Opening the panel is a
      // presentation concern, so a failure here must never fail the tool call.
      if (tool.name === 'pua_screen' && panelRequest !== undefined) {
        const action = args?.action ?? 'open'
        if (action === 'pause') panelRequest.requestedAt = 0
        else panelRequest.requestedAt = Date.now()
      }
      void exec
      return unwrapToolResult(result)
    },
  }
}

/**
 * Turn one MCP `tools/call` result into the bridge's canonical value.
 *
 * The bridge reports a device-level failure as a result with `isError` and a
 * JSON `error` object, and it may attach an image alongside the text. DSH
 * image blocks need the attachment store, which this plugin does not own, so
 * the image stays on disk and the text names its path: the model reads it with
 * the shipped `read_image` tool, and the panel reads the same file directly.
 *
 * @param result - the raw `tools/call` result.
 * @returns the canonical value handed to `render`.
 */
export function unwrapToolResult(result) {
  if (result === null || typeof result !== 'object') {
    throw new BridgeTransportError('the phone bridge returned a malformed tool result')
  }
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  let value
  try {
    value = text === '' ? {} : JSON.parse(text)
  } catch {
    value = { message: text }
  }
  const image = content.find((block) => block !== null && typeof block === 'object' && block.type === 'image')
  const saved = value !== null && typeof value === 'object' ? findImagePath(value) : undefined
  if (image !== undefined || saved !== undefined) {
    value = { ...value, image_saved_to: saved }
  }
  if (result.isError === true) {
    // The bridge reports failures as `{ error: { code, message, uncertain } }`,
    // so the model-facing message is the nested one; a flat shape is also read
    // in case a future bridge returns the error object directly.
    const detail = value !== null && typeof value === 'object' && value.error !== null && typeof value.error === 'object'
      ? value.error
      : value
    const message = detail !== null && typeof detail === 'object' && typeof detail.message === 'string'
      ? detail.message
      : 'the phone operation failed'
    const error = new Error(message)
    error.name = 'IPhoneUseError'
    if (detail !== null && typeof detail === 'object' && detail.code !== undefined) error.code = detail.code
    error.details = value
    throw error
  }
  return value
}

/** Find the on-disk PNG a bridge result already carries, when it carries one. */
function findImagePath(value) {
  const direct = value.image ?? value.observation?.image
  if (direct !== null && typeof direct === 'object' && typeof direct.path === 'string') return direct.path
  const failing = value.error?.observation?.image
  if (failing !== null && typeof failing === 'object' && typeof failing.path === 'string') return failing.path
  const results = value.results
  if (Array.isArray(results) && results.length > 0) {
    const last = results[results.length - 1]
    const nested = last?.image ?? last?.observation?.image
    if (nested !== null && typeof nested === 'object' && typeof nested.path === 'string') return nested.path
  }
  return undefined
}

/** Render the canonical value as one compact JSON text block plus the image path. */
export function renderToolResult(value) {
  const text = JSON.stringify(value, null, 2)
  const blocks = [{ type: 'text', text }]
  return blocks
}

/** Convert one bridge failure into a model-facing error with the bridge's own wording. */
function toToolError(error, toolName) {
  if (error instanceof BridgeError) {
    const wrapper = new Error(String(error.message))
    wrapper.name = 'IPhoneUseError'
    wrapper.code = error.code
    if (error.data !== undefined) wrapper.details = error.data
    return wrapper
  }
  if (error instanceof BridgeTransportError) {
    const wrapper = new Error(error.message)
    wrapper.name = 'IPhoneUseError'
    wrapper.code = 'bridge_unavailable'
    return wrapper
  }
  const wrapper = new Error(`${toolName} failed: ${error?.message ?? String(error)}`)
  wrapper.name = 'IPhoneUseError'
  return wrapper
}

/**
 * Serve the panel's own loopback JSON routes over the same bridge.
 *
 * The fence matches the shipped `/api` browser trust model: the Host authority
 * must be loopback (or explicitly trusted) and the request must not be a
 * cross-site browser request. It is a DNS-rebinding and cross-site defense,
 * not authentication.
 */
function registerPanelRoutes(webServer, config, callBridge, panelRequest) {
  const guard = (handler) => async (req, res) => {
    try {
      if (!isTrustedRequest(req, config.trustedHosts)) {
        send(res, 403, { error: 'forbidden', message: 'This route serves loopback requests from the DSH page only.' })
        return
      }
      await handler(req, res)
    } catch (error) {
      send(res, 500, { error: 'internal_error', message: String(error?.message ?? error) })
    }
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: ROUTES.state,
      handler: guard(async (_req, res) => {
        send(res, 200, {
          ok: true,
          routes: ROUTES,
          // Newer than the stamp the panel last acted on means "the model
          // asked to see the screen"; the panel reveals itself once.
          panel_requested_at: panelRequest?.requestedAt ?? 0,
        })
      }),
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTES.frame,
      handler: guard(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const afterSeq = Number(url.searchParams.get('after_seq') ?? '0')
        const lastEventId = Number(url.searchParams.get('last_event_id') ?? '0')
        const result = await callBridge('tools/call', {
          name: 'pua_screen_frame',
          arguments: {
            after_seq: Number.isFinite(afterSeq) ? afterSeq : 0,
            last_event_id: Number.isFinite(lastEventId) ? lastEventId : 0,
          },
        }, config.requestTimeoutMs)
        send(res, 200, unwrapPanel(result))
      }),
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTES.action,
      handler: guard(async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          send(res, 405, { error: 'method_not_allowed', message: 'Send panel actions with POST.' })
          return
        }
        const body = await readBody(req)
        let payload
        try {
          payload = JSON.parse(body === '' ? '{}' : body)
        } catch {
          send(res, 400, { error: 'invalid_argument', message: 'The panel action body is not JSON.' })
          return
        }
        const action = payload?.action
        if (action !== 'refresh' && action !== 'home' && action !== 'screenshot') {
          send(res, 400, { error: 'invalid_argument', message: 'The panel action must be refresh, home or screenshot.' })
          return
        }
        const result = await callBridge('tools/call', {
          name: 'pua_screen_action',
          arguments: { action },
        }, config.requestTimeoutMs)
        send(res, 200, unwrapPanel(result))
      }),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Unwrap one panel tool result.
 *
 * Panel tools answer with `structuredContent` (frames never become model
 * text). Older bridges answer with one JSON text block; both shapes are read
 * so the panel and the bridge can be upgraded independently.
 *
 * @param result - the raw `tools/call` result.
 * @returns the panel payload.
 */
export function unwrapPanel(result) {
  if (result !== null && typeof result === 'object' && result.structuredContent !== undefined) {
    return result.structuredContent
  }
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: 'invalid_response', message: text }
  }
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('The panel action body is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res, status, value) {
  const body = JSON.stringify(value ?? {})
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Whether a normalized URL hostname names the local loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** The browser-trust fence shared with the DSH `/api` surface. */
export function isTrustedRequest(req, trustedHosts = []) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined) return false
  if (!isLoopbackHostname(parsed.hostname) && !trustedHosts.includes(host)) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}
