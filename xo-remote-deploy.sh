#!/bin/bash

#########################################################################
# Title: XenOrchestraInstallerUpdater                                   #
# Author: Roni Väyrynen                                                 #
# Repository: https://github.com/ronivay/XenOrchestraInstallerUpdater   #
#########################################################################

# Run from your workstation. Connects to a XenServer/XCP-ng host over ssh, creates (or reuses) a
# test network for the VM and imports the prebuilt Xen Orchestra VM image using xo-vm-import.sh.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMPORT_SCRIPT="$SCRIPT_DIR/xo-vm-import.sh"

TARGET=""
NET_NAME="xo-test"
NET_VLAN=""
NET_PIF="eth0"
NET_INTERNAL="false"
NET_EXISTING=""
VM_SR="default"
VM_NAME="xo-test"
VM_IP="dhcp"
VM_NETMASK="255.255.255.0"
VM_GATEWAY=""
VM_DNS="8.8.8.8"
PRINT_ONLY="false"

function Usage {
    cat <<EOF
Usage: $(basename "$0") -H [user@]host [options]

Connects to a XenServer/XCP-ng host over ssh, sets up a test network and imports
a VM with Xen Orchestra preinstalled.

Required:
  -H, --host [user@]host     XenServer/XCP-ng pool master to ssh into (root or sudo-less root user)

Network (exactly one of --vlan, --internal or --network is required):
  --vlan ID                  create network "--network-name" tagged with VLAN ID on "--pif" (default: $NET_PIF)
  --internal                 create an isolated host-internal network (no uplink, requires --ip)
  --network NAME             use an existing network by name-label instead of creating one
  --network-name NAME        name-label of the network to create/reuse (default: $NET_NAME)
  --pif DEVICE               physical interface used for the VLAN (default: $NET_PIF)

VM:
  --name NAME                VM name-label (default: $VM_NAME)
  --sr UUID                  storage repository uuid (default: pool default SR)
  --ip ADDRESS               static ip-address (default: dhcp)
  --netmask MASK             netmask for static ip-address (default: $VM_NETMASK)
  --gateway ADDRESS          gateway for static ip-address
  --dns ADDRESS              dns server for static ip-address (default: $VM_DNS)

Other:
  --print                    print the script that would be run on the host and exit
  -h, --help                 show this help

Extra ssh options can be given with SSH_OPTS, e.g. SSH_OPTS="-p 2222 -i ~/.ssh/xcp"
EOF
}

function HandleArgs {

    OPTS=$(getopt -o H:h --long host:,vlan:,internal,network:,network-name:,pif:,name:,sr:,ip:,netmask:,gateway:,dns:,print,help -- "$@")

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
            --name)
                VM_NAME="$2"
                shift 2
                ;;
            --sr)
                VM_SR="$2"
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

    if [[ -z "$TARGET" ]]; then
        echo "Define host to connect to with -H/--host"
        exit 1
    fi

    if [[ ! -f "$IMPORT_SCRIPT" ]]; then
        echo "$IMPORT_SCRIPT not found. Run this script from the repository directory"
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

}

# network setup run on the host before xo-vm-import.sh. sets XO_VM_NETWORK for the import script
function NetworkScript {
    cat <<'EOF'
set -e

if [[ -z $(command -v xe 2>/dev/null) ]]; then
    echo "xe command not found. Make sure target is a XenServer/XCP-ng host"
    exit 1
fi

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
        XO_VM_NETWORK=$(xe network-create name-label="$NET_NAME" name-description="Xen Orchestra test network, VLAN $NET_VLAN")
        if ! xe pool-vlan-create network-uuid="$XO_VM_NETWORK" pif-uuid="$pif" vlan="$NET_VLAN" >/dev/null; then
            xe network-destroy uuid="$XO_VM_NETWORK"
            echo "Failed to create VLAN $NET_VLAN on $NET_PIF"
            exit 1
        fi
        echo "Created network $NET_NAME on $NET_PIF VLAN $NET_VLAN ($XO_VM_NETWORK)"
    else
        XO_VM_NETWORK=$(xe network-create name-label="$NET_NAME" name-description="Xen Orchestra internal test network")
        echo "Created internal network $NET_NAME ($XO_VM_NETWORK)"
    fi
fi

export XO_VM_NETWORK
set +e
EOF
}

# build the full script run on the host: settings, network setup and the vm import script itself
function RemoteScript {
    local var
    for var in NET_NAME NET_VLAN NET_PIF NET_EXISTING; do
        printf 'export %s=%q\n' "$var" "${!var}"
    done
    printf 'export XO_VM_SR=%q\n' "$VM_SR"
    printf 'export XO_VM_NAME=%q\n' "$VM_NAME"
    printf 'export XO_VM_IP=%q\n' "$VM_IP"
    printf 'export XO_VM_NETMASK=%q\n' "$VM_NETMASK"
    printf 'export XO_VM_GATEWAY=%q\n' "$VM_GATEWAY"
    printf 'export XO_VM_DNS=%q\n' "$VM_DNS"
    NetworkScript
    cat "$IMPORT_SCRIPT"
}

function Deploy {

    if [[ "$PRINT_ONLY" == "true" ]]; then
        RemoteScript
        exit 0
    fi

    local ssh_opts=()
    read -r -a ssh_opts <<<"${SSH_OPTS:-}"

    echo "Connecting to $TARGET..."

    # script is fed through stdin so nothing needs to be copied to the host
    RemoteScript | ssh "${ssh_opts[@]}" "$TARGET" "bash -s"
    local rc=${PIPESTATUS[1]}

    if [[ "$rc" != "0" ]]; then
        echo
        echo "Deployment failed on $TARGET (exit code $rc)"
        exit "$rc"
    fi

    if [[ "$NET_INTERNAL" == "true" ]]; then
        echo
        echo "Note: VM is on an isolated internal network and is only reachable from other VMs attached to $NET_NAME"
    fi

}

HandleArgs "$@"
CheckArgs
Deploy
