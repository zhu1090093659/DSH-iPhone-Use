#!/usr/bin/env node
/**
 * Verify the right-Sidebar iPhone tab in a real browser.
 *
 * Registers nothing on its own: it boots an isolated DSH web profile with the
 * built plugin, then drives headless Chrome over the DevTools Protocol to open
 * the column the way a user does and assert that the tab renders a live frame
 * from the device. A tab that is registered but never reachable, or that mounts
 * but blanks, fails here.
 *
 * Usage:
 *   node dsh/scripts/verify-panel.mjs [--port 18161] [--debug-port 9359]
 *
 * Requirements: Chrome, the plugin built, and a phone bridge that can serve a
 * frame (see verify-device.mjs). The device is optional: without one the frame
 * assertions report what they saw instead of faking a picture.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const WORK = mkdtempSync(join(tmpdir(), 'dsh-iu-panel-'))
const HOME = join(WORK, 'home')
const PROFILE = 'iupanel'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : Number(process.argv[index + 1])
}
const PORT = argOf('--port', 0)
const DEBUG = argOf('--debug-port', 9359)
/** The plugin's tab kind; the guide entry and the tab body are keyed by it. */
const KIND = 'iphone-use'

const results = []
const record = (step, ok, detail) => {
  results.push({ step, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + step + (detail === undefined ? '' : ' - ' + detail))
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function main() {
  if (!existsSync(CHROME)) throw new Error('Chrome not found at ' + CHROME)
  mkdirSync(HOME, { recursive: true })

  // 1. A web profile carrying the plugin.
  const env = { ...process.env, DSH_HOME: HOME }
  const run = (command, args) => spawnSync(command, args, { cwd: ROOT, env })
  await run('node', [join(HERE, 'build.mjs')])
  await run('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh', 'plugin', 'package.json'), 'utf8'))
  await run('dsh', ['plugin', '--profile', PROFILE, 'add', join(ROOT, 'dsh', 'dist', manifest.name + '-' + manifest.version + '.tgz')])
  const port = PORT === 0 ? await freePort() : PORT
  writeFileSync(join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'),
    '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ' + port + '\n')
  record(
    'the plugin installs into an isolated web profile',
    existsSync(join(HOME, 'profiles', PROFILE, 'node_modules', manifest.name)),
  )

  // 2. Boot the host and take its tokenized URL.
  // The host may send the banner to either stream, and it can arrive in chunks
  // that split the URL, so accumulate both and scan the whole log.
  const host = spawn('dsh', ['--profile', PROFILE, '--no-open'], { cwd: ROOT, env })
  let log = ''
  host.stdout.setEncoding('utf8')
  host.stderr.setEncoding('utf8')
  const onData = (chunk) => { log += chunk }
  host.stdout.on('data', onData)
  host.stderr.on('data', onData)
  const findUrl = () => {
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(log)
    return match === null ? '' : match[0]
  }
  let url = ''
  for (let i = 0; i < 90 && url === ''; i++) { await sleep(1000); url = findUrl() }
  record('the host boots and prints a tokenized URL', url !== '', url === '' ? log.trim().split('\n').slice(-3).join(' / ') : undefined)
  if (url === '') throw new Error('no URL from the host')

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--user-data-dir=' + join(WORK, 'chrome'), '--window-size=1600,1000',
    '--remote-debugging-port=' + String(DEBUG), 'about:blank',
  ], { stdio: 'ignore' })

  const client = await attach(DEBUG)
  try {
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await client.send('Page.navigate', { url })
    await sleep(9000)
    for (const label of ['稍后配置', '继续', 'Later', 'Skip']) {
      for (let i = 0; i < 5; i++) if ((await client.click(label)) === 'notfound') break
      await sleep(1500)
    }
    await client.send('Runtime.enable')

    // 3. Open the column.
    record('the shell offers the right column', (await client.click('打开右侧边栏')) === 'clicked')
    await sleep(4000)

    // 4. The guide must list this plugin's type, keyed by its kind.
    const guide = await client.evalJson(
      "Array.from(document.querySelectorAll('[data-sidebar-right-guide-entry]')).map(function (e) { return e.getAttribute('data-sidebar-right-guide-entry') })")
    record('the column guide lists the iphone-use entry', Array.isArray(guide) && guide.includes(KIND), (guide || []).join(','))

    // 5. Open it and assert the panel body and a live frame.
    const opened = await client.eval(
      "(function () { var e = document.querySelector('[data-sidebar-right-guide-entry=\"" + KIND + "\"]'); if (!e) return 'no entry'; e.click(); return 'clicked' })()")
    record('the guide entry opens the tab', opened === 'clicked')
    await sleep(12000)

    const frame = await client.evalJson(
      "(function () { var i = document.querySelector('img[alt=\"手机屏幕\"], img[alt=\"iPhone screen\"]');" +
      " return { found: !!i, jpeg: i ? (i.getAttribute('src') || '').indexOf('data:image/') === 0 : false," +
      " width: i ? i.naturalWidth : 0, height: i ? i.naturalHeight : 0 } })()")
    record('the panel body renders an image element', frame.found === true)
    record('the image carries a real frame', frame.jpeg === true && frame.width > 0, frame.width + 'x' + frame.height)

    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ROOT, 'dsh', 'dist', 'panel-verify.png'), Buffer.from(shot.result.data, 'base64'))
    console.log('screenshot: dsh/dist/panel-verify.png')
  } finally {
    client.close()
    chrome.kill('SIGKILL')
    host.kill('SIGTERM')
    await sleep(1000)
    host.kill('SIGKILL')
  }

  const failed = results.filter((row) => !row.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
  if (failed.length > 0) process.exitCode = 1
}

/** Minimal CDP client over the page target. */
async function attach(port) {
  let page
  for (let i = 0; i < 80 && page === undefined; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
      page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    } catch {}
    if (page === undefined) await sleep(500)
  }
  if (page === undefined) throw new Error('no Chrome page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const waiting = new Map()
  let seq = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
  })
  await new Promise((done, fail) => { ws.addEventListener('open', done); ws.addEventListener('error', fail) })
  const send = (method, params = {}) => {
    const id = ++seq
    return new Promise((done) => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params })) })
  }
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) return 'EXC ' + String(res.result.exceptionDetails.exception?.description || '').slice(0, 160)
    return res.result?.result?.value
  }
  return {
    send,
    eval: evaluate,
    evalJson: async (expression) => {
      const value = await evaluate(expression)
      return typeof value === 'string' ? JSON.parse(value) : value
    },
    click: (label) => evaluate(
      '(function () { var h = Array.from(document.querySelectorAll("button,[role=button],[role=tab],[role=menuitem]"))' +
      '.find(function (x) { var t = (x.textContent || "").trim(); var a = (x.getAttribute("aria-label") || x.title || "").trim();' +
      ' return t === ' + JSON.stringify(label) + ' || a === ' + JSON.stringify(label) + ' });' +
      ' if (!h) return "notfound"; h.click(); return "clicked" })()'),
    close: () => ws.close(),
  }
}

/** Ask the operating system for a free loopback port. */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const picked = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => done(picked))
    })
  })
}

/** Run one short-lived command to completion. */
function spawnSync(command, args, options) {
  return new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: 'ignore' })
    child.on('exit', done)
    child.on('error', done)
  })
}

main()
  .catch((error) => { console.error('panel verification failed:', error.message); process.exitCode = 1 })
  .finally(() => rmSync(WORK, { recursive: true, force: true }))
