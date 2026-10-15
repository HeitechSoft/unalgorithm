#!/usr/bin/env bash
# Makes the backup key pair once (CL4-10). Run it from the folder with compose.yaml:
#
#   docker compose run --rm -T keygen              make the key pair
#   docker compose run --rm -T keygen --replace    make a new one; backups already made still need the old private key
#
# The public key goes to backup-key/backup-public-key.asc, which the nightly backup encrypts to. The private key is
# printed to standard output only, never written to a file: save it on your own computer. The `keygen` service logs to
# no driver, so it never reaches a log file on this machine either; never run this through the `backup` service.
# UA_BACKUP_KEY exists for tests only; compose.yaml never sets it.
set -euo pipefail

key="${UA_BACKUP_KEY:-/keys/backup-public-key.asc}"
replace=false
case "${1-}" in
'') ;;
--replace) replace=true ;;
*)
  echo 'usage: keygen.sh [--replace]' >&2
  exit 2
  ;;
esac
[ "$#" -le 1 ] || {
  echo 'usage: keygen.sh [--replace]' >&2
  exit 2
}

if [ -e "$key" ] && [ "$replace" = false ]; then
  echo 'A backup key exists; backups already made need its private key.' >&2
  echo 'To make a new key pair anyway: docker compose run --rm -T keygen --replace' >&2
  exit 1
fi

GNUPGHOME="$(mktemp -d /tmp/gnupg.XXXXXX)"
export GNUPGHOME
public_tmp="$(dirname "$key")/.backup-public-key.asc.tmp"
cleanup() {
  gpgconf --kill all >/dev/null 2>&1 || true
  rm -rf "$GNUPGHOME"
  rm -f "$public_tmp"
}
trap cleanup EXIT

gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key 'UnAlgorithm server backup' ed25519 cert never
fingerprint="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
[ -n "$fingerprint" ] || {
  echo 'gpg made no key.' >&2
  exit 1
}
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-add-key "$fingerprint" cv25519 encr never

# The public key first goes to a temporary name: a key folder that cannot be written stops the script before the
# private key is printed, and the public key is only put in place once the private key has reached standard output.
gpg --batch --armor --export "$fingerprint" >"$public_tmp"
chmod 0644 "$public_tmp"

{
  echo 'Save the block below on your own computer, outside this server, and keep a second copy.'
  echo 'Without it no backup can be restored.'
  echo
} >&2
gpg --batch --pinentry-mode loopback --passphrase '' --armor --export-secret-keys "$fingerprint"
{
  echo
  echo 'The block above is the backup private key; it is not stored on this server.'
} >&2

mv -f "$public_tmp" "$key"
echo "Backups are now encrypted to $(basename "$key")." >&2
