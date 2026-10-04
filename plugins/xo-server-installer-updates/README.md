# xo-server-installer-updates

xo-server plugin which keeps a Xen Orchestra installation made with `xo-install.sh` up to date.

- Checks periodically whether the `BRANCH` of `REPOSITORY` configured in `xo-install.cfg` has a newer commit than the installed one
- Optionally applies updates automatically once a day at a configured hour
- Emails the configured recipients about new updates and finished updates and rollbacks (needs the `transport-email` plugin)
- Banner at the top of Xen Orchestra (v5 and v6 UIs) for admins when an update is available, running or failed, linking to the status page. It can be dismissed until something changes and turned off in the plugin settings. Xen Orchestra's own files are not modified: the plugin serves its index page with the banner script added, only to signed in admins
- Status page at `https://<xo-address>/installer-updates` for admins:
  - installed and latest commit, list of new commits, **Check now** and **Update now**
  - result of the last update or rollback and its log
  - installed builds with **Switch to** to roll back (or forward) to any of them
- Updates run `xo-install.sh --update` and switches `xo-install.sh --rollback-to <build>` in a transient systemd unit (`xo-installer-update`), so they survive xo-server being restarted. Log is written to `/var/log/xo-installer-update.log`
- State (last operation, notified commit) is kept in the plugin data directory so it survives restarts

## Installation

Enable it in `xo-install.cfg` and install or update Xen Orchestra with `xo-install.sh`:

```
BUNDLED_PLUGINS="xo-server-installer-updates"
```

If `PLUGINS` is not `all`, add `xo-server-installer-updates` to it too. `xo-remote-deploy.sh` enables it by default.

Then enable the plugin in **Settings → Plugins** of Xen Orchestra and optionally set the check interval, automatic updates and email recipients.

## Limitations

- xo-server must run as root (default `XOUSER`), because the update is started with `systemd-run`
- Branch pinned to a commit in `BRANCH` is never reported as outdated
- Commit list is fetched from GitHub API and is shown only for repositories hosted on GitHub

## Tests

```
npm test
```
