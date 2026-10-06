'use strict'

const assert = require('node:assert/strict')
const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, beforeEach, afterEach } = require('node:test')

const plugin = require('..')
const { InstallerUpdates, refForBranch, parseResult } = plugin

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

let tmp, remote, work, installDir, scriptDir, dataDir, logFile, xo, commands, unitActive, clock

function commit(message) {
  fs.writeFileSync(path.join(work, 'file'), message)
  git(work, 'add', '.')
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message)
  git(work, 'push', '-q', 'origin', 'HEAD:master')
  return git(work, 'rev-parse', 'HEAD')
}

function writeConfig(lines) {
  fs.writeFileSync(path.join(scriptDir, 'xo-install.cfg'), lines.join('\n') + '\n')
}

// build directory like xo-install.sh creates it, optionally made active
function addBuild(name, { active = false } = {}) {
  const build = path.join(installDir, 'xo-builds', name)
  execFileSync('git', ['clone', '-q', remote, build], { stdio: 'ignore' })
  fs.mkdirSync(path.join(build, 'packages', 'xo-server'), { recursive: true })
  if (active) {
    fs.rmSync(path.join(installDir, 'xo-server'), { force: true })
    fs.symlinkSync(path.join(build, 'packages', 'xo-server'), path.join(installDir, 'xo-server'))
  }
  return build
}

// fake xo-install.sh prints its arguments and exits with given code
function writeInstaller(exitCode = 0) {
  fs.writeFileSync(
    path.join(scriptDir, 'xo-install.sh'),
    `#!/bin/bash\necho "xo-install.sh $*"\necho -e "\\e[1;31m[fail]\\e[0m something"\nexit ${exitCode}\n`,
    { mode: 0o755 }
  )
}

// fake xo-server: http handlers, authentication, email and web UI locations
function fakeXo(guiRoutes) {
  return {
    config: guiRoutes && { getGuiRoutes: async () => guiRoutes },
    handlers: {},
    emails: [],
    async registerHttpRequestHandler(p, fn) {
      assert.equal(this.handlers[p], undefined, `${p} registered twice`)
      this.handlers[p] = fn
      return () => delete this.handlers[p]
    },
    async authenticateUser({ token }) {
      if (token === 'admin-token') return { user: { permission: 'admin' } }
      if (token === 'user-token') return { user: { permission: 'none' } }
      throw new Error('invalid credentials')
    },
    async sendEmail(email) {
      this.emails.push(email)
    },
  }
}

// emulates xo-server's dispatch of registered http handlers
async function request(url, { method = 'GET', token, origin, host = 'xo.local' } = {}) {
  const headers = { host }
  // xo-server's sign in stores the session in the token cookie
  if (token) headers.cookie = `foo=bar; token=${token}`
  if (origin) headers.origin = origin
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      this.body = body
    },
    nextCalled: false,
  }
  const p = url.split('?')[0]
  const result = await xo.handlers[p]({ method, headers, url, path: p }, res, undefined, () => {
    res.nextCalled = true
  })
  if (result != null) res.end(result)
  return res
}

const admin = { token: 'admin-token' }
const post = { ...admin, method: 'POST', origin: 'https://xo.local' }

function newInstance(options = {}) {
  const realRun = (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())))
    })
  // systemd is replaced: the unit command runs synchronously, everything else (bash, git) runs for real
  const runCommand = async (cmd, args) => {
    commands.push([cmd, ...args])
    if (cmd === 'systemctl') {
      if (!unitActive) throw new Error('inactive')
      return ''
    }
    if (cmd === 'systemd-run') {
      const i = args.indexOf('/bin/bash')
      return realRun(args[i], args.slice(i + 1))
    }
    return realRun(cmd, args)
  }
  return new InstallerUpdates({
    xo,
    installer: { scriptDir, installDir },
    getDataDir: async () => dataDir,
    runCommand,
    logFile,
    now: () => clock,
    ...options,
  })
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-updates-'))
  remote = path.join(tmp, 'xen-orchestra.git')
  work = path.join(tmp, 'work')
  installDir = path.join(tmp, 'opt-xo')
  scriptDir = path.join(tmp, 'installer')
  dataDir = path.join(tmp, 'data')
  logFile = path.join(tmp, 'update.log')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote], { stdio: 'ignore' })
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' })
  commit('first')
  addBuild('xen-orchestra-202601011200', { active: true })
  fs.mkdirSync(scriptDir)
  fs.mkdirSync(dataDir)
  writeConfig([`REPOSITORY="${remote}"`, 'BRANCH="master"'])
  writeInstaller()

  xo = fakeXo()
  commands = []
  unitActive = false
  clock = new Date(2026, 9, 4, 12, 0)
  plugin.instance = newInstance()
})

afterEach(() => {
  plugin.instance.unload()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('refForBranch follows xo-install.sh BRANCH formats', () => {
  assert.equal(refForBranch('master'), 'refs/heads/master')
  assert.equal(refForBranch('tags/xo-server-v5.100.0'), 'refs/tags/xo-server-v5.100.0')
  assert.equal(refForBranch('1a2b3c4d5e'), undefined)
})

test('parseResult reads exit code appended to the log', () => {
  assert.equal(parseResult('still running'), undefined)
  assert.deepEqual(parseResult('a\n[fail] x\nxo-installer-update exit code 0\n'), { success: true, code: 0, failures: 1 })
  assert.deepEqual(parseResult('xo-installer-update exit code 1\n'), { success: false, code: 1, failures: 0 })
})

test('reports up to date, then update available after a new commit', async () => {
  const p = plugin.instance
  let status = await p.check()
  assert.equal(status.state, 'up-to-date', status.error)
  assert.equal(status.installed, status.latest)

  const latest = commit('second')
  status = await p.check()
  assert.equal(status.state, 'update-available')
  assert.equal(status.latest, latest)
  assert.equal(status.branch, 'master')
})

test('emails once per new commit, also across restarts', async () => {
  const p = plugin.instance
  p.configure({ emailTo: ['admin@example.com'] })
  commit('second')
  await p.check()
  await p.check()
  assert.equal(xo.emails.length, 1)
  assert.match(xo.emails[0].subject, /update available on master/)

  // new instance after xo-server restart remembers what was notified
  const restarted = newInstance()
  restarted.configure({ emailTo: ['admin@example.com'] })
  restarted._state = await restarted._readState()
  await restarted.check()
  assert.equal(xo.emails.length, 1)

  commit('third')
  await restarted.check()
  assert.equal(xo.emails.length, 2)
})

test('no email without recipients or transport plugin', async () => {
  const p = plugin.instance
  commit('second')
  await p.check()
  delete xo.sendEmail
  p.configure({ emailTo: ['admin@example.com'] })
  commit('third')
  await p.check()
  assert.equal(xo.emails.length, 0)
})

test('handles pinned commit and annotated tags', async () => {
  const p = plugin.instance
  const installed = git(work, 'rev-parse', 'HEAD')
  writeConfig([`REPOSITORY="${remote}"`, `BRANCH="${installed.slice(0, 12)}"`])
  assert.equal((await p.check()).state, 'pinned')

  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v1', '-m', 'v1')
  git(work, 'push', '-q', 'origin', 'v1')
  writeConfig([`REPOSITORY="${remote}"`, 'BRANCH="tags/v1"'])
  const status = await p.check()
  assert.equal(status.state, 'up-to-date', status.error)
  assert.equal(status.latest, installed)
})

test('missing branch and unknown installer location are reported as errors', async () => {
  writeConfig([`REPOSITORY="${remote}"`, 'BRANCH="nope"'])
  const status = await plugin.instance.check()
  assert.equal(status.state, 'error')
  assert.match(status.error, /nope not found/)
  await assert.rejects(plugin.instance.test(), /nope not found/)

  const unknown = new InstallerUpdates({ xo: fakeXo(), installer: {} })
  assert.equal((await unknown.check()).state, 'error')

  // older xo-install.sh wrote the directory it was started from, e.g. "."
  const relative = new InstallerUpdates({ xo: fakeXo(), installer: { scriptDir: '.', installDir } })
  assert.equal((await relative.check()).state, 'error')
  await assert.rejects(relative.apply(), /installer location unknown/)
})

test('lists builds newest first with the active one marked', async () => {
  commit('second')
  addBuild('xen-orchestra-202601021200')
  fs.mkdirSync(path.join(installDir, 'xo-builds', 'not-a-build'))
  const builds = await plugin.instance.builds()
  assert.deepEqual(
    builds.map(b => [b.name, b.active, b.subject]),
    [
      ['xen-orchestra-202601021200', false, 'second'],
      ['xen-orchestra-202601011200', true, 'first'],
    ]
  )
  assert.equal(builds[1].date, new Date(2026, 0, 1, 12, 0).toISOString())
})

test('status page and endpoints require an admin session', async () => {
  await plugin.instance.load()
  for (const p of ['/installer-updates/status', '/installer-updates/app.js']) {
    assert.equal((await request(p)).statusCode, 403)
    assert.equal((await request(p, { token: 'user-token' })).statusCode, 403)
    assert.equal((await request(p, { token: 'bad' })).statusCode, 403)
  }
  // page sends to sign in instead
  for (const token of [undefined, 'user-token', 'bad']) {
    const res = await request('/installer-updates', { token })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/signin')
  }
  const page = await request('/installer-updates', admin)
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /<title>Xen Orchestra updates<\/title>/)
  // xo-server's Content-Security-Policy blocks inline scripts and styles
  assert.doesNotMatch(page.body, /<script>|<style>|\son\w+=/)

  const js = await request('/installer-updates/app.js', admin)
  assert.match(js.headers['content-type'], /javascript/)
  assert.doesNotThrow(() => new Function(js.body))
  const css = await request('/installer-updates/app.css', admin)
  assert.match(css.headers['content-type'], /text\/css/)
})

test('state changing endpoints need POST from the same origin', async () => {
  await plugin.instance.load()
  for (const p of ['/installer-updates/check', '/installer-updates/apply', '/installer-updates/switch']) {
    assert.equal((await request(p, admin)).statusCode, 400)
    assert.equal((await request(p, { ...admin, method: 'POST' })).statusCode, 400)
    assert.equal((await request(p, { ...admin, method: 'POST', origin: 'https://evil.example' })).statusCode, 400)
    assert.equal((await request(p, { ...post, token: 'user-token' })).statusCode, 403)
  }
  assert.equal(commands.filter(c => c[0] === 'systemd-run').length, 0)

  commit('second')
  const res = await request('/installer-updates/check', post)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).state, 'update-available')
})

test('update runs xo-install.sh --update in a transient unit and records the result', async () => {
  const p = plugin.instance
  p.configure({ emailTo: ['admin@example.com'] })
  await p.load()
  let res = await request('/installer-updates/apply', post)
  assert.equal(res.statusCode, 200, res.body)

  const run = commands.find(c => c[0] === 'systemd-run')
  assert.ok(run.includes('--unit=xo-installer-update'))
  assert.equal(fs.readFileSync(logFile, 'utf8').split('\n')[0], 'xo-install.sh --update')

  const status = JSON.parse((await request('/installer-updates/status', admin)).body)
  assert.equal(status.operation.type, 'update')
  assert.equal(status.operation.success, true)
  assert.equal(status.operation.failures, 1)
  assert.match(status.log, /^xo-install\.sh --update\n\[fail\] something/)
  assert.doesNotMatch(status.log, /exit code/)
  assert.equal(xo.emails.at(-1).subject, '[Xen Orchestra] update succeeded')

  // result is recorded once
  await request('/installer-updates/status', admin)
  assert.equal(xo.emails.length, 1)

  // failing update
  writeInstaller(1)
  res = await request('/installer-updates/apply', post)
  assert.equal(res.statusCode, 200, res.body)
  const failed = JSON.parse((await request('/installer-updates/status', admin)).body)
  assert.equal(failed.operation.success, false)
  assert.equal(failed.operation.code, 1)
  assert.equal(xo.emails.at(-1).subject, '[Xen Orchestra] update failed')
})

test('only one operation runs at a time', async () => {
  await plugin.instance.load()
  unitActive = true
  const res = await request('/installer-updates/apply', post)
  assert.equal(res.statusCode, 409)
  assert.match(JSON.parse(res.body).error, /already running/)
  const status = JSON.parse((await request('/installer-updates/status', admin)).body)
  assert.equal(status.running, true)
})

test('switch runs xo-install.sh --rollback-to for an installed inactive build only', async () => {
  commit('second')
  addBuild('xen-orchestra-202601021200')
  await plugin.instance.load()

  for (const [build, error] of [
    ['../../etc', /invalid build/],
    ['xen-orchestra-209901011200', /not found/],
    ['xen-orchestra-202601011200', /already active/],
  ]) {
    const res = await request(`/installer-updates/switch?build=${encodeURIComponent(build)}`, post)
    assert.equal(res.statusCode, 409)
    assert.match(JSON.parse(res.body).error, error)
  }
  assert.equal(commands.filter(c => c[0] === 'systemd-run').length, 0)

  const res = await request('/installer-updates/switch?build=xen-orchestra-202601021200', post)
  assert.equal(res.statusCode, 200, res.body)
  assert.match(fs.readFileSync(logFile, 'utf8'), /^xo-install\.sh --rollback-to xen-orchestra-202601021200\n/)
  const status = JSON.parse((await request('/installer-updates/status', admin)).body)
  assert.equal(status.operation.type, 'rollback')
  assert.equal(status.operation.target, 'xen-orchestra-202601021200')
})

test('interrupted operation without exit code is reported as failed', async () => {
  const p = plugin.instance
  await p._saveState({ operation: { type: 'update', startedAt: clock.toISOString() } })
  fs.writeFileSync(logFile, 'partial output\n')
  await p._reconcile()
  assert.equal(p._state.operation.success, false)
  assert.equal(p._state.operation.interrupted, true)
})

test('automatic update runs once a day at the configured hour when an update exists', async () => {
  const p = plugin.instance
  const updates = () => commands.filter(c => c[0] === 'systemd-run').length

  p.configure({ autoUpdate: true, autoUpdateHour: 3 })
  commit('second')
  clock = new Date(2026, 9, 4, 2, 50)
  await p.autoUpdate()
  assert.equal(updates(), 0, 'wrong hour')

  clock = new Date(2026, 9, 4, 3, 0)
  await p.autoUpdate()
  assert.equal(updates(), 1)
  assert.equal(p._state.operation.type, 'automatic update')

  clock = new Date(2026, 9, 4, 3, 10)
  await p.autoUpdate()
  assert.equal(updates(), 1, 'once a day')

  // nothing to update next day
  addBuild('xen-orchestra-202610040300', { active: true })
  clock = new Date(2026, 9, 5, 3, 0)
  await p.autoUpdate()
  assert.equal(updates(), 1, 'up to date')

  p.configure({ autoUpdate: false })
  commit('third')
  clock = new Date(2026, 9, 6, 3, 0)
  await p.autoUpdate()
  assert.equal(updates(), 1, 'disabled')
})

test('unload removes http handlers', async () => {
  await plugin.instance.load()
  assert.equal(Object.keys(xo.handlers).length, 9)
  plugin.instance.unload()
  assert.equal(Object.keys(xo.handlers).length, 0)
})

test('default export creates an instance like xo-server does', () => {
  const instance = plugin.default({ xo: fakeXo(), getDataDir: async () => dataDir })
  assert.equal(typeof instance.load, 'function')
  assert.equal(typeof instance.configure, 'function')
  assert.ok(plugin.configurationSchema.properties.autoUpdateHour)
})

test('banner script is added to Xen Orchestra pages for admins only', async () => {
  const v5 = path.join(tmp, 'packages', 'xo-web', 'dist')
  const v6 = path.join(tmp, '@xen-orchestra', 'web', 'dist')
  const docs = path.join(tmp, 'docs', 'build-embed')
  fs.mkdirSync(v5, { recursive: true })
  fs.mkdirSync(v6, { recursive: true })
  fs.writeFileSync(path.join(v5, 'index.html'), '<html><head><title>v5</title></head><body></body></html>')
  fs.writeFileSync(path.join(v6, 'index.html'), '<html><head><title>v6</title></head><body></body></html>')
  xo = fakeXo({
    v5: { url: '/v5', path: v5 },
    v6: { url: '/v6', path: v6 },
    xoDocs: { url: '/docs', path: docs },
    xoRobotsTxt: { url: '/robots.txt', path: '/x/robots.txt' },
    default: { url: '/', path: v6 },
  })
  plugin.instance = newInstance()
  await plugin.instance.load()
  for (const p of ['/', '/index.html', '/v5/', '/v5/index.html', '/v6/', '/v6/index.html']) {
    assert.ok(xo.handlers[p], `${p} handled`)
  }
  assert.equal(xo.handlers['/docs/'], undefined)
  assert.equal(xo.handlers['/robots.txt/'], undefined)

  // anyone but an admin gets xo-server's usual handling, including its sign in redirect
  for (const options of [{}, { token: 'user-token' }, { token: 'bad' }, { ...admin, method: 'POST' }]) {
    const res = await request('/', options)
    assert.equal(res.nextCalled, true)
    assert.equal(res.body, undefined)
  }

  let res = await request('/', admin)
  assert.equal(res.nextCalled, false)
  assert.equal(res.body, '<html><head><title>v6</title><script src="/installer-updates/banner.js" defer></script></head><body></body></html>')
  res = await request('/v5/', admin)
  assert.match(res.body, /<title>v5<\/title><script src="\/installer-updates\/banner.js" defer><\/script><\/head>/)

  // disabled in settings
  plugin.instance.configure({ banner: false })
  assert.equal((await request('/', admin)).nextCalled, true)

  // missing page falls back to xo-server
  plugin.instance.configure({})
  fs.rmSync(path.join(v5, 'index.html'))
  assert.equal((await request('/v5/', admin)).nextCalled, true)

  const js = await request('/installer-updates/banner.js', admin)
  assert.doesNotThrow(() => new Function(js.body))
})

test('summary for the banner', async () => {
  await plugin.instance.load()
  commit('second')
  await plugin.instance.check()
  assert.equal((await request('/installer-updates/summary', { token: 'user-token' })).statusCode, 403)
  const summary = JSON.parse((await request('/installer-updates/summary', admin)).body)
  assert.equal(summary.state, 'update-available')
  assert.equal(summary.branch, 'master')
  assert.equal(summary.running, false)
  assert.equal(summary.latest.length, 40)
})
