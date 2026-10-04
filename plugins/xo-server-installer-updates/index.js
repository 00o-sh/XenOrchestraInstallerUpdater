'use strict'

// xo-server plugin which keeps a Xen Orchestra installation made with xo-install.sh up to date:
// - checks periodically if the BRANCH configured in xo-install.cfg has new commits
// - notifies by email and optionally applies updates automatically at a set hour
// - serves an admin-only page at /installer-updates to update, see the builds and switch between them
//
// Updates and build switches are run by xo-install.sh in a transient systemd unit, because both restart
// xo-server which would otherwise kill them.

const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

const BASE_PATH = '/installer-updates'
const UPDATE_UNIT = 'xo-installer-update'
const UPDATE_LOG = '/var/log/xo-installer-update.log'
const EXIT_MARKER = 'xo-installer-update exit code '
const BUILD_RE = /^xen-orchestra-(\d{12})$/

exports.configurationSchema = {
  type: 'object',
  description: `Update status, update button and installed builds are at ${BASE_PATH} on this Xen Orchestra. Test plugin runs a check now.`,
  properties: {
    checkInterval: {
      title: 'Check interval (hours)',
      description: 'How often to check for new Xen Orchestra commits',
      type: 'integer',
      minimum: 1,
      default: 6,
    },
    autoUpdate: {
      title: 'Update automatically',
      description: 'Apply available updates once a day at the hour below',
      type: 'boolean',
      default: false,
    },
    autoUpdateHour: {
      title: 'Automatic update hour (0-23, xo-server local time)',
      type: 'integer',
      minimum: 0,
      maximum: 23,
      default: 3,
    },
    emailTo: {
      title: 'Email recipients',
      description: 'Notified of new updates and of finished updates and rollbacks. Needs the transport-email plugin',
      type: 'array',
      items: { type: 'string' },
    },
  },
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60e3, maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) {
        error.message += stderr ? `: ${stderr.trim()}` : ''
        reject(error)
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

function parseCookies(header = '') {
  const cookies = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) {
      cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    }
  }
  return cookies
}

// remote ref to compare against, based on BRANCH format supported by xo-install.sh
function refForBranch(branch) {
  if (/^[0-9a-f]{7,40}$/i.test(branch)) {
    return undefined // pinned to a commit, nothing to update
  }
  if (branch.startsWith('tags/')) {
    return `refs/${branch}`
  }
  return `refs/heads/${branch}`
}

// xo-install.sh names builds after the date: xen-orchestra-YYYYMMDDHHMM
function buildDate(name) {
  const [, t] = BUILD_RE.exec(name)
  return new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12)).toISOString()
}

// result of a finished operation from the end of its log
function parseResult(log) {
  const i = log.lastIndexOf(EXIT_MARKER)
  if (i === -1) {
    return undefined
  }
  const code = parseInt(log.slice(i + EXIT_MARKER.length), 10)
  const failures = (cleanLog(log).join('\n').match(/^\[fail\]/gm) ?? []).length
  return { success: code === 0, code, failures }
}

function cleanLog(log) {
  return log
    .replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex
    .split(/\r?\n|\r/)
    .filter(line => !line.startsWith(EXIT_MARKER))
}

class InstallerUpdates {
  constructor({ xo, installer = {}, getDataDir, runCommand = run, now = () => new Date(), logFile = UPDATE_LOG }) {
    this._xo = xo
    this._logFile = logFile
    this._run = runCommand
    this._now = now
    this._getDataDir = getDataDir
    // written by xo-install.sh when it copies this plugin into the build
    this._scriptDir = installer.scriptDir
    this._installDir = installer.installDir ?? '/opt/xo'
    this._configuration = {}
    this._status = { state: 'unknown' }
    // persisted, survives xo-server restarts caused by updates
    this._state = {}
    this._unregister = []
    this._timers = []
  }

  configure(configuration) {
    this._configuration = configuration
    if (this._loaded) {
      this._schedule()
    }
  }

  async load() {
    this._state = await this._readState()
    for (const [suffix, handler] of Object.entries({
      '': this._page,
      '/status': this._statusHandler,
      '/check': this._checkHandler,
      '/apply': this._applyHandler,
      '/switch': this._switchHandler,
      '/app.js': this._assetHandler('application/javascript', JS),
      '/app.css': this._assetHandler('text/css', CSS),
    })) {
      this._unregister.push(await this._xo.registerHttpRequestHandler(BASE_PATH + suffix, handler.bind(this)))
    }
    this._loaded = true
    this._schedule()
    // after an update xo-server is restarted, record how the update went and check again shortly after start
    this._timers.push(
      setTimeout(() => {
        this._reconcile()
          .then(() => this.check())
          .catch(() => {})
      }, 30e3)
    )
  }

  unload() {
    this._loaded = false
    this._timers.splice(0).forEach(clearTimeout)
    clearInterval(this._checkTimer)
    clearInterval(this._autoTimer)
    this._unregister.splice(0).forEach(fn => fn())
  }

  async test() {
    const status = await this.check()
    if (status.state === 'error') {
      throw new Error(status.error)
    }
  }

  _schedule() {
    clearInterval(this._checkTimer)
    clearInterval(this._autoTimer)
    const hours = this._configuration.checkInterval ?? 6
    this._checkTimer = setInterval(() => this.check().catch(() => {}), hours * 3600e3)
    this._autoTimer = setInterval(() => this.autoUpdate().catch(() => {}), 10 * 60e3)
  }

  // ---------------------------------------------------------------- state

  async _statePath() {
    return this._getDataDir === undefined ? undefined : path.join(await this._getDataDir(), 'state.json')
  }

  async _readState() {
    try {
      return JSON.parse(await fs.readFile(await this._statePath(), 'utf8'))
    } catch {
      return {}
    }
  }

  async _saveState(changes) {
    Object.assign(this._state, changes)
    const file = await this._statePath()
    if (file !== undefined) {
      await fs.writeFile(file, JSON.stringify(this._state, null, 2))
    }
  }

  // ---------------------------------------------------------------- checks

  // reads REPOSITORY and BRANCH from xo-install.cfg the same way xo-install.sh does
  async _installerConfig() {
    if (this._scriptDir === undefined) {
      throw new Error('installer location unknown, reinstall with xo-install.sh to set it up')
    }
    const out = await this._run('bash', [
      '-c',
      'source "$1" >/dev/null 2>&1; printf "%s\\n%s\\n" "${REPOSITORY:-https://github.com/vatesfr/xen-orchestra}" "${BRANCH:-master}"',
      'bash',
      path.join(this._scriptDir, 'xo-install.cfg'),
    ])
    const [repository, branch] = out.split('\n')
    return { repository, branch }
  }

  async _running() {
    try {
      await this._run('systemctl', ['is-active', '--quiet', UPDATE_UNIT])
      return true
    } catch {
      return false
    }
  }

  async check() {
    const status = { checkedAt: this._now().toISOString() }
    try {
      const { repository, branch } = await this._installerConfig()
      Object.assign(status, { repository, branch })

      status.installed = await this._run('git', ['-C', path.join(this._installDir, 'xo-server'), 'rev-parse', 'HEAD'])

      const ref = refForBranch(branch)
      if (ref === undefined) {
        status.state = 'pinned'
      } else {
        const lines = (await this._run('git', ['ls-remote', repository, ref, `${ref}^{}`])).split('\n')
        // annotated tags have the commit in the peeled ^{} entry
        const line = lines.find(l => l.endsWith('^{}')) ?? lines[0]
        status.latest = line?.split('\t')[0]
        if (!status.latest) {
          throw new Error(`${branch} not found in ${repository}`)
        }
        status.state = status.latest === status.installed ? 'up-to-date' : 'update-available'
        if (status.state === 'update-available') {
          status.changes = await this._changes(repository, status.installed, status.latest)
        }
      }
    } catch (error) {
      status.state = 'error'
      status.error = error.message
    }
    this._status = status
    if (status.state === 'update-available' && this._state.notified !== status.latest) {
      await this._saveState({ notified: status.latest })
      await this._notifyAvailable(status).catch(() => {})
    }
    return status
  }

  // commit list between installed and latest from GitHub API, best effort
  async _changes(repository, from, to) {
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repository)
    if (match === null) {
      return undefined
    }
    try {
      const res = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/compare/${from}...${to}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'xo-server-installer-updates' },
        signal: AbortSignal.timeout(15e3),
      })
      if (!res.ok) {
        return undefined
      }
      const body = await res.json()
      return {
        url: body.html_url,
        count: body.ahead_by,
        commits: body.commits
          .slice(-20)
          .reverse()
          .map(c => ({ sha: c.sha, message: c.commit.message.split('\n')[0] })),
      }
    } catch {
      return undefined
    }
  }

  // installed builds, newest first
  async builds() {
    const dir = path.join(this._installDir, 'xo-builds')
    const names = (await fs.readdir(dir).catch(() => [])).filter(name => BUILD_RE.test(name))
    const active = await fs.realpath(path.join(this._installDir, 'xo-server')).catch(() => '')
    const builds = await Promise.all(
      names.map(async name => {
        const build = { name, date: buildDate(name), active: active.startsWith(path.join(dir, name) + path.sep) }
        try {
          const [commit, committedAt, ...subject] = (
            await this._run('git', ['-C', path.join(dir, name), 'log', '-1', '--format=%H%x09%cI%x09%s'])
          ).split('\t')
          Object.assign(build, { commit, committedAt, subject: subject.join('\t') })
        } catch {}
        return build
      })
    )
    return builds.sort((a, b) => b.name.localeCompare(a.name))
  }

  // ---------------------------------------------------------------- operations

  async _start(type, args, target) {
    if (await this._running()) {
      throw new Error('an update or rollback is already running')
    }
    if (this._scriptDir === undefined) {
      throw new Error('installer location unknown')
    }
    await this._saveState({ operation: { type, target, startedAt: this._now().toISOString() } })
    // transient unit survives xo-server being stopped, exit code is appended for the result
    await this._run('systemd-run', [
      `--unit=${UPDATE_UNIT}`,
      '--collect',
      `--description=Xen Orchestra ${type} by xo-server-installer-updates`,
      '/bin/bash',
      '-c',
      `cd "$1" && shift && ./xo-install.sh "$@" >"$0" 2>&1; echo "${EXIT_MARKER}$?" >>"$0"`,
      this._logFile,
      this._scriptDir,
      ...args,
    ])
  }

  apply(trigger = 'manual') {
    return this._start(trigger === 'auto' ? 'automatic update' : 'update', ['--update'])
  }

  async switchTo(name) {
    const build = (await this.builds()).find(b => b.name === name)
    if (build === undefined) {
      throw new Error(`build ${name} not found`)
    }
    if (build.active) {
      throw new Error(`${name} is already active`)
    }
    await this._start('rollback', ['--rollback-to', name], name)
  }

  // records the result of the last operation once it has finished
  async _reconcile() {
    const operation = this._state.operation
    if (operation === undefined || operation.finishedAt !== undefined || (await this._running())) {
      return
    }
    const log = await fs.readFile(this._logFile, 'utf8').catch(() => '')
    const result = parseResult(log) ?? { success: false, code: undefined, failures: 0, interrupted: true }
    const finished = { ...operation, ...result, finishedAt: this._now().toISOString() }
    await this._saveState({ operation: finished })
    await this._notifyFinished(finished, log).catch(() => {})
  }

  async autoUpdate() {
    const now = this._now()
    const day = now.toISOString().slice(0, 10)
    const { autoUpdate, autoUpdateHour = 3 } = this._configuration
    if (!autoUpdate || now.getHours() !== autoUpdateHour || this._state.autoUpdateDay === day) {
      return
    }
    await this._saveState({ autoUpdateDay: day })
    const status = await this.check()
    if (status.state === 'update-available' && !(await this._running())) {
      await this.apply('auto')
    }
  }

  // ---------------------------------------------------------------- notifications

  async _sendEmail(subject, markdown) {
    const to = this._configuration.emailTo
    if (!to?.length || this._xo.sendEmail === undefined) {
      return
    }
    await this._xo.sendEmail({ to, subject: `[Xen Orchestra] ${subject}`, markdown })
  }

  _notifyAvailable(status) {
    const count = status.changes?.count
    return this._sendEmail(
      `update available on ${status.branch}`,
      [
        `Installed: \`${status.installed.slice(0, 10)}\`, latest: \`${status.latest.slice(0, 10)}\`${count ? ` (${count} commits)` : ''}`,
        status.changes?.url ? `\nChanges: ${status.changes.url}` : '',
        this._configuration.autoUpdate
          ? `\nIt will be applied automatically at ${this._configuration.autoUpdateHour ?? 3}:00.`
          : `\nApply it from ${BASE_PATH} on your Xen Orchestra.`,
      ].join('\n')
    )
  }

  _notifyFinished(operation, log) {
    const what = operation.type === 'rollback' ? `rollback to ${operation.target}` : operation.type
    const outcome = operation.success ? 'succeeded' : 'failed'
    return this._sendEmail(
      `${what} ${outcome}`,
      [
        `${what[0].toUpperCase() + what.slice(1)} started ${operation.startedAt} ${outcome}${operation.code !== undefined ? ` (exit code ${operation.code})` : ''}.`,
        '\nEnd of the log:\n',
        '```',
        cleanLog(log).slice(-30).join('\n'),
        '```',
      ].join('\n')
    )
  }

  // ---------------------------------------------------------------- http

  // only admins with a valid XO session get access
  async _authorize(req) {
    const token = parseCookies(req.headers.cookie).authenticationToken
    if (!token) {
      return false
    }
    try {
      const { user } = await this._xo.authenticateUser({ token }, undefined, { bypassTaskCreation: true })
      return user.permission === 'admin'
    } catch {
      return false
    }
  }

  // state changing requests must come from a page served by this host
  _sameOrigin(req) {
    const origin = req.headers.origin
    if (!origin) {
      return false
    }
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  async _guard(req, res, { mutating = false } = {}) {
    if (!(await this._authorize(req))) {
      res.statusCode = 403
      res.setHeader('content-type', 'text/plain')
      res.end('Sign in to Xen Orchestra as an admin first')
      return false
    }
    if (mutating && (req.method !== 'POST' || !this._sameOrigin(req))) {
      res.statusCode = 400
      res.end('Bad request')
      return false
    }
    return true
  }

  async _statusJson() {
    await this._reconcile()
    const log = await fs.readFile(this._logFile, 'utf8').catch(() => '')
    const { autoUpdate = false, autoUpdateHour = 3 } = this._configuration
    return {
      ...this._status,
      running: await this._running(),
      operation: this._state.operation,
      autoUpdate: autoUpdate ? autoUpdateHour : undefined,
      builds: await this.builds(),
      log: cleanLog(log).slice(-40).join('\n'),
    }
  }

  async _json(res, fn) {
    res.setHeader('content-type', 'application/json')
    try {
      return JSON.stringify(await fn())
    } catch (error) {
      res.statusCode = 409
      return JSON.stringify({ error: error.message })
    }
  }

  async _statusHandler(req, res) {
    if (!(await this._guard(req, res))) return
    return this._json(res, () => this._statusJson())
  }

  async _checkHandler(req, res) {
    if (!(await this._guard(req, res, { mutating: true }))) return
    return this._json(res, async () => {
      await this.check()
      return this._statusJson()
    })
  }

  async _applyHandler(req, res) {
    if (!(await this._guard(req, res, { mutating: true }))) return
    return this._json(res, async () => {
      await this.apply()
      return { started: true }
    })
  }

  async _switchHandler(req, res) {
    if (!(await this._guard(req, res, { mutating: true }))) return
    return this._json(res, async () => {
      const build = new URL(req.url ?? '', 'http://x').searchParams.get('build') ?? ''
      if (!BUILD_RE.test(build)) {
        throw new Error('invalid build')
      }
      await this.switchTo(build)
      return { started: true }
    })
  }

  _assetHandler(type, content) {
    return async (req, res) => {
      if (!(await this._guard(req, res))) return
      res.setHeader('content-type', `${type}; charset=utf-8`)
      return content
    }
  }

  async _page(req, res) {
    if (!(await this._guard(req, res))) return
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return PAGE
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Xen Orchestra updates</title>
<link rel="stylesheet" href="${BASE_PATH}/app.css">
</head>
<body>
<main>
  <h1>Xen Orchestra updates</h1>
  <div class="card">
    <dl id="info"><dt>Status</dt><dd>loading...</dd></dl>
    <p id="message" class="notice"></p>
    <button id="check">Check now</button>
    <button id="apply" class="primary" disabled>Update now</button>
  </div>
  <div class="card" id="operation-card" hidden><strong>Last operation</strong><p id="operation"></p></div>
  <div class="card" id="changes-card" hidden><strong>New commits</strong><ul id="changes"></ul></div>
  <div class="card" id="builds-card" hidden>
    <strong>Installed builds</strong>
    <p class="muted">Switching restarts Xen Orchestra with the selected build. Updates remove older builds according to PRESERVE in xo-install.cfg.</p>
    <table><thead><tr><th>Built</th><th>Commit</th><th></th></tr></thead><tbody id="builds"></tbody></table>
  </div>
  <div class="card" id="log-card" hidden><strong>Log</strong><pre id="log"></pre></div>
</main>
<script src="${BASE_PATH}/app.js"></script>
</body>
</html>
`

// served as separate files because xo-server's Content-Security-Policy blocks inline scripts
const CSS = `:root { color-scheme: light dark; --fg: #1d1d2b; --bg: #f6f6fa; --card: #fff; --muted: #6b6b80; --line: #e4e4ee; --accent: #6d4bd6; --ok: #2e8b57; --warn: #c27b00; --err: #c0392b; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8f0; --bg: #14141f; --card: #1e1e2d; --muted: #9a9ab0; --line: #2e2e42; } }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 820px; margin: 0 auto; padding: 24px 16px; }
.card { background: var(--card); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 16px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt, .muted { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.muted { font-size: 13px; margin: 4px 0 8px; }
code { font-size: 13px; }
.state { font-weight: 600; } .up-to-date, .success { color: var(--ok); } .update-available, .running { color: var(--warn); } .error, .failed { color: var(--err); }
.notice:empty { display: none; }
button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; margin-right: 8px; }
button.primary { background: var(--accent); color: #fff; }
button.small { padding: 3px 10px; font-size: 13px; margin: 0; }
button:disabled { opacity: .5; cursor: default; }
ul { padding-left: 18px; margin: 8px 0 0; } li { margin: 2px 0; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--muted); font-weight: normal; padding: 4px 8px 4px 0; }
td { border-top: 1px solid var(--line); padding: 6px 8px 6px 0; vertical-align: top; }
td:last-child { text-align: right; white-space: nowrap; }
.badge { font-size: 12px; color: var(--ok); border: 1px solid var(--ok); border-radius: 10px; padding: 1px 8px; }
pre { white-space: pre-wrap; font-size: 12px; max-height: 360px; overflow: auto; margin: 8px 0 0; }
a { color: var(--accent); }
`

const JS = `const base = '${BASE_PATH}'
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const short = s => s ? '<code>' + esc(s.slice(0, 10)) + '</code>' : '-'
const when = d => d ? new Date(d).toLocaleString() : '-'
const labels = { 'up-to-date': 'Up to date', 'update-available': 'Update available', pinned: 'Pinned to a commit in xo-install.cfg', error: 'Check failed', unknown: 'Not checked yet' }
let waiting = false

function describe(op) {
  const what = op.type === 'rollback' ? 'Switch to ' + esc(op.target) : esc(op.type[0].toUpperCase() + op.type.slice(1))
  if (!op.finishedAt) return '<span class="running">' + what + ' running</span>, started ' + esc(when(op.startedAt))
  const result = op.success ? '<span class="success">succeeded</span>' : '<span class="failed">failed</span>' + (op.code !== undefined ? ' (exit code ' + esc(op.code) + ')' : ' (interrupted)')
  return what + ' ' + result + ', started ' + esc(when(op.startedAt)) + ', finished ' + esc(when(op.finishedAt))
}

function render(s) {
  $('info').innerHTML =
    '<dt>Status</dt><dd class="state ' + esc(s.running ? 'running' : s.state) + '">' + esc(s.running ? 'Running' : labels[s.state] || s.state) + '</dd>' +
    '<dt>Installed</dt><dd>' + short(s.installed) + '</dd>' +
    '<dt>Latest</dt><dd>' + short(s.latest) + (s.changes && s.changes.count ? ' (' + esc(s.changes.count) + ' new commits)' : '') + '</dd>' +
    '<dt>Source</dt><dd>' + esc(s.repository || '-') + ' <code>' + esc(s.branch || '') + '</code></dd>' +
    '<dt>Last check</dt><dd>' + esc(when(s.checkedAt)) + '</dd>' +
    '<dt>Automatic updates</dt><dd>' + (s.autoUpdate !== undefined ? 'daily at ' + esc(s.autoUpdate) + ':00' : 'off, can be enabled in Settings → Plugins') + '</dd>'
  $('message').textContent = s.running ? 'Running. Xen Orchestra restarts when it finishes and this page reconnects by itself.' : s.error || ''
  $('message').className = s.running ? 'notice' : 'notice error'
  $('apply').disabled = s.running || s.state !== 'update-available'
  $('check').disabled = s.running
  $('operation-card').hidden = !s.operation
  if (s.operation) $('operation').innerHTML = describe(s.operation)
  const commits = (s.changes && s.changes.commits) || []
  $('changes-card').hidden = commits.length === 0
  $('changes').innerHTML = commits.map(c => '<li>' + short(c.sha) + ' ' + esc(c.message) + '</li>').join('') +
    (s.changes && s.changes.url ? '<li><a href="' + esc(s.changes.url) + '" target="_blank" rel="noopener">All changes on GitHub</a></li>' : '')
  const builds = s.builds || []
  $('builds-card').hidden = builds.length === 0
  $('builds').innerHTML = builds.map(b =>
    '<tr><td>' + esc(when(b.date)) + '</td><td>' + short(b.commit) + ' ' + esc(b.subject || '') + '</td><td>' +
    (b.active ? '<span class="badge">active</span>' : '<button class="small" data-build="' + esc(b.name) + '"' + (s.running ? ' disabled' : '') + '>Switch to</button>') +
    '</td></tr>').join('')
  $('log-card').hidden = !s.log
  $('log').textContent = s.log || ''
}

async function refresh() {
  try {
    const res = await fetch(base + '/status', { cache: 'no-store' })
    if (!res.ok) throw new Error(await res.text())
    let s = await res.json()
    // operation finished, refresh installed version right away instead of waiting for next scheduled check
    if (waiting && !s.running) {
      waiting = false
      s = await post('check').catch(() => s)
    }
    render(s)
  } catch (e) {
    // xo-server restarts during an update, keep polling until it is back
    $('message').className = 'notice'
    $('message').textContent = waiting ? 'Xen Orchestra is restarting...' : e.message
  }
}

async function post(action) {
  const res = await fetch(base + '/' + action, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}

async function start(action, question) {
  if (!confirm(question)) return
  try {
    await post(action)
    waiting = true
  } catch (e) {
    $('message').className = 'notice error'
    $('message').textContent = e.message
  }
  refresh()
}

$('check').onclick = async () => {
  $('check').disabled = true
  try { render(await post('check')) } catch (e) { $('message').textContent = e.message }
}
$('apply').onclick = () => start('apply', 'Update Xen Orchestra now? It will be unavailable while the new version is built and restarted.')
$('builds').onclick = e => {
  const build = e.target.dataset && e.target.dataset.build
  if (build) start('switch?build=' + encodeURIComponent(build), 'Switch Xen Orchestra to build ' + build + '? It will be restarted.')
}
refresh()
setInterval(refresh, 5000)
`

// installer.json is written next to this file by xo-install.sh
function readInstallerInfo() {
  try {
    return require('./installer.json')
  } catch {
    return {}
  }
}

exports.default = ({ xo, getDataDir }) => new InstallerUpdates({ xo, getDataDir, installer: readInstallerInfo() })

// for tests
exports.InstallerUpdates = InstallerUpdates
exports.refForBranch = refForBranch
exports.parseResult = parseResult
