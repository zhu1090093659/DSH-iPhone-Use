#!/usr/bin/env node
/**
 * Package the DSH plugin into one installable tarball.
 *
 * The output is a plain npm tarball: DSH installs it with the supported
 * `dsh plugin --profile <name> add <tarball>`, which appends this package to
 * the profile's bundle list. Nothing here reads or writes a DSH checkout, and
 * no absolute path of the build machine is embedded: the plugin resolves its
 * own files from `import.meta.url` at run time.
 *
 * Usage:
 *   node dsh/scripts/build.mjs            # write dsh/dist/dsh-iphone-use-<version>.tgz
 *   node dsh/scripts/build.mjs --stage    # also leave the unpacked tree in dsh/dist/dsh-iphone-use/
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PLUGIN = join(ROOT, 'dsh', 'plugin')
const DIST = join(ROOT, 'dsh', 'dist')

/** Paths the installed package must contain, relative to the repository root. */
const INCLUDE = [
  ['dsh/plugin/index.js', 'index.js'],
  ['dsh/plugin/client.js', 'client.js'],
  ['dsh/plugin/icon.svg', 'icon.svg'],
  ['dsh/plugin/cordis.patch.yml', 'cordis.patch.yml'],
  ['dsh/plugin/tools.generated.json', 'tools.generated.json'],
]

/** Directory trees copied into the package, preserving their layout. */
const INCLUDE_DIRS = [
  ['dsh/plugin/lib', 'lib'],
  ['server', 'server'],
  ['tooling', 'tooling'],
  ['assets', 'assets'],
  ['skills', 'skills'],
]

/** Files copied verbatim from the repository root. */
const INCLUDE_ROOT_FILES = [
  ['LICENSE', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['dsh/docs/install.md', 'README.md'],
]

/** Never shipped: local state, caches and build residue. */
const EXCLUDE = new Set(['__pycache__', 'node_modules', '.pytest_cache', '.DS_Store', 'iphone-use-demo.png', 'phone-screen.html'])

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => !EXCLUDE.has(source.split('/').pop()),
  })
}

function main() {
  const stage = process.argv.includes('--stage')
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))

  // The generated tool table must match the bridge, or the shipped package
  // would register a contract the bridge does not implement.
  execFileSync('python3', [join(HERE, 'emit_tools.py'), '--check'], { stdio: 'inherit' })

  const packageRoot = join(DIST, manifest.name)
  rmSync(packageRoot, { recursive: true, force: true })
  mkdirSync(packageRoot, { recursive: true })

  for (const [from, to] of INCLUDE) {
    const source = join(ROOT, from)
    if (!existsSync(source)) throw new Error('missing package input: ' + from)
    cpSync(source, join(packageRoot, to))
  }
  for (const [from, to] of INCLUDE_DIRS) {
    const source = join(ROOT, from)
    if (!existsSync(source)) throw new Error('missing package input: ' + from)
    copyTree(source, join(packageRoot, to))
  }
  for (const [from, to] of INCLUDE_ROOT_FILES) {
    const source = join(ROOT, from)
    if (!existsSync(source)) throw new Error('missing package input: ' + from)
    cpSync(source, join(packageRoot, to))
  }
  cpSync(join(PLUGIN, 'package.json'), join(packageRoot, 'package.json'))

  // An installed npm tarball keeps the files listed in `files`; make the
  // package.json that ships match exactly what is on disk.
  assertSelfContained(packageRoot, manifest)

  const tarball = runNpmPack(packageRoot, join(DIST, manifest.name + '-' + manifest.version + '.tgz'))
  if (!stage) rmSync(packageRoot, { recursive: true, force: true })
  process.stdout.write(tarball + '\n')
}

/** Fail loudly when the staged tree references anything outside itself. */
function assertSelfContained(packageRoot, manifest) {
  const entry = readFileSync(join(packageRoot, 'index.js'), 'utf8')
  const home = process.env.HOME
  if (home !== undefined && entry.includes(home)) {
    throw new Error('the packaged index.js embeds the build machine home directory')
  }
  if (!existsSync(join(packageRoot, 'server', 'iphone_use.py'))) {
    throw new Error('the packaged tree is missing its bridge entrypoint')
  }
  if (!existsSync(join(packageRoot, 'tools.generated.json'))) {
    throw new Error('the packaged tree is missing tools.generated.json')
  }
  for (const clientPath of ['client.js']) {
    const source = readFileSync(join(packageRoot, clientPath), 'utf8')
    if (source.includes(home ?? '\u0000')) throw new Error(clientPath + ' embeds the build machine home directory')
  }
  void manifest
}

/** Run `npm pack` into the dist directory and return the tarball path. */
function runNpmPack(packageRoot, target) {
  rmSync(target, { force: true })
  const output = execFileSync('npm', ['pack', '--pack-destination', DIST], {
    cwd: packageRoot,
    encoding: 'utf8',
  }).trim().split('\n').pop()
  const produced = join(DIST, output)
  if (produced !== target) {
    cpSync(produced, target)
    rmSync(produced, { force: true })
  }
  return target
}

main()
