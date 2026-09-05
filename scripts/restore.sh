#!/bin/sh
set -eu

install_dir=/opt/ztplanet
state_dir=/etc/ztplanet
backup_root=/var/backups/ztplanet
automatic=false
if [ "${1:-}" = "--automatic" ]; then
    if [ "${ZTPLANET_INTERNAL_ROLLBACK:-}" != "1" ]; then
        echo "--automatic is reserved for the upgrade rollback trap." >&2
        exit 2
    fi
    automatic=true
    shift
fi
requested=${1:-}

if [ "$(id -u)" -ne 0 ]; then
    echo "Run restore as root." >&2
    exit 1
fi
if [ -z "$requested" ]; then
    echo "usage: $0 [--automatic] /var/backups/ztplanet/<timestamp>" >&2
    exit 2
fi

backup_dir=$(realpath -e -- "$requested")
case "$backup_dir" in
    "$backup_root"/*) ;;
    *) echo "Backup must be a directory directly under $backup_root." >&2; exit 2 ;;
esac
for file in SHA256SUMS ztnet.pgdump zerotier-state.tar.gz ztnet-planet.tar.gz system-config.tar.gz; do
    if [ ! -f "$backup_dir/$file" ]; then
        echo "Backup is incomplete: missing $file" >&2
        exit 1
    fi
done
(cd "$backup_dir" && sha256sum -c SHA256SUMS)

validate_archive() {
    python3 - "$1" <<'PY'
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
with tarfile.open(archive, "r:gz") as tf:
    for member in tf.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe archive path: {member.name}")
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"unsupported archive entry type: {member.name}")
PY
}
validate_archive "$backup_dir/system-config.tar.gz"
validate_archive "$backup_dir/zerotier-state.tar.gz"
validate_archive "$backup_dir/ztnet-planet.tar.gz"

if [ "$automatic" != true ]; then
    printf 'Type RESTORE-ZTPLANET to replace the current database, identity and configuration: '
    read -r confirmation
    if [ "$confirmation" != "RESTORE-ZTPLANET" ]; then
        echo "Cancelled."
        exit 1
    fi
fi

compose() {
    docker compose \
        --project-directory "$install_dir" \
        --env-file "$state_dir/runtime.env" \
        --env-file "$state_dir/images.env" \
        --env-file "$state_dir/generated/stack.env" \
        -f "$install_dir/docker-compose.yml" \
        -f "$state_dir/generated/compose.override.yml" \
        "$@"
}

if [ "$automatic" = true ]; then
    pre_restore="automatic upgrade rollback"
else
    pre_restore=$($install_dir/scripts/backup.sh)
    echo "Pre-restore recovery point: $pre_restore"
fi
compose stop gateway ztnet relay zerotier

tmp_dir=$(mktemp -d /etc/ztplanet/.restore.XXXXXX)
cleanup() { rm -rf --one-file-system "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM
tar --no-same-owner --no-same-permissions -C "$tmp_dir" -xzf "$backup_dir/system-config.tar.gz"
for item in config.json generated tls; do
    if [ ! -e "$tmp_dir/$item" ]; then
        echo "Configuration archive is missing $item" >&2
        exit 1
    fi
done
if [ -f "$tmp_dir/images.env" ]; then
    install -m 0640 -o root -g root "$tmp_dir/images.env" "$state_dir/images.env"
fi

docker run --rm \
    -v ztplanet_zerotier-data:/target \
    -v "$backup_dir:/backup:ro" \
    alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
    sh -eu -c 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -o --no-same-permissions -C /target -xzf /backup/zerotier-state.tar.gz'

docker run --rm \
    -v ztplanet_ztnet-planet:/target \
    -v "$backup_dir:/backup:ro" \
    alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
    sh -eu -c 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -o --no-same-permissions -C /target -xzf /backup/ztnet-planet.tar.gz; chown -R 1001:1001 /target; chmod 0750 /target'

rm -rf --one-file-system "$state_dir/generated" "$state_dir/tls"
install -m 0640 "$tmp_dir/config.json" "$state_dir/config.json"
cp -a "$tmp_dir/generated" "$state_dir/generated"
cp -a "$tmp_dir/tls" "$state_dir/tls"
chown -R root:root "$state_dir/generated"
chown -R root:1002 "$state_dir/tls"
chmod 0750 "$state_dir/generated" "$state_dir/tls"
chmod 0640 "$state_dir/tls"/*.key 2>/dev/null || true

compose up -d --no-build --wait --wait-timeout 120 postgres
compose exec -T postgres sh -eu -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --clean --if-exists --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    < "$backup_dir/ztnet.pgdump"
systemctl restart ztplanet-agent.service
compose up -d --no-build --wait --wait-timeout 180
compose ps
echo "Restore completed. The previous state remains at $pre_restore."
