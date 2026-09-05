#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run backup as root." >&2
    exit 1
fi

install_dir=/opt/ztplanet
state_dir=/etc/ztplanet
data_dir=$install_dir/data
backup_root=/var/backups/ztplanet
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination=$backup_root/$timestamp
install -d -m 0700 "$destination"
restart_services=false

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

finish_backup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$restart_services" = true ]; then
        compose up -d --no-build --wait --wait-timeout 120 postgres zerotier ztnet gateway >/dev/null || true
    fi
    exit "$status"
}
trap finish_backup EXIT HUP INT TERM

compose exec -T postgres sh -eu -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner --username="$POSTGRES_USER" "$POSTGRES_DB"' \
    > "$destination/ztnet.pgdump"

if compose ps --status running --services | grep -Eq '^(gateway|ztnet|zerotier|postgres)$'; then
    restart_services=true
    compose stop --timeout 30 gateway ztnet zerotier postgres >/dev/null
fi

for directory in postgres zerotier ztnet-planet ztnet-backups gateway-data gateway-config; do
    if [ ! -d "$data_dir/$directory" ]; then
        echo "Missing bind data directory: $data_dir/$directory" >&2
        exit 1
    fi
done
tar --numeric-owner -C "$data_dir/postgres" -czf "$destination/postgres-data.tar.gz" .
tar --numeric-owner -C "$data_dir/zerotier" -czf "$destination/zerotier-state.tar.gz" .
tar --numeric-owner -C "$data_dir/ztnet-planet" -czf "$destination/ztnet-planet.tar.gz" .
tar --numeric-owner -C "$data_dir/ztnet-backups" -czf "$destination/ztnet-backups.tar.gz" .
tar --numeric-owner -C "$data_dir/gateway-data" -czf "$destination/gateway-data.tar.gz" .
tar --numeric-owner -C "$data_dir/gateway-config" -czf "$destination/gateway-config.tar.gz" .

tar -C "$state_dir" -czf "$destination/system-config.tar.gz" \
    --exclude=agent.secret --exclude=runtime.env config.json images.env generated tls
sha256sum "$destination"/* > "$destination/SHA256SUMS"
chmod -R go-rwx "$destination"
if [ "$restart_services" = true ]; then
    compose up -d --no-build --wait --wait-timeout 120 postgres zerotier ztnet gateway >/dev/null
    restart_services=false
fi
trap - EXIT HUP INT TERM
echo "$destination"
