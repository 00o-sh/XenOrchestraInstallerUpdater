#!/bin/bash

#########################################################################
# Title: XenOrchestraInstallerUpdater                                   #
# Author: Roni Väyrynen                                                 #
# Repository: https://github.com/ronivay/XenOrchestraInstallerUpdater   #
#########################################################################

# Run from your workstation. Connects to a XenServer/XCP-ng host over ssh, creates (or reuses) a
# network for the VM, creates a VM from an official Debian/Ubuntu cloud image and installs
# Xen Orchestra from sources inside it with xo-install.sh. Cloud-init drives the installation and
# reports progress back to the host through xenstore, so the VM doesn't need to be reachable from here.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TARGET=""
NET_NAME="xo-test"
NET_VLAN=""
NET_PIF="eth0"
NET_INTERNAL="false"
NET_EXISTING=""
VM_OS="debian13"
VM_SR="default"
VM_NAME="xo-test"
VM_CPUS="2"
VM_MEMORY="4096"
VM_DISK="20"
VM_IP="dhcp"
VM_NETMASK="255.255.255.0"
VM_GATEWAY=""
VM_DNS="8.8.8.8"
SSH_KEY=""
XO_CONFIG=""
WAIT_TIMEOUT="60"
USE_PREBUILT="false"
USE_CACHE="true"
PRINT_ONLY="false"

function Usage {
    cat <<EOF
Usage: $(basename "$0") -H [user@]host [options]

Connects to a XenServer/XCP-ng host over ssh, sets up a network and creates a VM
from an official cloud image with Xen Orchestra installed from sources.

Required:
  -H, --host [user@]host     XenServer/XCP-ng pool master to ssh into as root

Network (exactly one of --vlan, --internal or --network is required):
  --vlan ID                  create network "--network-name" tagged with VLAN ID on "--pif" (default: $NET_PIF)
  --internal                 create an isolated host-internal network (no uplink, only with --prebuilt)
  --network NAME             use an existing network by name-label instead of creating one
  --network-name NAME        name-label of the network to create/reuse (default: $NET_NAME)
  --pif DEVICE               physical interface used for the VLAN (default: $NET_PIF)

VM:
  --os OS                    debian13, debian12, ubuntu2604 or ubuntu2404 (default: $VM_OS)
                             ubuntu images need qemu-img on this machine to convert them
  --name NAME                VM name-label and hostname (default: $VM_NAME)
  --sr UUID                  storage repository uuid (default: pool default SR)
  --cpus N                   vCPUs (default: $VM_CPUS)
  --memory MiB               memory in MiB (default: $VM_MEMORY)
  --disk GiB                 disk size in GiB (default: $VM_DISK)
  --ip ADDRESS               static ip-address (default: dhcp)
  --netmask MASK             netmask for static ip-address (default: $VM_NETMASK)
  --gateway ADDRESS          gateway for static ip-address
  --dns ADDRESS              dns server for static ip-address (default: $VM_DNS)
  --ssh-key FILE             public key for user "xo" (default: ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub,
                             a random password is generated if none is found)

Xen Orchestra:
  --config FILE              xo-install.cfg used inside the VM (default: ./xo-install.cfg or sample.xo-install.cfg)
  --timeout MIN              minutes to wait for the installation to finish (default: $WAIT_TIMEOUT)
  --no-cache                 don't use or keep a cached copy of the image on the host. By default the image is
                             kept on the SR as "xo-remote-deploy cache: <image>" and downloaded again only when
                             a newer image is published
  --prebuilt                 import the prebuilt Debian 11 image with xo-vm-import.sh instead (not recommended,
                             Debian 11 is end of life)

Other:
  --print                    print the script that would be run on the host and exit
  -h, --help                 show this help

Extra ssh options can be given with SSH_OPTS, e.g. SSH_OPTS="-p 2222 -i ~/.ssh/xcp"
EOF
}

function HandleArgs {

    OPTS=$(getopt -o H:h --long host:,vlan:,internal,network:,network-name:,pif:,os:,name:,sr:,cpus:,memory:,disk:,ip:,netmask:,gateway:,dns:,ssh-key:,config:,timeout:,no-cache,prebuilt,print,help -- "$@")

    #shellcheck disable=SC2181
    if [[ $? != 0 ]]; then
        Usage
        exit 1
    fi

    eval set -- "$OPTS"

    while true; do
        case "$1" in
            -H | --host)
                TARGET="$2"
                shift 2
                ;;
            --vlan)
                NET_VLAN="$2"
                shift 2
                ;;
            --internal)
                NET_INTERNAL="true"
                shift
                ;;
            --network)
                NET_EXISTING="$2"
                shift 2
                ;;
            --network-name)
                NET_NAME="$2"
                shift 2
                ;;
            --pif)
                NET_PIF="$2"
                shift 2
                ;;
            --os)
                VM_OS="$2"
                shift 2
                ;;
            --name)
                VM_NAME="$2"
                shift 2
                ;;
            --sr)
                VM_SR="$2"
                shift 2
                ;;
            --cpus)
                VM_CPUS="$2"
                shift 2
                ;;
            --memory)
                VM_MEMORY="$2"
                shift 2
                ;;
            --disk)
                VM_DISK="$2"
                shift 2
                ;;
            --ip)
                VM_IP="$2"
                shift 2
                ;;
            --netmask)
                VM_NETMASK="$2"
                shift 2
                ;;
            --gateway)
                VM_GATEWAY="$2"
                shift 2
                ;;
            --dns)
                VM_DNS="$2"
                shift 2
                ;;
            --ssh-key)
                SSH_KEY="$2"
                shift 2
                ;;
            --config)
                XO_CONFIG="$2"
                shift 2
                ;;
            --timeout)
                WAIT_TIMEOUT="$2"
                shift 2
                ;;
            --no-cache)
                USE_CACHE="false"
                shift
                ;;
            --prebuilt)
                USE_PREBUILT="true"
                shift
                ;;
            --print)
                PRINT_ONLY="true"
                shift
                ;;
            -h | --help)
                Usage
                exit 0
                ;;
            --)
                shift
                break
                ;;
        esac
    done

}

function CheckArgs {

    local ipregex="^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$"

    if [[ -z "$TARGET" ]]; then
        echo "Define host to connect to with -H/--host"
        exit 1
    fi

    local modes=0
    [[ -n "$NET_VLAN" ]] && ((modes++))
    [[ "$NET_INTERNAL" == "true" ]] && ((modes++))
    [[ -n "$NET_EXISTING" ]] && ((modes++))

    # a plain network without VLAN or uplink is isolated, so it has to be asked for explicitly
    if [[ "$modes" -ne 1 ]]; then
        echo "Define exactly one of --vlan, --internal or --network"
        exit 1
    fi

    if [[ -n "$NET_VLAN" ]] && ! [[ "$NET_VLAN" =~ ^[0-9]+$ && "$NET_VLAN" -ge 1 && "$NET_VLAN" -le 4094 ]]; then
        echo "VLAN ID must be a number between 1-4094"
        exit 1
    fi

    # there's no DHCP server on an internal network
    if [[ "$NET_INTERNAL" == "true" ]] && [[ "$VM_IP" == "dhcp" ]]; then
        echo "--internal network has no DHCP, define static address with --ip"
        exit 1
    fi

    # sources are downloaded during installation so the VM needs internet access
    if [[ "$NET_INTERNAL" == "true" ]] && [[ "$USE_PREBUILT" != "true" ]]; then
        echo "--internal network has no internet access for building Xen Orchestra, use it with --prebuilt"
        exit 1
    fi

    if [[ "$VM_IP" != "dhcp" ]]; then
        if ! [[ "$VM_IP" =~ $ipregex && "$VM_NETMASK" =~ $ipregex && "$VM_DNS" =~ $ipregex ]] || ! [[ -z "$VM_GATEWAY" || "$VM_GATEWAY" =~ $ipregex ]]; then
            echo "Check --ip, --netmask, --gateway and --dns format"
            exit 1
        fi
    fi

    if [[ "$USE_PREBUILT" == "true" ]]; then
        if [[ ! -f "$SCRIPT_DIR/xo-vm-import.sh" ]]; then
            echo "$SCRIPT_DIR/xo-vm-import.sh not found. Run this script from the repository directory"
            exit 1
        fi
        return 0
    fi

    # image variables are passed to the host in SettingsScript
    # shellcheck disable=SC2034
    case "$VM_OS" in
        debian13)
            IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.raw"
            IMAGE_SUMS="https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS"
            IMAGE_SUM_ALGO="sha512"
            ;;
        debian12)
            IMAGE_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.raw"
            IMAGE_SUMS="https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS"
            IMAGE_SUM_ALGO="sha512"
            ;;
        ubuntu2604)
            IMAGE_URL="https://cloud-images.ubuntu.com/resolute/current/resolute-server-cloudimg-amd64.img"
            IMAGE_SUMS="https://cloud-images.ubuntu.com/resolute/current/SHA256SUMS"
            IMAGE_SUM_ALGO="sha256"
            ;;
        ubuntu2404)
            IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
            IMAGE_SUMS="https://cloud-images.ubuntu.com/noble/current/SHA256SUMS"
            IMAGE_SUM_ALGO="sha256"
            ;;
        *)
            echo "Unsupported --os $VM_OS. Use debian13, debian12, ubuntu2604 or ubuntu2404"
            exit 1
            ;;
    esac

    # ubuntu publishes bootable cloud images only as qcow2 which xapi can't import as is
    if [[ "$VM_OS" == ubuntu* ]] && [[ -z $(command -v qemu-img 2>/dev/null) ]]; then
        echo "--os $VM_OS needs qemu-img on this machine to convert the image. Install qemu-utils/qemu or use --os debian13"
        exit 1
    fi

    if ! [[ "$VM_CPUS" =~ ^[0-9]+$ && "$VM_MEMORY" =~ ^[0-9]+$ && "$VM_DISK" =~ ^[0-9]+$ && "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]]; then
        echo "--cpus, --memory, --disk and --timeout must be numbers"
        exit 1
    fi

    if [[ "$VM_MEMORY" -lt 3072 ]]; then
        echo "Warning: building Xen Orchestra with less than 3072 MiB of memory will likely fail"
    fi

    if [[ "$VM_DISK" -lt 10 ]]; then
        echo "--disk must be at least 10 GiB"
        exit 1
    fi

    if [[ -z $(command -v python3 2>/dev/null) ]]; then
        echo "python3 is needed on this machine to build the cloud-init seed"
        exit 1
    fi

    if [[ -z "$XO_CONFIG" ]]; then
        if [[ -s "$SCRIPT_DIR/xo-install.cfg" ]]; then
            XO_CONFIG="$SCRIPT_DIR/xo-install.cfg"
        else
            XO_CONFIG="$SCRIPT_DIR/sample.xo-install.cfg"
        fi
    fi

    if [[ ! -f "$XO_CONFIG" ]] || [[ ! -f "$SCRIPT_DIR/xo-install.sh" ]]; then
        echo "xo-install.sh or $XO_CONFIG not found. Run this script from the repository directory"
        exit 1
    fi

    if [[ -z "$SSH_KEY" ]]; then
        for key in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
            if [[ -f "$key" ]]; then
                SSH_KEY="$key"
                break
            fi
        done
    elif [[ ! -f "$SSH_KEY" ]]; then
        echo "$SSH_KEY not found"
        exit 1
    fi

    if [[ -z "$SSH_KEY" ]]; then
        VM_PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
    fi

}

# network setup run on the host. sets XO_VM_NETWORK
function NetworkScript {
    cat <<'EOF'
set -eo pipefail

if [[ -z $(command -v xe 2>/dev/null) ]]; then
    echo "xe command not found. Make sure target is a XenServer/XCP-ng host"
    exit 1
fi

[[ -n "$STAGE_NET" ]] && echo "[$STAGE_NET/6] Setting up network"

if [[ -n "$NET_EXISTING" ]]; then
    XO_VM_NETWORK=$(xe network-list name-label="$NET_EXISTING" --minimal)
    if [[ -z "$XO_VM_NETWORK" ]] || [[ "$XO_VM_NETWORK" == *,* ]]; then
        echo "Expected exactly one network with name-label \"$NET_EXISTING\", found: ${XO_VM_NETWORK:-none}"
        exit 1
    fi
    echo "Using existing network $NET_EXISTING ($XO_VM_NETWORK)"
else
    XO_VM_NETWORK=$(xe network-list name-label="$NET_NAME" --minimal)
    if [[ "$XO_VM_NETWORK" == *,* ]]; then
        echo "Multiple networks with name-label \"$NET_NAME\" found, use a different --network-name"
        exit 1
    fi

    if [[ -n "$XO_VM_NETWORK" ]]; then
        echo "Network $NET_NAME already exists ($XO_VM_NETWORK), reusing it"
    elif [[ -n "$NET_VLAN" ]]; then
        master=$(xe pool-list params=master --minimal)
        pif=$(xe pif-list host-uuid="$master" device="$NET_PIF" VLAN=-1 --minimal)
        if [[ -z "$pif" ]]; then
            echo "Physical interface $NET_PIF not found on pool master"
            exit 1
        fi
        # a VLAN can exist only once per interface, so reuse its network if it's already there
        vlan_network=$(xe pif-list host-uuid="$master" device="$NET_PIF" VLAN="$NET_VLAN" params=network-uuid --minimal)
        if [[ -n "$vlan_network" ]]; then
            XO_VM_NETWORK="$vlan_network"
            echo "VLAN $NET_VLAN already exists on $NET_PIF, reusing network $(xe network-param-get uuid="$XO_VM_NETWORK" param-name=name-label) ($XO_VM_NETWORK)"
        else
            XO_VM_NETWORK=$(xe network-create name-label="$NET_NAME" name-description="Xen Orchestra test network, VLAN $NET_VLAN")
            if ! xe pool-vlan-create network-uuid="$XO_VM_NETWORK" pif-uuid="$pif" vlan="$NET_VLAN" >/dev/null; then
                xe network-destroy uuid="$XO_VM_NETWORK"
                echo "Failed to create VLAN $NET_VLAN on $NET_PIF"
                exit 1
            fi
            echo "Created network $NET_NAME on $NET_PIF VLAN $NET_VLAN ($XO_VM_NETWORK)"
        fi
    else
        XO_VM_NETWORK=$(xe network-create name-label="$NET_NAME" name-description="Xen Orchestra internal test network")
        echo "Created internal network $NET_NAME ($XO_VM_NETWORK)"
    fi
fi

export XO_VM_NETWORK
EOF
}

# VM creation and installation progress monitoring run on the host after NetworkScript
function DeployScript {
    cat <<'EOF'
if [[ -n $(xe vm-list name-label="$VM_NAME" --minimal) ]]; then
    echo "VM with name-label \"$VM_NAME\" already exists. Remove it or use --name"
    exit 1
fi

if [[ "$VM_SR" == "default" ]]; then
    SR=$(xe pool-param-get uuid="$(xe pool-list --minimal)" param-name=default-SR)
else
    SR="$VM_SR"
fi
if [[ -z "$SR" ]] || [[ -z $(xe sr-list uuid="$SR" --minimal 2>/dev/null) ]]; then
    echo "Storage repository not found. Set pool default SR or use --sr"
    exit 1
fi

VM=""
CREATED_VDIS=()
TMPDIR=$(mktemp -d)

# remove everything created so far if any step fails before the VM is started
function Cleanup {
    local rc=$?
    trap - ERR
    echo "Deployment failed, removing created VM and disks"
    [[ -n "$VM" ]] && xe vm-uninstall uuid="$VM" force=true >/dev/null 2>&1
    for vdi in "${CREATED_VDIS[@]}"; do
        xe vdi-destroy uuid="$vdi" >/dev/null 2>&1
    done
    rm -rf "$TMPDIR"
    exit "$rc"
}
trap Cleanup ERR

# imported images are kept on the SR as cached base disks and VMs get clones of them. checksum of the
# latest published image is the cache key, so a new download happens only when the image is updated
IMAGE_FILE="${IMAGE_URL##*/}"
CACHE_LABEL="xo-remote-deploy cache: $IMAGE_FILE"
if [[ -z "$IMAGE_SHA" ]]; then
    IMAGE_SHA=$(curl -fsSL "$IMAGE_SUMS" | awk -v f="$IMAGE_FILE" '$2==f || $2=="*"f {print $1}')
fi
if [[ -z "$IMAGE_SHA" ]]; then
    echo "Couldn't get checksum of $IMAGE_FILE from $IMAGE_SUMS"
    false
fi

BASE=""
if [[ "$USE_CACHE" == "true" ]]; then
    for vdi in $(xe vdi-list sr-uuid="$SR" name-label="$CACHE_LABEL" --minimal | tr ',' ' '); do
        if [[ -z "$BASE" ]] && [[ "$(xe vdi-param-get uuid="$vdi" param-name=other-config param-key=xo-deploy-image-sha 2>/dev/null)" == "$IMAGE_SHA" ]]; then
            BASE="$vdi"
        elif xe vdi-destroy uuid="$vdi" >/dev/null 2>&1; then
            # clones made from it stay intact
            echo "  Removed outdated cached image ($vdi)"
        fi
    done
fi

if [[ -n "$BASE" ]]; then
    # for ubuntu image stage is shown already before uploading
    [[ "$STAGE_NET" == "1" ]] && echo "[2/6] Using cached $VM_OS image ($BASE), it matches the latest published image"
elif [[ -n "$IMAGE_VDI" ]]; then
    BASE="$IMAGE_VDI"
    CREATED_VDIS+=("$BASE")
else
    echo "[2/6] Downloading and importing $VM_OS image"
    echo "  $IMAGE_URL"
    size=$(curl -fsSIL "$IMAGE_URL" | tr -d '\r' | awk 'tolower($1)=="content-length:" {s=$2} END {print s+0}')
    if [[ "$size" -le 0 ]]; then
        echo "Failed to get image size"
        false
    fi
    BASE=$(xe vdi-create sr-uuid="$SR" name-label="$VM_NAME disk" type=user virtual-size="$size")
    CREATED_VDIS+=("$BASE")
    # mirror redirect is resolved first so progress is shown for one transfer only
    url=$(curl -fsSIL -o /dev/null -w '%{url_effective}' "$IMAGE_URL")
    # progress bar redraws don't work over ssh without a terminal, print plain lines every 10% instead
    curl -f -# "$url" 2> >(awk -v RS='\r' '/curl:/ {print; fflush(); next} match($0, /[0-9]+\.[0-9]%/) {p=int(substr($0, RSTART, RLENGTH-1)); if (p >= next_p) {printf "  downloaded %d%%\n", p; fflush(); next_p = p - p % 10 + 10}}' >&2) | tee >("${IMAGE_SUM_ALGO}sum" | awk '{print $1}' >"$TMPDIR/sum") | xe vdi-import uuid="$BASE" filename=/dev/stdin format=raw
    # checksum is written by a background process, give it a moment to finish
    for _ in {1..30}; do
        [[ -s "$TMPDIR/sum" ]] && break
        sleep 1
    done
    if [[ "$(cat "$TMPDIR/sum")" != "$IMAGE_SHA" ]]; then
        echo "Image checksum verification failed"
        false
    fi
    echo "  Image imported and checksum verified"
fi

if [[ "$USE_CACHE" == "true" ]]; then
    if [[ "${CREATED_VDIS[*]}" == *"$BASE"* ]]; then
        # verified fresh import becomes the cached base, it's kept even if a later step fails
        xe vdi-param-set uuid="$BASE" name-label="$CACHE_LABEL" name-description="Base image cached by xo-remote-deploy.sh, safe to delete" other-config:xo-deploy-image-sha="$IMAGE_SHA"
        CREATED_VDIS=()
        echo "  Image cached on SR for next deployments"
    fi
    DISK=$(xe vdi-clone uuid="$BASE" new-name-label="$VM_NAME disk")
    CREATED_VDIS+=("$DISK")
else
    DISK="$BASE"
    xe vdi-param-set uuid="$DISK" name-label="$VM_NAME disk"
fi

xe vdi-resize uuid="$DISK" disk-size="${VM_DISK}GiB"

# cloud-init NoCloud seed is attached as a small extra disk, no ISO SR needed
echo "$SEED_B64" | base64 -d >"$TMPDIR/seed.iso"
SEED=$(xe vdi-create sr-uuid="$SR" name-label="$VM_NAME cloud-init" type=user virtual-size=64MiB)
CREATED_VDIS+=("$SEED")
xe vdi-import uuid="$SEED" filename="$TMPDIR/seed.iso" format=raw

echo "[3/6] Creating and starting VM $VM_NAME"
VM=$(xe vm-install template="Other install media" new-name-label="$VM_NAME" sr-uuid="$SR")
xe vm-param-set uuid="$VM" name-description="Xen Orchestra from sources, deployed with xo-remote-deploy.sh"

# drop any disks provisioned by the template, image disk is used instead
for vbd in $(xe vbd-list vm-uuid="$VM" type=Disk --minimal | tr ',' ' '); do
    vdi=$(xe vbd-param-get uuid="$vbd" param-name=vdi-uuid)
    xe vbd-destroy uuid="$vbd"
    xe vdi-destroy uuid="$vdi"
done

xe vm-memory-limits-set uuid="$VM" static-min="${VM_MEMORY}MiB" dynamic-min="${VM_MEMORY}MiB" dynamic-max="${VM_MEMORY}MiB" static-max="${VM_MEMORY}MiB"
xe vm-param-set uuid="$VM" VCPUs-max="$VM_CPUS"
xe vm-param-set uuid="$VM" VCPUs-at-startup="$VM_CPUS"
xe vbd-create vm-uuid="$VM" vdi-uuid="$DISK" device=0 bootable=true mode=RW type=Disk >/dev/null
xe vbd-create vm-uuid="$VM" vdi-uuid="$SEED" device=1 mode=RW type=Disk >/dev/null
xe vif-create vm-uuid="$VM" network-uuid="$XO_VM_NETWORK" device=0 >/dev/null
xe vm-param-remove uuid="$VM" param-name=HVM-boot-params param-key=order 2>/dev/null || true
xe vm-param-set uuid="$VM" HVM-boot-params:order=c

echo "  VM $VM created with ${VM_CPUS} vCPU, ${VM_MEMORY} MiB memory and ${VM_DISK} GiB disk, starting it"
xe vm-start uuid="$VM"

# VM is kept from this point on even if installation fails, to allow troubleshooting
trap - ERR
set +e
rm -rf "$TMPDIR"

echo "[4/6] Booting VM and running cloud-init (1-3 minutes)"

status=""
step=""
detail=""
vm_ip=""
stage=4
start=$SECONDS
last_output=$SECONDS
deadline=$((SECONDS + WAIT_TIMEOUT * 60))
while [[ "$SECONDS" -lt "$deadline" ]]; do
    domid=$(xe vm-param-get uuid="$VM" param-name=dom-id 2>/dev/null)
    current=$(xenstore-read "/local/domain/$domid/data/xo-ip" 2>/dev/null)
    if [[ -n "$current" ]] && [[ "$current" != "$vm_ip" ]]; then
        vm_ip="$current"
        echo "$(date +%H:%M:%S)   VM address: $vm_ip"
        last_output=$SECONDS
    fi
    current=$(xenstore-read "/local/domain/$domid/data/xo-install" 2>/dev/null)
    if [[ -n "$current" ]] && [[ "$stage" -lt 5 ]]; then
        stage=5
        echo "[5/6] Installing dependencies: packages, node.js and yarn (3-6 minutes)"
        last_output=$SECONDS
    fi
    new_status="$current"
    current=$(xenstore-read "/local/domain/$domid/data/xo-step" 2>/dev/null)
    if [[ -n "$current" ]] && [[ "$current" != "$step" ]]; then
        step="$current"
        if [[ "$step" == *"Fetching Xen Orchestra source code"* || "$step" == *"Running installation"* ]] && [[ "$stage" -lt 6 ]]; then
            stage=6
            echo "[6/6] Building and starting Xen Orchestra (about 10 minutes)"
        fi
        echo "$(date +%H:%M:%S)   $step"
        last_output=$SECONDS
    fi
    detail=$(xenstore-read "/local/domain/$domid/data/xo-detail" 2>/dev/null)
    if [[ "$new_status" == "done" ]] || [[ "$new_status" == "failed" ]]; then
        status="$new_status"
        echo "$(date +%H:%M:%S) Installation $status"
    elif [[ -n "$new_status" ]]; then
        status="$new_status"
    fi
    if [[ "$status" == "done" ]] || [[ "$status" == "failed" ]]; then
        break
    fi
    # some steps take several minutes without output, show that things are still progressing
    if [[ $((SECONDS - last_output)) -ge 60 ]]; then
        echo "$(date +%H:%M:%S)   ...still working ($(((SECONDS - start) / 60)) min elapsed)${detail:+, $detail}"
        last_output=$SECONDS
    fi
    sleep 5
done

ip=$(xenstore-read "/local/domain/$domid/data/xo-ip" 2>/dev/null)
if [[ -z "$ip" ]]; then
    ip=$(xe vm-param-get uuid="$VM" param-name=networks param-key=0/ip 2>/dev/null)
fi

if [[ "$status" == "done" ]]; then
    # seed holds credentials and is not needed anymore
    seed_vbd=$(xe vbd-list vdi-uuid="$SEED" --minimal)
    if xe vbd-unplug uuid="$seed_vbd" >/dev/null 2>&1 && xe vbd-destroy uuid="$seed_vbd" && xe vdi-destroy uuid="$SEED"; then
        echo "Removed cloud-init seed disk"
    else
        echo "Couldn't detach cloud-init seed disk \"$VM_NAME cloud-init\", remove it manually"
    fi
fi

echo "XO_DEPLOY_RESULT status=${status:-unknown} ip=${ip:-unknown} vm=$VM"
EOF
}

# cloud-init NoCloud seed as a base64 encoded ISO9660 image with volume label cidata
function BuildSeed {
    local pubkey=""
    [[ -n "$SSH_KEY" ]] && pubkey=$(cat "$SSH_KEY")

    VM_NAME="$VM_NAME" VM_IP="$VM_IP" VM_NETMASK="$VM_NETMASK" VM_GATEWAY="$VM_GATEWAY" VM_DNS="$VM_DNS" \
        VM_PASSWORD="$VM_PASSWORD" PUBKEY="$pubkey" XO_CONFIG="$XO_CONFIG" XO_SCRIPT="$SCRIPT_DIR/xo-install.sh" GUEST_AGENT="$GUEST_AGENT" PLUGINS_DIR="$SCRIPT_DIR/plugins" \
        python3 - <<'PYEOF'
import base64, gzip, json, os, struct, uuid

env = os.environ

def gzb64(path, extra=b"", prefix=b""):
    with open(path, "rb") as f:
        return base64.b64encode(gzip.compress(prefix + f.read() + extra)).decode()

# runs inside the VM. reports progress to xenstore where the host script reads it
run_sh = r"""#!/bin/bash
# output ends up in /var/log/cloud-init-output.log and VM console
report() {
    echo "xo-installer: $1=$2"
    xenstore-write "data/$1" "$2" >/dev/null 2>&1 || true
}
echo 'DPkg::Lock::Timeout "600";' >/etc/apt/apt.conf.d/90xo-lock-timeout
# guest agent reports ip-address, memory etc. to XCP-ng. package comes from the host's guest tools ISO
if [[ -f /opt/xo-installer/guest-agent.deb ]]; then
    apt-get install -y /opt/xo-installer/guest-agent.deb >/dev/null 2>&1 && echo "xo-installer: guest agent installed"
else
    apt-get install -y xe-guest-utilities >/dev/null 2>&1 || true
fi
report xo-ip "$(hostname -I | awk '{print $1}')"
report xo-install installing
cd /opt/xo-installer || exit 1
./xo-install.sh --install >/var/log/xo-install.log 2>&1 &
pid=$!
# forward latest installer step, e.g. "[ok] Running apt-get update", for the host to show
last=""
last_detail=""
while kill -0 "$pid" 2>/dev/null; do
    # finer progress: packages being built by running node processes, turbo hides their output.
    # otherwise the yarn phase, taken only from output of the command currently running
    detail=$(for p in $(pgrep -x node); do readlink "/proc/$p/cwd"; done 2>/dev/null |
        grep -oE '/xo-builds/[^/]+/(packages/[^/]+|@[^/]+/[^/]+)' | sed -E 's#^/xo-builds/[^/]+/(packages/)?##' |
        sort -u | head -n 3 | paste -sd, - | sed 's/,/, /g')
    if [[ -n "$detail" ]]; then
        detail="building $detail"
    else
        detail=$(ls -t /opt/xo-installer/logs/xo-install.log-* 2>/dev/null | head -n 1 | xargs -r tail -n 2000 2>/dev/null |
            awk '/^\+ / {n = 0} {lines[n++] = $0} END {for (i = 0; i < n; i++) print lines[i]}' |
            sed 's/\x1b\[[0-9;]*m//g' | grep -E '^\[[0-9]/[0-9]\] ' | tail -n 1 |
            sed -E 's/^\[[0-9]\/[0-9]\] /yarn: /' | cut -c 1-100)
    fi
    # empty value clears outdated detail on the host
    if [[ "$detail" != "$last_detail" ]]; then
        xenstore-write data/xo-detail "$detail" >/dev/null 2>&1 || true
        last_detail="$detail"
    fi
    step=$(tr '\r' '\n' </var/log/xo-install.log | sed 's/\x1b\[[0-9;]*m//g' | grep '^\[' | tail -n 1 | cut -c 1-200)
    if [[ -n "$step" ]] && [[ "$step" != "$last" ]]; then
        report xo-step "$step"
        last="$step"
    fi
    sleep 5
done
wait "$pid"
report xo-ip "$(hostname -I | awk '{print $1}')"
if systemctl is-active --quiet xo-server; then
    report xo-install done
else
    tail -n 20 /var/log/xo-install.log
    report xo-install failed
fi
"""

user = {
    "name": "xo",
    "groups": ["sudo"],
    "shell": "/bin/bash",
    "sudo": "ALL=(ALL) NOPASSWD:ALL",
    "lock_passwd": not env["VM_PASSWORD"],
}
if env["VM_PASSWORD"]:
    user["plain_text_passwd"] = env["VM_PASSWORD"]
if env["PUBKEY"]:
    user["ssh_authorized_keys"] = [env["PUBKEY"].strip()]

userdata = {
    "hostname": env["VM_NAME"],
    "users": [user],
    "package_update": True,
    "packages": ["xenstore-utils", "curl", "ca-certificates"],
    "write_files": [
        {"path": "/opt/xo-installer/xo-install.sh", "encoding": "gz+b64", "permissions": "0755",
         "content": gzb64(env["XO_SCRIPT"])},
        # self upgrade needs a git checkout of upstream repository which isn't the case here
        {"path": "/opt/xo-installer/xo-install.cfg", "encoding": "gz+b64", "permissions": "0600",
         "content": gzb64(env["XO_CONFIG"], b"\nSELFUPGRADE=false\n",
                          # update plugin is enabled unless the config sets BUNDLED_PLUGINS itself
                          b'BUNDLED_PLUGINS="xo-server-installer-updates"\n')},
        {"path": "/opt/xo-installer/run.sh", "permissions": "0755", "content": run_sh},
    ],
    "runcmd": [["bash", "/opt/xo-installer/run.sh"]],
}
# plugins bundled in this repository, xo-install.sh adds them to the build according to BUNDLED_PLUGINS
plugins_dir = env["PLUGINS_DIR"]
if os.path.isdir(plugins_dir):
    for root, dirs, names in os.walk(plugins_dir):
        dirs[:] = [d for d in dirs if d not in ("test", "node_modules")]
        for name in names:
            src = os.path.join(root, name)
            userdata["write_files"].append({"path": "/opt/xo-installer/plugins/" + os.path.relpath(src, plugins_dir),
                                            "encoding": "gz+b64", "content": gzb64(src)})
if env["GUEST_AGENT"]:
    with open(env["GUEST_AGENT"], "rb") as f:
        userdata["write_files"].append({"path": "/opt/xo-installer/guest-agent.deb", "encoding": "b64",
                                        "content": base64.b64encode(f.read()).decode()})
if env["VM_PASSWORD"]:
    userdata["ssh_pwauth"] = True

eth = {"match": {"name": "e*"}}
if env["VM_IP"] == "dhcp":
    eth["dhcp4"] = True
else:
    prefix = sum(bin(int(o)).count("1") for o in env["VM_NETMASK"].split("."))
    eth["addresses"] = ["%s/%d" % (env["VM_IP"], prefix)]
    eth["nameservers"] = {"addresses": [env["VM_DNS"]]}
    if env["VM_GATEWAY"]:
        eth["routes"] = [{"to": "default", "via": env["VM_GATEWAY"]}]

# JSON is valid YAML
files = {
    "META-DATA": json.dumps({"instance-id": "xo-" + uuid.uuid4().hex[:12], "local-hostname": env["VM_NAME"]}).encode(),
    "NETWORK-CONFIG": json.dumps({"version": 2, "ethernets": {"primary": eth}}).encode(),
    "USER-DATA": ("#cloud-config\n" + json.dumps(userdata, indent=1) + "\n").encode(),
}

# minimal ISO9660 image. Linux shows plain ISO9660 names in lowercase without version suffix,
# so USER-DATA;1 is seen as user-data
S = 2048

def both16(v):
    return struct.pack("<H", v) + struct.pack(">H", v)

def both32(v):
    return struct.pack("<I", v) + struct.pack(">I", v)

def dirrec(extent, size, flags, name):
    length = 33 + len(name) + (1 - len(name) % 2)
    rec = struct.pack("BB", length, 0) + both32(extent) + both32(size) + b"\0" * 7
    rec += struct.pack("BB", flags, 0) + b"\0" + both16(1) + struct.pack("B", len(name)) + name
    return rec + b"\0" * (length - len(rec))

names = sorted(files)
root_lba, extent = 20, 21
entries = [dirrec(root_lba, S, 2, b"\0"), dirrec(root_lba, S, 2, b"\1")]
data = b""
for n in names:
    content = files[n]
    entries.append(dirrec(extent, len(content), 0, (n + ";1").encode()))
    padded = content + b"\0" * (-len(content) % S)
    data += padded
    extent += len(padded) // S
root = b"".join(entries)
assert len(root) <= S
total = extent

def text(s, n):
    return s.encode().ljust(n, b" ")

pvd = b"\1CD001\1\0" + text("", 32) + text("cidata", 32) + b"\0" * 8 + both32(total) + b"\0" * 32
pvd += both16(1) + both16(1) + both16(S) + both32(10)
pvd += struct.pack("<I", 18) + b"\0" * 4 + struct.pack(">I", 19) + b"\0" * 4
pvd += dirrec(root_lba, S, 2, b"\0")
pvd += text("", 128) * 4 + text("", 37) * 3 + (b"0" * 16 + b"\0") * 4 + b"\1"

terminator = b"\xffCD001\1"
ptl = struct.pack("<BBIH", 1, 0, root_lba, 1) + b"\0\0"
ptm = struct.pack(">BBIH", 1, 0, root_lba, 1) + b"\0\0"

def sector(b):
    return b + b"\0" * (S - len(b))

iso = b"\0" * (16 * S) + sector(pvd) + sector(terminator) + sector(ptl) + sector(ptm) + sector(root) + data
print(base64.b64encode(iso).decode())
PYEOF
}

function SettingsScript {
    local var
    for var in NET_NAME NET_VLAN NET_PIF NET_EXISTING VM_NAME VM_SR VM_CPUS VM_MEMORY VM_DISK WAIT_TIMEOUT \
        IMAGE_URL IMAGE_SUMS IMAGE_SUM_ALGO IMAGE_VDI IMAGE_SHA USE_CACHE VM_OS STAGE_NET; do
        printf 'export %s=%q\n' "$var" "${!var}"
    done
    # not exported, environment variables are limited to 128KiB each which the seed may exceed
    printf 'SEED_B64=%q\n' "$SEED_B64"
}

# legacy mode: settings for xo-vm-import.sh and the script itself
function PrebuiltScript {
    printf 'export XO_VM_SR=%q\n' "$VM_SR"
    printf 'export XO_VM_NAME=%q\n' "$VM_NAME"
    printf 'export XO_VM_IP=%q\n' "$VM_IP"
    printf 'export XO_VM_NETMASK=%q\n' "$VM_NETMASK"
    printf 'export XO_VM_GATEWAY=%q\n' "$VM_GATEWAY"
    printf 'export XO_VM_DNS=%q\n' "$VM_DNS"
    echo "set +eo pipefail"
    cat "$SCRIPT_DIR/xo-vm-import.sh"
}

# script is read from stdin on the host. wrapping it in a block makes bash parse all of it before running
# anything, so commands reading stdin can't consume the rest of the script
function RemoteScript {
    echo "{"
    SettingsScript
    NetworkScript
    if [[ "$USE_PREBUILT" == "true" ]]; then
        PrebuiltScript
    else
        DeployScript
    fi
    echo "}"
}

function SSHSetup {
    local ssh_opts=()
    read -r -a ssh_opts <<<"${SSH_OPTS:-}"

    # share one connection between all ssh calls so password is asked only once
    SSH_CTRL_DIR=$(mktemp -d)
    trap 'ssh -o ControlPath="$SSH_CTRL_DIR/cm" -O exit "$TARGET" >/dev/null 2>&1; rm -rf "$SSH_CTRL_DIR"' EXIT
    SSH_CMD=(ssh "${ssh_opts[@]}" -o ControlMaster=auto -o ControlPath="$SSH_CTRL_DIR/cm" -o ControlPersist=120)
}

# prints uuid of cached base image on the host matching IMAGE_SHA, if any
function CachedImage {
    # shellcheck disable=SC2016
    "${SSH_CMD[@]}" "$TARGET" "$(printf 'VM_SR=%q LABEL=%q SHA=%q\n' "$VM_SR" "xo-remote-deploy cache: ${IMAGE_URL##*/}" "$IMAGE_SHA")"'
        if [[ "$VM_SR" == "default" ]]; then SR=$(xe pool-param-get uuid="$(xe pool-list --minimal)" param-name=default-SR); else SR="$VM_SR"; fi
        for vdi in $(xe vdi-list sr-uuid="$SR" name-label="$LABEL" --minimal | tr "," " "); do
            if [[ "$(xe vdi-param-get uuid="$vdi" param-name=other-config param-key=xo-deploy-image-sha 2>/dev/null)" == "$SHA" ]]; then
                echo "$vdi"
                break
            fi
        done' 2>/dev/null
}

# ubuntu image is converted from qcow2 to raw here and streamed to a new VDI on the host
function UploadConvertedImage {
    local workdir="$SSH_CTRL_DIR/image"
    local file="${IMAGE_URL##*/}"
    mkdir -p "$workdir"

    echo "Downloading $IMAGE_URL..."
    curl -fL --progress-bar -o "$workdir/$file" "$IMAGE_URL" || exit 1

    local expected="$IMAGE_SHA" actual
    if [[ -n $(command -v sha256sum 2>/dev/null) ]]; then
        actual=$(sha256sum "$workdir/$file" | awk '{print $1}')
    else
        actual=$(shasum -a 256 "$workdir/$file" | awk '{print $1}')
    fi
    if [[ -z "$expected" ]] || [[ "$actual" != "$expected" ]]; then
        echo "Image checksum verification failed"
        exit 1
    fi

    echo "Converting image to raw..."
    qemu-img convert -O raw "$workdir/$file" "$workdir/disk.raw" || exit 1
    rm -f "$workdir/$file"

    local size
    size=$(wc -c <"$workdir/disk.raw" | tr -d ' ')

    echo "Uploading image to $TARGET..."
    # shellcheck disable=SC2016
    IMAGE_VDI=$("${SSH_CMD[@]}" "$TARGET" "$(printf 'export VM_SR=%q VM_NAME=%q SIZE=%q\n' "$VM_SR" "$VM_NAME" "$size")"'
        set -eo pipefail
        if [[ "$VM_SR" == "default" ]]; then SR=$(xe pool-param-get uuid="$(xe pool-list --minimal)" param-name=default-SR); else SR="$VM_SR"; fi
        vdi=$(xe vdi-create sr-uuid="$SR" name-label="$VM_NAME disk" type=user virtual-size="$SIZE")
        if ! xe vdi-import uuid="$vdi" filename=/dev/stdin format=raw >&2; then
            xe vdi-destroy uuid="$vdi"
            exit 1
        fi
        echo "$vdi"' <"$workdir/disk.raw")
    local rc=$?
    rm -f "$workdir/disk.raw"

    if [[ "$rc" != "0" ]] || [[ -z "$IMAGE_VDI" ]]; then
        echo "Image upload failed"
        exit 1
    fi
}

# Debian doesn't package a Xen guest agent, so take the one shipped in host's guest tools ISO
function FetchGuestAgent {
    GUEST_AGENT="$SSH_CTRL_DIR/guest-agent.deb"
    # shellcheck disable=SC2016
    "${SSH_CMD[@]}" "$TARGET" '
        iso=$(ls /opt/xensource/packages/iso/*tools*.iso 2>/dev/null | head -n 1)
        [ -n "$iso" ] || exit 0
        mnt=$(mktemp -d)
        if mount -o loop,ro "$iso" "$mnt" >/dev/null 2>&1; then
            deb=$(ls "$mnt"/Linux/*guest*amd64.deb 2>/dev/null | head -n 1)
            [ -n "$deb" ] && cat "$deb"
            umount "$mnt"
        fi
        rmdir "$mnt"' >"$GUEST_AGENT" 2>/dev/null
    if [[ ! -s "$GUEST_AGENT" ]]; then
        GUEST_AGENT=""
        echo "  Guest agent package not found on host, XCP-ng won't show VM ip-address until one is installed"
    else
        echo "  Using guest agent from host guest tools ISO"
    fi
}

function Deploy {

    if [[ "$PRINT_ONLY" != "true" ]]; then
        SSHSetup
        echo "Connecting to $TARGET..."
    fi

    if [[ "$USE_PREBUILT" != "true" ]]; then
        # Ubuntu image is prepared locally before network setup on the host
        # shellcheck disable=SC2034
        if [[ "$VM_OS" == ubuntu* ]]; then
            STAGE_NET=2
        else
            STAGE_NET=1
        fi
        [[ "$PRINT_ONLY" != "true" ]] && FetchGuestAgent
        # shellcheck disable=SC2034
        SEED_B64=$(BuildSeed) || {
            echo "Failed to build cloud-init seed"
            exit 1
        }
    fi

    if [[ "$PRINT_ONLY" == "true" ]]; then
        RemoteScript
        exit 0
    fi

    if [[ "$USE_PREBUILT" != "true" ]] && [[ "$VM_OS" == ubuntu* ]]; then
        IMAGE_SHA=$(curl -fsSL "$IMAGE_SUMS" | awk -v f="${IMAGE_URL##*/}" '$2==f || $2=="*"f {print $1}')
        if [[ -z "$IMAGE_SHA" ]]; then
            echo "Couldn't get checksum of ${IMAGE_URL##*/} from $IMAGE_SUMS"
            exit 1
        fi
        if [[ "$USE_CACHE" == "true" ]] && [[ -n $(CachedImage) ]]; then
            echo "[1/6] Cached $VM_OS image found on host, skipping download"
        else
            echo "[1/6] Downloading, converting and uploading $VM_OS image"
            UploadConvertedImage
        fi
    fi

    # script is fed through stdin so nothing needs to be copied to the host
    # result line for this script is kept out of the output
    local rc
    RemoteScript | "${SSH_CMD[@]}" "$TARGET" "bash -s" | while IFS= read -r line; do
        if [[ "$line" == XO_DEPLOY_RESULT* ]]; then
            echo "$line" >"$SSH_CTRL_DIR/result"
        else
            printf '%s\n' "$line"
        fi
    done
    rc=${PIPESTATUS[1]}

    if [[ "$rc" != "0" ]]; then
        # uploaded image may be left behind if failure happened before the host script took it over
        if [[ -n "$IMAGE_VDI" ]]; then
            "${SSH_CMD[@]}" "$TARGET" "xe vdi-destroy uuid=$IMAGE_VDI" >/dev/null 2>&1
        fi
        echo
        echo "Deployment failed on $TARGET (exit code $rc)"
        exit "$rc"
    fi

    [[ "$USE_PREBUILT" == "true" ]] && return 0

    local result status ip port
    result=$(cat "$SSH_CTRL_DIR/result" 2>/dev/null)
    status=$(sed -n 's/.*status=\([^ ]*\).*/\1/p' <<<"$result")
    ip=$(sed -n 's/.*ip=\([^ ]*\).*/\1/p' <<<"$result")
    port=$(sed -n 's/^PORT="\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p' "$XO_CONFIG" | tail -1)

    echo
    case "$status" in
        done)
            echo "Xen Orchestra is installed and running"
            echo
            [[ "$port" == "80" ]] && port=""
            echo "Web UI: http://$ip${port:+:$port} (admin@admin.net / admin)"
            ;;
        failed)
            echo "Xen Orchestra installation failed inside the VM. See /var/log/xo-install.log and /opt/xo-installer/logs in the VM"
            ;;
        *)
            echo "Didn't get a result from the VM within $WAIT_TIMEOUT minutes. Installation may still be running"
            echo "Check /var/log/cloud-init-output.log and /var/log/xo-install.log in the VM"
            ;;
    esac
    echo "SSH: xo@$ip"
    if [[ -n "$VM_PASSWORD" ]]; then
        echo "Password for user xo: $VM_PASSWORD"
    else
        echo "Login with key $SSH_KEY"
    fi
    if [[ "$NET_INTERNAL" == "true" ]]; then
        echo
        echo "Note: VM is on an isolated internal network and is only reachable from other VMs attached to $NET_NAME"
    fi
    echo
    echo "Remember to change the default Xen Orchestra password"

    [[ "$status" == "done" ]] || exit 1

}

HandleArgs "$@"
CheckArgs
Deploy
