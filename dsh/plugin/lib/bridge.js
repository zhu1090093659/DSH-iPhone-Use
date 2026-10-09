/**
 * A minimal MCP stdio client for the iPhone Use device bridge.
 *
 * The bridge is a standard Model Context Protocol server over stdin/stdout:
 * it answers `initialize`, `tools/list`, `tools/call`, `ping` and the two
 * resource methods. Speaking that protocol directly keeps this plugin free of
 * any dependency beyond Node itself, so the same package loads in a profile
 * that supplies no MCP client of its own.
 *
 * One request is in flight at a time per method stream; tool calls are
 * serialized by the bridge anyway (it owns a single phone session), so this
 * client queues calls rather than racing them.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** Protocol revisions the bridge accepts, newest first. */
export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** A JSON-RPC error reported by the bridge. */
export class BridgeError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.data = data
  }
}

/** A transport-level failure (spawn, crash, malformed frame, timeout). */
export class BridgeTransportError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'BridgeTransportError'
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Spawn the bridge and expose request/notify over its stdio.
 *
 * @param options - executable, arguments, working directory and environment.
 * @returns the connected client.
 */
export function startBridge(options) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new BridgeClient(child, options)
}

class BridgeClient {
  constructor(child, options) {
    this.child = child
    this.options = options
    this.nextId = 1
    /** id -> {resolve, reject, timer} */
    this.pending = new Map()
    this.closed = false
    /** A terminal failure every later request must report instead of hanging. */
    this.failure = undefined
    let settled = false
    const settleExit = (result) => {
      if (settled) return
      settled = true
      this.closed = true
      resolveExit(result)
    }
    let resolveExit
    this.exit = new Promise((resolve) => { resolveExit = resolve })
    child.once('exit', (code, signal) => {
      this.failAll(new BridgeTransportError(`the phone bridge exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`))
      settleExit({ code, signal })
    })
    child.once('error', (error) => {
      // A spawn failure (a missing interpreter, a permission problem) is
      // terminal: remember it so a request made after the event is rejected
      // with the same explanation instead of waiting for a timeout, and settle
      // the exit promise because no `exit` event follows a failed spawn.
      this.failure = new BridgeTransportError('the phone bridge could not be started: ' + error.message, error)
      this.failAll(this.failure)
      settleExit({ code: null, signal: null })
    })
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => this.receive(line))
    // The bridge writes diagnostics to stderr; keep them for the host log
    // without ever parsing them as protocol frames.
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity })
    stderr.on('line', (line) => this.options.onStderr?.(line))
  }

  receive(line) {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      // A non-protocol line is a bridge diagnostic that reached stdout; the
      // bridge never does this, so record it instead of desynchronizing.
      this.options.onStderr?.(text)
      return
    }
    if (message === null || typeof message !== 'object' || message.id === undefined) return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (message.error !== undefined) {
      const error = message.error
      entry.reject(new BridgeError(error?.code ?? -32603, String(error?.message ?? 'bridge error'), error?.data))
    } else {
      entry.resolve(message.result)
    }
  }

  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener('abort', entry.onAbort)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /**
   * Send one request and await its result.
   *
   * @param method - the MCP method name.
   * @param params - the method parameters.
   * @param timeoutMs - per-request bound; the bridge's own budgets are lower.
   * @param signal - caller cancellation. Aborting settles this promise only;
   *   the bridge finishes the accepted operation on its own, because a phone
   *   action cannot be un-sent. Disposal is what stops the child.
   * @returns the JSON-RPC result.
   */
  request(method, params, timeoutMs, signal) {
    // Report the original cause when there is one: "not running" alone does not
    // tell a user whether the interpreter is missing or the child crashed.
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new BridgeTransportError('the phone bridge is not running'))
    if (signal?.aborted === true) {
      return Promise.reject(new BridgeTransportError(`${method} was cancelled before it was sent`))
    }
    const id = this.nextId++
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeTransportError(`the phone bridge did not answer ${method} within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new BridgeTransportError(`${method} was cancelled; the phone may still finish the accepted operation`))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, timer, onAbort, signal })
      const settle = (error) => {
        this.pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
      try {
        this.child.stdin.write(frame + '\n', (error) => {
          if (error === undefined || error === null) return
          settle(new BridgeTransportError(`sending ${method} to the phone bridge failed: ${error.message}`, error))
        })
      } catch (error) {
        // A write on an already-destroyed stream throws instead of calling back.
        settle(new BridgeTransportError(`sending ${method} to the phone bridge failed: ${error.message}`, error))
      }
    })
  }

  /** Stop the bridge, ending the input stream so its tool worker drains first. */
  async stop(graceMs) {
    if (this.closed) {
      await this.exit
      return
    }
    this.child.stdin.end()
    const timer = setTimeout(() => {
      // The bridge did not drain in time; a stuck child must not hold the host.
      this.child.kill('SIGKILL')
    }, graceMs)
    timer.unref?.()
    try {
      await this.exit
    } finally {
      clearTimeout(timer)
    }
  }
}
