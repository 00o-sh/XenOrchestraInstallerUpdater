# Xen Orchestra Installer / Updater

[![](https://img.shields.io/endpoint?url=https://xo-build-status.yawn.fi/builds/debian/status.json)](https://xo-build-status.yawn.fi/builds/debian/details.html) [![](https://img.shields.io/endpoint?url=https://xo-build-status.yawn.fi/builds/centos/status.json)](https://xo-build-status.yawn.fi/builds/centos/details.html) [![](https://img.shields.io/endpoint?url=https://xo-build-status.yawn.fi/builds/ubuntu/status.json)](https://xo-build-status.yawn.fi/builds/ubuntu/details.html) [![](https://img.shields.io/endpoint?url=https://xo-build-status.yawn.fi/builds/almalinux/status.json)](https://xo-build-status.yawn.fi/builds/almalinux/details.html)

[![](https://img.shields.io/endpoint?url=https://xo-image.yawn.fi/downloads/status.json)](https://xo-image.yawn.fi/downloads/image.txt)

[![](https://github.com/ronivay/XenOrchestraInstallerUpdater/actions/workflows/main.yml/badge.svg)](https://github.com/ronivay/XenOrchestraInstallerUpdater/actions?query=workflow%3Axo-install) [![](https://github.com/ronivay/XenOrchestraInstallerUpdater/actions/workflows/lint.yml/badge.svg)](https://github.com/ronivay/XenOrchestraInstallerUpdater/actions?query=workflow%3Alint)

Script to install/update [Xen Orchestra](https://xen-orchestra.com/#!/) and all of it's dependencies on multiple different Linux distributions. Separate script to be used on XenServer/XCP-ng host that installs a readymade VM image that has Xen Orchestra installed  utilizing the same installer script.

How about docker? No worries, check [Docker hub](https://hub.docker.com/r/ronivay/xen-orchestra)

### What is Xen Orchestra?

Xen Orchestra is a web interface used to manage XenServer/XCP-ng hosts and pools. It runs separately and one can manage multiple different virtualization environments from one single management interface.

Xen Orchestra is developed by company called [Vates](https://vates.fr/). They offer Xen Orchestra as a turnkey appliance with different pricing models for different needs and even a free version with limited capabilities. This is the preferred and only supported method of using Xen Orchestra product as the appliance goes through QA and each of the plans come with support. I highly recommend using the official appliance if you plan on using Xen Orchestra in production environment, to support a great product and it's development now, and in the future.


### Why to use this script?

If you're a home user/enthusiast with simple environment you want to manage but can't justify the cost of Xen Orchestra appliance and don't need the support for it.

Since Xen Orchestra is open source and majority of the paid features included in the official appliance are part of the sources, one can build it themself. This [procedure](https://docs.xen-orchestra.com/installation#from-the-sources) is even documented. Note that even though this method is documented, it's not supported way of using Xen Orchestra and is intended to be used only for testing purposes and not in production.

This script offers an easy way to install all dependencies, fetch source code, compile it and do all the little details for you which you'd have to do manually otherwise. Other than that, it follows the steps described in the official documentation. All source code for Xen Orchestra is by default pulled from the official [repository](https://github.com/vatesfr/xen-orchestra).

**This script is not supported or endorsed by Xen Orchestra. Any issue you may have, please report it first to this repository.**

The very first version of this script i did purely for myself. Now i'm mainly trying to keep it up to date for others who might already rely on it frequently. My intentions are to offer an easy way for people to get into Xen Orchestra without restricted features which could potentially help this piece of software to evolve and grow.


### Preparations

First thing you need is a VM (or even a physical machine if you wish) where to install the software. This should have at least 4GB of RAM and ~1GB of free disk space. Having more CPU does speed a the build procedure a bit but isn't really a requirement. 2vCPU's on most systems are more than fine.

Supported Linux distributions and versions:

- CentOS 10 Stream
- CentOS 9 Stream
- AlmaLinux 10
- AlmaLinux 9
- AlmaLinux 8
- Rocky Linux 10
- Rocky Linux 9
- Rocky Linux 8
- Debian 13
- Debian 12
- Debian 11
- Ubuntu 26.04
- Ubuntu 24.04
- Ubuntu 22.04

NOTE: By default, libvhdi-tools is not installed on RHEL based distros; so file-level restores from delta backups within XO will not work.  However, users MAY install libvhdi-tools via a small, third-party maintained by a user of XenOrchestraInstallerUpdater specifically for XenOrchestraInstallerUpdater in order to re-enable file-level restore. To do so, set the INSTALL_EL_LIBVHDI variable to "true" in xo-install.cfg.  See: https://github.com/ronivay/XenOrchestraInstallerUpdater/pull/274

Only x86_64 architecture is supported. For all those raspberry pi users out there, check [container](https://hub.docker.com/r/ronivay/xen-orchestra) instead.

All OS/Architecture checks can be disabled in `xo-install.cfg` for experimental purposes. Not recommended obviously.

I suggest using a fresh OS installation, let script install all necessary dependencies and dedicate the VM for running Xen Orchestra.

If you plan on using the prebuilt VM image for XenServer/XCP-ng, see the image section below.

### Installation

Start by cloning this repository to the machine you wish to install to.

See [Wiki](https://github.com/ronivay/XenOrchestraInstallerUpdater/wiki) for common configuration options

There is a file called `sample.xo-install.cfg` which you should copy as `xo-install.cfg`. This file holds some editable configuration settings you might want to change depending on your needs.

By default Xen Orchestra is served over HTTPS on port 443 with a self-signed certificate that xo-server generates to `/opt/xo/xo.crt` and `/opt/xo/xo.key`, and plain HTTP on port 80 redirects to it. Replace the certificate files with your own, use `ACME` for Let's Encrypt, or comment out `PATH_TO_HTTPS_CERT`/`PATH_TO_HTTPS_KEY` for plain HTTP. Existing `xo-install.cfg` files keep their current settings.

When done editing configuration, just run the script with root privileges:
```
sudo ./xo-install.sh
```

There are few options you can choose from:

* `Install`

install all dependencies, necessary configuration and xen orchestra itself
* `Update`

update existing installation to the newest version available
* `Rollback`

should be self explanatory. if you wish to rollback to another installation after doing update or whatever

* `Install proxy`

install all dependencies, necessary configuration and xen orchestra backup proxy

* `Update proxy`

update existing proxy installation to newest version available


Each of these options can be run non interactively like so:

```
sudo ./xo-install.sh --install [--proxy]
sudo ./xo-install.sh --update [--proxy] [--force]
sudo ./xo-install.sh --rollback
```

As mentioned before, Xen Orchestra has some external dependencies from different operating system packages. All listed below will be installed if missing:

```
rpm:
- curl
- epel-release
- nodejs (v14)
- npm (v3)
- yarn
- gcc
- gcc+
- make
- openssl-devel
- redis (valkey if os version >=10)
- libpng-devel
- python3
- git
- nfs-utils
- libvhdi-tools
- cifs-utils
- lvm2
- ntfs-3g
- dmidecode
- sudo (if set in xo-install.cfg)
- patch

deb:
- apt-transport-https
- ca-certificates
- libcap2-bin
- curl
- yarn
- nodejs (v14)
- npm (v3)
- build-essential
- redis-server
- libpng-dev
- git
- python3-minimal
- libvhdi-utils
- lvm2
- nfs-common
- cifs-utils
- gnupg (debian 10/11/12/13)
- software-properties-common (ubuntu)
- ntfs-3g
- dmidecode
- sudo (if set in xo-install.cfg)
- patch
- libfuse2t64 (debian 13)
```

Following repositories will be installed if needed and repository install is enabled in xo-install.cfg

```
rpm:
- forensics repository
- epel repository
- nodesource repository
- yarn repository

deb:
- universe repository (ubuntu)
- nodesource repository
- yarn repository
```


#### Backup proxy

**Proxy installation method is experimental, use at your own risk. Proxy installation from sources is not documented by Xen Orchestra team. Method used here is the outcome of trial and error.**

**Proxy source code will be edited slightly to disable license check which only works with official XOA and there is no documented or working procedure to bypass it properly (there used to be but not anymore)**

Backup proxy can be used to offload backup tasks from the main Xen Orchestra instance to a proxy which has a direct connection to remote where backups are stored.

Requirements for proxy VM are otherwise the same as mentioned above, in addition proxy needs to be able to connect your XCP-ng/XenServer host and Xen Orchestra server needs to be able to access proxy via configured port. By default, it is expected that proxy VM lives inside your XO managed XCP-ng/XenServer pool and XO will figure out the proper connection address with proxy VM's uuid and will use port 443 by default. If you've installed your proxy outside of XCP-ng/XenServer pool and/or you're using some other port, you need to edit the proxy server address from Proxies menu after importing the configuration.

Majority of xo-install.cfg variables have no effect to proxy installation.

Since there is no way in Xen Orchestra from sources to register a proxy via UI, the installation will output a piece of json after the proxy is installed. You need to copy this json string and save to a file. Then use the config import option in Xen Orchestra settings to import this piece of json to add proxy. This works as a partial config import and won't overwrite any existing config. Although it's good to take a config export backup just in case.

Note that for obvious reasons some of the proxy features seen in Xen Orchestra UI aren't working, like upgrade button, upgrade check, redeploy, update appliance settings.

#### Plugins

Plugins are installed according to what is specified in `PLUGINS` variable inside `xo-install.cfg` configuration file. By default all available plugins that are part of xen orchestra repository are installed. This list can be narrowed down if needed and 3rd party plugins included.

### Image

If you don't want to first install a VM and then use `xo-install.sh` script on it, you have the possibility to import VM image which has everything already setup. Use `xo-vm-import.sh` to do this, it'll download a prebuilt Debian 11 image which has Xen Orchestra and XenOrchestraInstallerUpdater installed.

Details of image build process [here](https://github.com/ronivay/xen-orchestra-vm)

Run on your Xenserver/XCP-ng host with root privileges:

```
sudo bash -c "$(curl -s https://raw.githubusercontent.com/ronivay/XenOrchestraInstallerUpdater/master/xo-vm-import.sh)"
```

Default username for UI is `admin@admin.net` with password `admin`

SSH is accessible with username `xo` with password `xopass`

Remember to change both passwords before putting the VM to actual use.

Xen Orchestra is installed to /opt/xo, it uses self-signed certificates from /opt/ssl which you can replace if you wish. Installation script is at /opt/XenOrchestraInstallerUpdater which you can use to update existing installation in the future.

xo-server runs as a systemd service.

xo user has full sudo access. Xen Orchestra updates etc should be ran with sudo.

This image is updated weekly. Latest build date and MD5/SHA256 checksum can be checked from [here](https://xo-image.yawn.fi/downloads/image.txt)

Built and tested on XCP-ng 8.x

`xo-vm-import.sh` itself can also be run unattended by setting `XO_VM_NETWORK`, `XO_VM_SR`, `XO_VM_IP` (and `XO_VM_NETMASK`, `XO_VM_GATEWAY`, `XO_VM_DNS` for a static address) and optionally `XO_VM_NAME`.

### Remote deploy over SSH

`xo-remote-deploy.sh` runs from your workstation and needs only `ssh` and `python3` locally. It connects to the XenServer/XCP-ng pool master over SSH and:

1. creates (or reuses) a network for the VM: a VLAN on a physical interface, or an existing network
2. creates a VM from an official, checksum verified cloud image: Debian 13 by default, Debian 12, Ubuntu 26.04 or Ubuntu 24.04
3. passes this repository's `xo-install.sh` and your `xo-install.cfg` (or `sample.xo-install.cfg`) to the VM with cloud-init, which installs Xen Orchestra from sources
4. waits for the installation to finish (10-20 minutes) and prints the address of the VM

Progress is reported from the VM to the host through xenstore, so the VM doesn't need to be reachable from your workstation. The VM needs internet access to download sources.

```
# new network "xo-test" tagged with VLAN 42 on eth0, VM gets address from DHCP
./xo-remote-deploy.sh -H root@xcp-host --vlan 42

# existing network by name-label, static address, Debian 12
./xo-remote-deploy.sh -H root@xcp-host --network "Pool-wide network associated with eth0" --os debian12 \
    --ip 192.168.1.50 --gateway 192.168.1.1 --dns 192.168.1.1
```

SSH user in the VM is `xo` with your `~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub` key (or `--ssh-key`). A random password is generated and printed if no key is found. Ubuntu images are published as qcow2 and need `qemu-img` locally for conversion.

The verified image is kept on the SR as a disk named `xo-remote-deploy cache: <image>` and each VM gets a clone of it, so the image is downloaded again only when a newer one is published (the outdated cached copy is removed then). The cached disk is safe to delete, use `--no-cache` to skip caching.

`--prebuilt` imports the prebuilt image with `xo-vm-import.sh` instead. Note that the prebuilt image is based on Debian 11 which is end of life.

See `./xo-remote-deploy.sh --help` for all options (vCPUs, memory, disk size, SR, timeout). `--print` shows the script that would be run on the host. Extra SSH options can be passed with `SSH_OPTS`, e.g. `SSH_OPTS="-p 2222 -i ~/.ssh/xcp"`.

### Tests and VM image

I run my own little implementation of automation consisting of ansible and virtual machines to test the installation on a regular basis with different operating systems. Test results are visible in badges on top of this readme.

VM image is also built from scratch by me and distributed from an object storage.


### Contributing

Pull requests and issues (either real issues or just suggestions) are more than welcome. Note that i do not wish to make any modifications to Xen Orchestra source code as part of this script.

### Support

If you find this project useful and want to support the development by covering some of the hosting costs that come from maintaining an XCP-ng server in a data center, use paypal donation link below.

[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/donate/?business=LCX7UV7LUGNY6&no_recurring=0&currency_code=EUR)
