#!/usr/bin/env bash
# Create a Rakazo guest on a Proxmox node from a Debian cloud image.
#
# Runs on an operator workstation with root SSH to the node. Creates and boots the
# VM, then waits for the guest agent. It does not deploy anything; run
# bootstrap-guest.sh inside the guest afterwards.
#
# Usage:
#   provision-vm.sh --node <address> --name <vm-name> --ip <addr/prefix> \
#     --gateway <addr> --ssh-key-file <file.pub> [--nameserver <addr>] \
#     [--vmid <id>] [--cores 4] [--memory-mb 8192] [--disk-gb 100] \
#     [--storage vmdata] [--image /var/lib/vz/template/iso/debian-13-genericcloud-amd64.qcow2]
set -euo pipefail

NODE="" NAME="" IP_CIDR="" GATEWAY="" NAMESERVER="" SSH_KEY_FILE="" VMID=""
CORES=4 MEMORY_MB=8192 DISK_GB=100 STORAGE=vmdata
IMAGE=/var/lib/vz/template/iso/debian-13-genericcloud-amd64.qcow2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "provision-vm: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) NODE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --ip) IP_CIDR="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --nameserver) NAMESERVER="$2"; shift 2 ;;
    --ssh-key-file) SSH_KEY_FILE="$2"; shift 2 ;;
    --vmid) VMID="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --memory-mb) MEMORY_MB="$2"; shift 2 ;;
    --disk-gb) DISK_GB="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$NODE" && -n "$NAME" && -n "$IP_CIDR" && -n "$GATEWAY" && -n "$SSH_KEY_FILE" ]] \
  || die "--node, --name, --ip, --gateway and --ssh-key-file are required"
[[ "$NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "--name must be a valid hostname label"
[[ "$IP_CIDR" == */* ]] || die "--ip needs a prefix length, for example 192.0.2.10/24"
[[ -f "$SSH_KEY_FILE" ]] || die "no such key file: $SSH_KEY_FILE"
NAMESERVER="${NAMESERVER:-$GATEWAY}"
IP="${IP_CIDR%/*}"
SSH_AUTHORIZED_KEY="$(head -n1 "$SSH_KEY_FILE")"
[[ "$SSH_AUTHORIZED_KEY" == ssh-* ]] || die "$SSH_KEY_FILE does not look like a public key"

node() { ssh -o BatchMode=yes "root@${NODE}" "$@"; }

# Probe the address from the node, never from this workstation: a macvtap guest
# cannot talk to its own host, so a probe from a hypervisor host is blind to that
# host's guests. The node sits on the same segment the new VM will join.
if node "ping -c1 -W1 '$IP' >/dev/null 2>&1 || ip neigh show '$IP' | grep -Eq 'lladdr .* (REACHABLE|STALE|DELAY|PERMANENT)'"; then
  die "$IP is answering on the node's segment; pick a free address"
fi

[[ -n "$VMID" ]] || VMID="$(node pvesh get /cluster/nextid)"
if node "qm status '$VMID'" >/dev/null 2>&1; then
  die "VMID $VMID already exists"
fi
node "test -f '$IMAGE'" || die "image not found on the node: $IMAGE"

SNIPPET="${NAME}-user-data.yaml"
VM_HOSTNAME="$NAME" SSH_AUTHORIZED_KEY="$SSH_AUTHORIZED_KEY" \
  envsubst '${VM_HOSTNAME} ${SSH_AUTHORIZED_KEY}' < "$HERE/cloud-init.yaml" \
  | node "install -d -m 755 /var/lib/vz/snippets && cat > '/var/lib/vz/snippets/$SNIPPET'"

node qm create "$VMID" \
  --name "$NAME" \
  --ostype l26 \
  --cpu x86-64-v3 \
  --cores "$CORES" --sockets 1 \
  --memory "$MEMORY_MB" --balloon 0 \
  --scsihw virtio-scsi-single \
  --scsi0 "${STORAGE}:0,import-from=${IMAGE},discard=on,ssd=1" \
  --ide2 "${STORAGE}:cloudinit" \
  --boot order=scsi0 \
  --serial0 socket --vga serial0 \
  --net0 virtio,bridge=vmbr0 \
  --agent enabled=1 \
  --onboot 1 \
  --ipconfig0 "ip=${IP_CIDR},gw=${GATEWAY}" \
  --nameserver "$NAMESERVER" \
  --cicustom "user=local:snippets/${SNIPPET}"

node qm disk resize "$VMID" scsi0 "${DISK_GB}G"
node qm start "$VMID"

for _ in $(seq 1 60); do
  if node "qm agent '$VMID' ping" >/dev/null 2>&1; then
    echo "VM $VMID ($NAME) is up at $IP"
    exit 0
  fi
  sleep 5
done
die "VM $VMID started but the guest agent did not answer within 5 minutes; check 'qm terminal $VMID'"
