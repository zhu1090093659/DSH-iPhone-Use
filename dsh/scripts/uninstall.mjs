#!/usr/bin/env node
/**
 * Remove the DSH plugin from one DSH profile.
 *
 * `dsh plugin --profile <name> remove` deselects the bundle, unloads its layer
 * and uninstalls the dependency, so the plugin's tools, panel routes and bridge
 * child process are all released.
 *
 * Usage:
 *   node dsh/scripts/uninstall.mjs --profile <name> [--dsh-home <path>]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

function main() {
  const argv = process.argv.slice(2)
  let profile = ''
  let dshHome = ''
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--profile') profile = argv[++index] ?? ''
    else if (argv[index] === '--dsh-home') dshHome = argv[++index] ?? ''
    else if (argv[index] === '--help' || argv[index] === '-h') {
      process.stdout.write('node dsh/scripts/uninstall.mjs --profile <name> [--dsh-home <path>]\n')
      return
    } else throw new Error('unknown option: ' + argv[index])
  }
  if (profile === '') throw new Error('--profile is required')
  if (profile === 'desktop') {
    throw new Error('the desktop profile is owned by the Electron app; remove the plugin from the app plugin page instead.')
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh', 'plugin', 'package.json'), 'utf8'))
  const env = { ...process.env }
  if (dshHome !== '') env.DSH_HOME = dshHome
  execFileSync('dsh', ['plugin', '--profile', profile, 'remove', manifest.name], { stdio: 'inherit', env, cwd: ROOT })
  process.stdout.write('\nRemoved from profile "' + profile + '". Restart or reload it to release the tools and panel.\n')
}

main()
