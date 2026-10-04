'use strict'

// xo-server plugin which checks if the Xen Orchestra branch configured in xo-install.cfg has new commits
// and lets an admin apply the update from a status page served by xo-server at /installer-updates.
//
// The update itself is run by xo-install.sh --update in a separate transient systemd unit, because
// the update stops and restarts xo-server which would otherwise kill it.

const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

const BASE_PATH = '/installer-updates'
const UPDATE_UNIT = 'xo-installer-update'
const UPDATE_LOG = '/var/log/xo-installer-update.log'

exports.configurationSchema = {
  type: 'object',
  description: `Update status and update button are at ${BASE_PATH} on this Xen Orchestra. Test plugin runs a check now.`,
  properties: {
    checkInterval: {
      title: 'Check interval (hours)',
      description: 'How often to check for new Xen Orchestra commits',
      type: 'integer',
      minimum: 1,
      default: 6,
    },
    emailTo: {
      title: 'Email recipients',
      description: 'Notified once per new commit when an update is available. Needs the transport-email plugin',
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

class InstallerUpdates {
  constructor({ xo, installer = {}, runCommand = run }) {
    this._xo = xo
    this._run = runCommand
    // written by xo-install.sh when it copies this plugin into the build
    this._scriptDir = installer.scriptDir
    this._installDir = installer.installDir ?? '/opt/xo'
    this._configuration = {}
    this._status = { state: 'unknown' }
    this._notified = undefined
    this._unregister = []
  }

  configure(configuration) {
    this._configuration = configuration
    if (this._timer !== undefined) {
      this._schedule()
    }
  }

  async load() {
    for (const [suffix, handler] of Object.entries({
      '': this._page,
      '/status': this._statusHandler,
      '/check': this._checkHandler,
      '/apply': this._applyHandler,
      '/app.js': this._assetHandler('application/javascript', JS),
      '/app.css': this._assetHandler('text/css', CSS),
    })) {
      this._unregister.push(await this._xo.registerHttpRequestHandler(BASE_PATH + suffix, handler.bind(this)))
    }
    this._schedule()
    // first check shortly after start so xo-server startup is not slowed down
    this._initialCheck = setTimeout(() => this.check().catch(() => {}), 30e3)
  }

  unload() {
    clearTimeout(this._initialCheck)
    clearInterval(this._timer)
    this._timer = undefined
    this._unregister.splice(0).forEach(fn => fn())
  }

  async test() {
    const status = await this.check()
    if (status.state === 'error') {
      throw new Error(status.error)
    }
  }

  _schedule() {
    clearInterval(this._timer)
    const hours = this._configuration.checkInterval ?? 6
    this._timer = setInterval(() => this.check().catch(() => {}), hours * 3600e3)
  }

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

  async _updateRunning() {
    try {
      await this._run('systemctl', ['is-active', '--quiet', UPDATE_UNIT])
      return true
    } catch {
      return false
    }
  }

  async check() {
    const status = { checkedAt: new Date().toISOString() }
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
    if (status.state === 'update-available' && this._notified !== status.latest) {
      this._notified = status.latest
      await this._notify(status).catch(() => {})
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

  async _notify(status) {
    const to = this._configuration.emailTo
    if (!to?.length || this._xo.sendEmail === undefined) {
      return
    }
    const count = status.changes?.count
    await this._xo.sendEmail({
      to,
      subject: `[Xen Orchestra] update available on ${status.branch}`,
      markdown: [
        `Installed: \`${status.installed.slice(0, 10)}\`, latest: \`${status.latest.slice(0, 10)}\`${count ? ` (${count} commits)` : ''}`,
        status.changes?.url ? `\nChanges: ${status.changes.url}` : '',
        `\nApply it from ${BASE_PATH} on your Xen Orchestra.`,
      ].join('\n'),
    })
  }

  async apply() {
    if (await this._updateRunning()) {
      throw new Error('update is already running')
    }
    if (this._scriptDir === undefined) {
      throw new Error('installer location unknown')
    }
    // transient unit survives xo-server being stopped during the update
    await this._run('systemd-run', [
      `--unit=${UPDATE_UNIT}`,
      '--collect',
      '--description=Xen Orchestra update by xo-server-installer-updates',
      '/bin/bash',
      '-c',
      'cd "$1" && ./xo-install.sh --update >"$2" 2>&1',
      'bash',
      this._scriptDir,
      UPDATE_LOG,
    ])
  }

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
    const log = await fs.readFile(UPDATE_LOG, 'utf8').catch(() => '')
    return {
      ...this._status,
      updating: await this._updateRunning(),
      // strip colors and progress carriage returns of xo-install.sh output
      log: log
        .replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex
        .split(/\r?\n|\r/)
        .slice(-40)
        .join('\n'),
    }
  }

  async _statusHandler(req, res) {
    if (!(await this._guard(req, res))) return
    res.setHeader('content-type', 'application/json')
    return JSON.stringify(await this._statusJson())
  }

  async _checkHandler(req, res) {
    if (!(await this._guard(req, res, { mutating: true }))) return
    await this.check()
    res.setHeader('content-type', 'application/json')
    return JSON.stringify(await this._statusJson())
  }

  async _applyHandler(req, res) {
    if (!(await this._guard(req, res, { mutating: true }))) return
    res.setHeader('content-type', 'application/json')
    try {
      await this.apply()
      return JSON.stringify({ started: true })
    } catch (error) {
      res.statusCode = 409
      return JSON.stringify({ error: error.message })
    }
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
    <p id="message" class="error"></p>
    <button id="check">Check now</button>
    <button id="apply" class="primary" disabled>Update now</button>
  </div>
  <div class="card" id="changes-card" hidden><strong>Changes</strong><ul id="changes"></ul></div>
  <div class="card" id="log-card" hidden><strong>Update log</strong><pre id="log"></pre></div>
</main>
<script src="${BASE_PATH}/app.js"></script>
</body>
</html>
`

// served as separate files because xo-server's Content-Security-Policy blocks inline scripts
const CSS = `  :root { color-scheme: light dark; --fg: #1d1d2b; --bg: #f6f6fa; --card: #fff; --muted: #6b6b80; --accent: #6d4bd6; --ok: #2e8b57; --warn: #c27b00; --err: #c0392b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e8f0; --bg: #14141f; --card: #1e1e2d; --muted: #9a9ab0; } }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
  .card { background: var(--card); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  code { font-size: 13px; }
  .state { font-weight: 600; } .up-to-date { color: var(--ok); } .update-available { color: var(--warn); } .error { color: var(--err); }
  button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; margin-right: 8px; }
  button.primary { background: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  ul { padding-left: 18px; margin: 8px 0 0; } li { margin: 2px 0; }
  pre { white-space: pre-wrap; font-size: 12px; max-height: 360px; overflow: auto; margin: 0; }
  a { color: var(--accent); }
`

const JS = `const base = '${BASE_PATH}'
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const short = s => s ? '<code>' + esc(s.slice(0, 10)) + '</code>' : '-'
const labels = { 'up-to-date': 'Up to date', 'update-available': 'Update available', pinned: 'Pinned to a commit in xo-install.cfg', error: 'Check failed', unknown: 'Not checked yet' }
let applying = false

function render(s) {
  const state = s.updating ? 'updating' : s.state
  $('info').innerHTML =
    '<dt>Status</dt><dd class="state ' + esc(s.state) + '">' + esc(s.updating ? 'Update running' : labels[state] || state) + '</dd>' +
    '<dt>Installed</dt><dd>' + short(s.installed) + '</dd>' +
    '<dt>Latest</dt><dd>' + short(s.latest) + (s.changes && s.changes.count ? ' (' + esc(s.changes.count) + ' new commits)' : '') + '</dd>' +
    '<dt>Source</dt><dd>' + esc(s.repository || '-') + ' <code>' + esc(s.branch || '') + '</code></dd>' +
    '<dt>Last check</dt><dd>' + esc(s.checkedAt ? new Date(s.checkedAt).toLocaleString() : '-') + '</dd>'
  $('message').textContent = s.error || (s.updating ? 'Update running. Xen Orchestra restarts when it finishes and this page reconnects by itself.' : '')
  $('apply').disabled = s.updating || s.state !== 'update-available'
  $('check').disabled = s.updating
  const commits = (s.changes && s.changes.commits) || []
  $('changes-card').hidden = commits.length === 0
  $('changes').innerHTML = commits.map(c => '<li>' + short(c.sha) + ' ' + esc(c.message) + '</li>').join('') +
    (s.changes && s.changes.url ? '<li><a href="' + esc(s.changes.url) + '" target="_blank" rel="noopener">All changes on GitHub</a></li>' : '')
  $('log-card').hidden = !s.log
  $('log').textContent = s.log || ''
}

async function refresh() {
  try {
    const res = await fetch(base + '/status', { cache: 'no-store' })
    if (!res.ok) throw new Error(await res.text())
    let s = await res.json()
    // update finished, refresh installed version right away instead of waiting for next scheduled check
    if (applying && !s.updating) {
      applying = false
      s = await post('check').catch(() => s)
    }
    render(s)
  } catch (e) {
    // xo-server restarts during an update, keep polling until it is back
    $('message').textContent = applying ? 'Xen Orchestra is restarting...' : e.message
  }
}

async function post(action) {
  const res = await fetch(base + '/' + action, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}

$('check').onclick = async () => {
  $('check').disabled = true
  try { render(await post('check')) } catch (e) { $('message').textContent = e.message }
}
$('apply').onclick = async () => {
  if (!confirm('Update Xen Orchestra now? It will be unavailable while the new version is built and restarted.')) return
  $('apply').disabled = true
  try { await post('apply'); applying = true } catch (e) { $('message').textContent = e.message }
  refresh()
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

exports.default = ({ xo }) => new InstallerUpdates({ xo, installer: readInstallerInfo() })

// for tests
exports.InstallerUpdates = InstallerUpdates
exports.refForBranch = refForBranch
