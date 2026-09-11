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
#     --image-sha512 <128 hex> [--storage vmdata] \
#     [--image /var/lib/vz/template/iso/debian-13-genericcloud-amd64.qcow2]
#
# --image-sha512 is the digest from the image publisher's own SHA512SUMS. It is
# required: this image becomes the guest OS, and an existence check accepts a
# truncated download or a file somebody replaced on the node after it landed.
set -euo pipefail

NODE="" NAME="" IP_CIDR="" GATEWAY="" NAMESERVER="" SSH_KEY_FILE="" VMID="" IMAGE_SHA512=""
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
    --image-sha512) IMAGE_SHA512="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

ipv4() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local octet
  for octet in "${BASH_REMATCH[@]:1}"; do (( 10#$octet <= 255 )) || return 1; done
}

[[ -n "$NODE" && -n "$NAME" && -n "$IP_CIDR" && -n "$GATEWAY" && -n "$SSH_KEY_FILE" ]] \
  || die "--node, --name, --ip, --gateway and --ssh-key-file are required"
[[ "$NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "--name must be a valid hostname label"
IP="${IP_CIDR%/*}" PREFIX="${IP_CIDR##*/}"
{ ipv4 "$IP" && [[ "$PREFIX" =~ ^[0-9]{1,2}$ ]] && (( 10#$PREFIX <= 32 )); } \
  || die "--ip must be an IPv4 address with a prefix length, for example 192.0.2.10/24"
NAMESERVER="${NAMESERVER:-$GATEWAY}"
ipv4 "$GATEWAY" || die "--gateway must be an IPv4 address"
ipv4 "$NAMESERVER" || die "--nameserver must be an IPv4 address"
[[ -f "$SSH_KEY_FILE" ]] || die "no such key file: $SSH_KEY_FILE"
[[ -z "$VMID" || "$VMID" =~ ^[0-9]+$ ]] || die "--vmid must be a number"
[[ "$STORAGE" =~ ^[A-Za-z0-9._-]+$ ]] || die "--storage must be a plain storage id"
[[ "$IMAGE" == /* ]] || die "--image must be an absolute path on the node"
SSH_AUTHORIZED_KEY="$(head -n1 "$SSH_KEY_FILE")"
# Ask OpenSSH, rather than matching a name prefix: ecdsa-sha2-* and the
# sk-* hardware-backed types are valid public keys that no ssh-* prefix matches.
ssh-keygen -l -f /dev/stdin <<<"$SSH_AUTHORIZED_KEY" >/dev/null 2>&1 \
  || die "the first line of $SSH_KEY_FILE is not a public key OpenSSH recognises"
# The key is rendered into a double-quoted YAML scalar, where a quote or a
# backslash in the free-form comment would end or escape past the scalar.
case "$SSH_AUTHORIZED_KEY" in
  *[\"\\]*) die "$SSH_KEY_FILE has a quote or backslash in its comment; strip it" ;;
esac

# One SSH connection for every call below, including the guest-agent poll.
CONTROL_DIR="$(mktemp -d)"
trap 'ssh -o ControlPath="$CONTROL_DIR/cm" -O exit "root@${NODE}" 2>/dev/null; rm -rf "$CONTROL_DIR"' EXIT

# Run one command on the node with its argument boundaries intact. ssh joins argv
# with spaces and hands the result to the node's shell, so every argument carries
# its own single quotes (not printf %q: that emits bash's $'...' form for some
# inputs, which the node's shell may not be). This is the only way anything
# reaches the node: no value from this script is ever interpolated into a remote
# shell snippet, so a value that passed validation here cannot become shell
# syntax there. Snippets that need a pipe or a redirect go through sh -c with
# their values as positional arguments.
node_run() {
  local quoted="" arg
  for arg in "$@"; do quoted+=" '${arg//\'/\'\\\'\'}'"; done
  ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath="$CONTROL_DIR/cm" -o ControlPersist=60 \
    "root@${NODE}" "$quoted"
}

# Probe the address from the node, never from this workstation: a macvtap guest
# cannot talk to its own host, so a probe from a hypervisor host is blind to that
# host's guests. The node sits on the same segment the new VM will join.
# shellcheck disable=SC2016  # $1 is for the node's sh, not this one
if node_run sh -c 'ping -c1 -W1 "$1" >/dev/null 2>&1 || ip neigh show "$1" | grep -Eq "lladdr .* (REACHABLE|STALE|DELAY|PERMANENT)"' _ "$IP"; then
  die "$IP is answering on the node's segment; pick a free address"
fi

if [[ -z "$VMID" ]]; then
  VMID="$(node_run pvesh get /cluster/nextid)"
  [[ "$VMID" =~ ^[0-9]+$ ]] || die "the node did not return a numeric VMID: $VMID"
fi
if node_run qm status "$VMID" >/dev/null 2>&1; then
  die "VMID $VMID already exists"
fi
[[ "$IMAGE_SHA512" =~ ^[0-9a-fA-F]{128}$ ]] \
  || die "--image-sha512 is required and must be 128 hex characters, from the publisher's SHA512SUMS"
node_run test -f "$IMAGE" || die "image not found on the node: $IMAGE"
# Verify on the node, against the file qm create will actually import.
# shellcheck disable=SC2016  # $1 and $2 are for the node's sh, not this one
node_run sh -c 'printf "%s  %s\n" "$1" "$2" | sha512sum -c --status -' _ "$IMAGE_SHA512" "$IMAGE" \
  || die "image on the node does not match --image-sha512: $IMAGE"

# qm rejects a cicustom reference unless the storage advertises snippet content;
# the directory existing is not enough.
node_run pvesm status --content snippets | awk 'NR > 1 && $1 == "local"' | grep -q . \
  || die "storage 'local' on the node does not allow snippets; add the type with: pvesm set local --content <its current list>,snippets"

SNIPPET="${NAME}-user-data.yaml"
# Rendered in bash rather than with envsubst, which macOS does not ship. The
# replacement values are quoted so an & in the key's comment stays literal.
USER_DATA="$(<"$HERE/cloud-init.yaml")"
USER_DATA="${USER_DATA//\$\{VM_HOSTNAME\}/"$NAME"}"
USER_DATA="${USER_DATA//\$\{SSH_AUTHORIZED_KEY\}/"$SSH_AUTHORIZED_KEY"}"
# shellcheck disable=SC2016  # $1 is for the node's sh, not this one
printf '%s\n' "$USER_DATA" \
  | node_run sh -c 'install -d -m 755 /var/lib/vz/snippets && cat > "/var/lib/vz/snippets/$1"' _ "$SNIPPET"

node_run qm create "$VMID" \
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

node_run qm disk resize "$VMID" scsi0 "${DISK_GB}G"
node_run qm start "$VMID"

agent_up=""
for _ in $(seq 1 60); do
  if node_run qm agent "$VMID" ping >/dev/null 2>&1; then
    agent_up=1
    break
  fi
  sleep 5
done
[[ -n "$agent_up" ]] \
  || die "VM $VMID started but the guest agent did not answer within 5 minutes; check 'qm terminal $VMID'"

# An answering agent is not a ready guest. qemu-guest-agent's own package can be
# installed, and its service started, while cloud-final is still working through
# the rest of the package list, so returning here would hand the operator a guest
# whose apt lock is still held and make the bootstrap's install fail at random.
# The sentinel is what is checked, not the JSON qm wraps the output in.
node_run qm guest exec "$VMID" --timeout 900 -- /bin/sh -c 'cloud-init status --wait >/dev/null 2>&1 && echo CLOUD_INIT_DONE' \
  | grep -q CLOUD_INIT_DONE \
  || die "VM $VMID came up but cloud-init did not finish cleanly; check 'qm guest exec $VMID -- cloud-init status --long'"

echo "VM $VMID ($NAME) is up at $IP and cloud-init has finished"
