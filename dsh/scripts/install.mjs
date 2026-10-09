#!/usr/bin/env node
/**
 * Install the DSH plugin into one DSH profile.
 *
 * It uses only the supported plugin mechanism: `dsh plugin --profile <name> add`,
 * which appends this package to that profile's `dsh.profile.bundles` list and
 * installs its dependency. The profile and DSH home are never edited by hand,
 * and no DSH source file is touched.
 *
 * Usage:
 *   node dsh/scripts/install.mjs --profile <name> [--dsh-home <path>] [--from <spec>]
 *
 * `--from` accepts anything `dsh plugin add` accepts: a tarball, a directory, or
 * an npm spec. It defaults to the tarball this repository builds.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

function parseArgs(argv) {
  const options = { profile: '', dshHome: '', from: '', help: false }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--profile') options.profile = argv[++index] ?? ''
    else if (token === '--dsh-home') options.dshHome = argv[++index] ?? ''
    else if (token === '--from') options.from = argv[++index] ?? ''
    else if (token === '--help' || token === '-h') options.help = true
    else throw new Error('unknown option: ' + token)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('node dsh/scripts/install.mjs --profile <name> [--dsh-home <path>] [--from <spec>]\n')
    return
  }
  if (options.profile === '') throw new Error('--profile is required (for example: desktop)')
  if (options.profile === 'desktop') {
    throw new Error(
      'the desktop profile is owned by the Electron app, which refuses external plugin writes. ' +
        'Install into a CLI-managed profile with --profile <name> and start it with `dsh --profile <name>`, ' +
        'or add the plugin from the DSH desktop app plugin page.',
    )
  }

  let spec = options.from
  if (spec === '') {
    execFileSync('node', [join(HERE, 'build.mjs')], { stdio: 'inherit', cwd: ROOT })
    spec = defaultTarball()
  }
  if (!existsSync(spec)) throw new Error('no install source at: ' + spec)

  const env = { ...process.env }
  if (options.dshHome !== '') env.DSH_HOME = options.dshHome
  execFileSync('dsh', ['plugin', '--profile', options.profile, 'add', spec], { stdio: 'inherit', env, cwd: ROOT })

  process.stdout.write(
    '\nInstalled into profile "' + options.profile + '".\n' +
      'Restart that DSH profile (or reload it) to mount the plugin, then ask the session to run pua_ready.\n',
  )
}

function defaultTarball() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh', 'plugin', 'package.json'), 'utf8'))
  return join(ROOT, 'dsh', 'dist', manifest.name + '-' + manifest.version + '.tgz')
}

main()
