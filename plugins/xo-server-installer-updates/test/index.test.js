'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, beforeEach, afterEach } = require('node:test')

const plugin = require('..')
const { InstallerUpdates, refForBranch } = plugin

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

let tmp, remote, work, installDir, scriptDir, xo, commands, unitActive

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

// fake xo-server: http handlers, authentication and email
function fakeXo() {
  return {
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
async function request(p, { method = 'GET', token, origin, host = 'xo.local' } = {}) {
  const headers = { host }
  if (token) headers.cookie = `foo=bar; authenticationToken=${token}`
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
  }
  const result = await xo.handlers[p]({ method, headers }, res, undefined, () => {})
  if (result != null) res.end(result)
  return res
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-updates-'))
  remote = path.join(tmp, 'xen-orchestra.git')
  work = path.join(tmp, 'work')
  installDir = path.join(tmp, 'opt-xo')
  scriptDir = path.join(tmp, 'installer')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote], { stdio: 'ignore' })
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' })
  commit('first')
  // installed build is a clone, xo-server symlink points inside it like xo-install.sh sets it up
  const build = path.join(installDir, 'xo-builds', 'xen-orchestra-1')
  execFileSync('git', ['clone', '-q', remote, build], { stdio: 'ignore' })
  fs.mkdirSync(path.join(build, 'packages', 'xo-server'), { recursive: true })
  fs.symlinkSync(path.join(build, 'packages', 'xo-server'), path.join(installDir, 'xo-server'))
  fs.mkdirSync(scriptDir)
  writeConfig([`REPOSITORY="${remote}"`, 'BRANCH="master"'])

  xo = fakeXo()
  commands = []
  unitActive = false
  const realRun = (cmd, args) =>
    new Promise((resolve, reject) => {
      require('node:child_process').execFile(cmd, args, (error, stdout) =>
        error ? reject(error) : resolve(stdout.trim())
      )
    })
  // systemd is replaced, everything else (bash, git) runs for real
  const runCommand = async (cmd, args) => {
    commands.push([cmd, ...args])
    if (cmd === 'systemctl') {
      if (!unitActive) throw new Error('inactive')
      return ''
    }
    if (cmd === 'systemd-run') {
      unitActive = true
      return ''
    }
    return realRun(cmd, args)
  }
  plugin.instance = new InstallerUpdates({ xo, installer: { scriptDir, installDir }, runCommand })
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

test('emails once per new commit when recipients are configured', async () => {
  const p = plugin.instance
  p.configure({ emailTo: ['admin@example.com'] })
  commit('second')
  await p.check()
  await p.check()
  assert.equal(xo.emails.length, 1)
  assert.match(xo.emails[0].subject, /update available on master/)
  commit('third')
  await p.check()
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
})

test('status page and endpoints require an admin session', async () => {
  await plugin.instance.load()
  for (const p of ['/installer-updates', '/installer-updates/status']) {
    assert.equal((await request(p)).statusCode, 403)
    assert.equal((await request(p, { token: 'user-token' })).statusCode, 403)
    assert.equal((await request(p, { token: 'bad' })).statusCode, 403)
  }
  const page = await request('/installer-updates', { token: 'admin-token' })
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /<title>Xen Orchestra updates<\/title>/)
  // xo-server's Content-Security-Policy blocks inline scripts and styles
  assert.doesNotMatch(page.body, /<script>|<style>|\son\w+=/)

  const js = await request('/installer-updates/app.js', { token: 'admin-token' })
  assert.match(js.headers['content-type'], /javascript/)
  assert.doesNotThrow(() => new Function(js.body))
  const css = await request('/installer-updates/app.css', { token: 'admin-token' })
  assert.match(css.headers['content-type'], /text\/css/)
  assert.equal((await request('/installer-updates/app.js')).statusCode, 403)
})

test('check and apply need POST from the same origin', async () => {
  await plugin.instance.load()
  const admin = { token: 'admin-token' }
  for (const p of ['/installer-updates/check', '/installer-updates/apply']) {
    assert.equal((await request(p, admin)).statusCode, 400)
    assert.equal((await request(p, { ...admin, method: 'POST' })).statusCode, 400)
    assert.equal((await request(p, { ...admin, method: 'POST', origin: 'https://evil.example' })).statusCode, 400)
  }
  assert.equal(commands.filter(c => c[0] === 'systemd-run').length, 0)

  commit('second')
  const res = await request('/installer-updates/check', { ...admin, method: 'POST', origin: 'https://xo.local' })
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).state, 'update-available')
})

test('apply starts xo-install.sh --update in a transient systemd unit once', async () => {
  await plugin.instance.load()
  const post = { token: 'admin-token', method: 'POST', origin: 'https://xo.local' }
  let res = await request('/installer-updates/apply', post)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(JSON.parse(res.body), { started: true })

  const run = commands.find(c => c[0] === 'systemd-run')
  assert.ok(run.includes('--unit=xo-installer-update'))
  assert.ok(run.includes('cd "$1" && ./xo-install.sh --update >"$2" 2>&1'))
  assert.ok(run.includes(scriptDir))

  // second request while the unit runs is refused
  res = await request('/installer-updates/apply', post)
  assert.equal(res.statusCode, 409)
  assert.match(JSON.parse(res.body).error, /already running/)

  const status = JSON.parse((await request('/installer-updates/status', { token: 'admin-token' })).body)
  assert.equal(status.updating, true)
})

test('unload removes http handlers', async () => {
  await plugin.instance.load()
  assert.equal(Object.keys(xo.handlers).length, 6)
  plugin.instance.unload()
  assert.equal(Object.keys(xo.handlers).length, 0)
})

test('default export creates an instance like xo-server does', () => {
  const instance = plugin.default({ xo: fakeXo() })
  assert.equal(typeof instance.load, 'function')
  assert.equal(typeof instance.configure, 'function')
  assert.ok(plugin.configurationSchema.properties.checkInterval)
})
