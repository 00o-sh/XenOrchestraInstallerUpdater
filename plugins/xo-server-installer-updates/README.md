# xo-server-installer-updates

Proof of concept xo-server plugin which keeps a Xen Orchestra installation made with `xo-install.sh` up to date.

- Checks periodically whether the `BRANCH` of `REPOSITORY` configured in `xo-install.cfg` has a newer commit than the installed one
- Emails the configured recipients once per new commit (needs the `transport-email` plugin)
- Status page at `https://<xo-address>/installer-updates` for admins: installed and latest commit, list of new commits, **Check now** and **Update now** buttons and the log of the running update
- **Update now** runs `xo-install.sh --update` in a transient systemd unit (`xo-installer-update`) so the update survives xo-server being restarted. Log is written to `/var/log/xo-installer-update.log`

## Installation

Enable it in `xo-install.cfg` and install or update Xen Orchestra with `xo-install.sh`:

```
BUNDLED_PLUGINS="xo-server-installer-updates"
```

If `PLUGINS` is not `all`, add `xo-server-installer-updates` to it too. `xo-remote-deploy.sh` enables it by default.

Then enable the plugin in **Settings → Plugins** of Xen Orchestra and optionally set the check interval and email recipients.

## Limitations

- xo-server must run as root (default `XOUSER`), because the update is started with `systemd-run`
- Branch pinned to a commit in `BRANCH` is never reported as outdated
- Commit list is fetched from GitHub API and is shown only for repositories hosted on GitHub

## Tests

```
npm test
```
