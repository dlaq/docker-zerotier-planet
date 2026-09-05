#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_dir=/opt/ztplanet
state_dir=/etc/ztplanet
data_dir=$install_dir/data
runtime_env=$state_dir/runtime.env
image_env=$state_dir/images.env
generated_env=$state_dir/generated/stack.env
override_file=$state_dir/generated/compose.override.yml
legacy_container=myztplanet
legacy_was_running=false
install_succeeded=false
upgrade_succeeded=false
upgrade_backup=
release_backup=
requested_repository=
requested_release=

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo "Run this command as root (sudo ./deploy.sh $1)." >&2
        exit 1
    fi
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Required command is missing: $1" >&2
        exit 1
    fi
}

compose() {
    docker compose \
        --project-directory "$install_dir" \
        --env-file "$runtime_env" \
        --env-file "$image_env" \
        --env-file "$generated_env" \
        -f "$install_dir/docker-compose.yml" \
        -f "$override_file" \
        "$@"
}

configure_images() {
    if [ -z "$requested_repository" ]; then
        if [ -f "$image_env" ]; then
            return
        fi
        umask 027
        {
            echo "ZTPLANET_DEPLOY_MODE=local"
            echo "ZTPLANET_POSTGRES_IMAGE=ztplanet-postgres:17"
            echo "ZTPLANET_ZEROTIER_IMAGE=ztplanet-zerotier:latest"
            echo "ZTPLANET_ZTNET_IMAGE=ztplanet-ztnet:latest"
            echo "ZTPLANET_GATEWAY_IMAGE=ztplanet-gateway:2.11.4"
            echo "ZTPLANET_RELAY_IMAGE=ztplanet-relay:latest"
        } > "$image_env"
    else
        case "$requested_repository" in
            ''|*[!a-z0-9._/-]*|/*|*/|*//*|*/*/*) echo "Docker Hub repository must be namespace/repository." >&2; exit 2 ;;
            */*) ;;
            *) echo "Docker Hub repository must be namespace/repository." >&2; exit 2 ;;
        esac
        case "$requested_release" in
            ''|*[!A-Za-z0-9._-]*|-*|.*) echo "Invalid immutable release tag." >&2; exit 2 ;;
        esac
        image_base="docker.io/$requested_repository"
        image_tmp=$(mktemp "$state_dir/.images.env.XXXXXX")
        umask 027
        {
            echo "ZTPLANET_DEPLOY_MODE=pull"
            echo "ZTPLANET_IMAGE_RELEASE=$requested_release"
            echo "ZTPLANET_POSTGRES_IMAGE=$image_base:postgres-$requested_release"
            echo "ZTPLANET_ZEROTIER_IMAGE=$image_base:zerotier-$requested_release"
            echo "ZTPLANET_ZTNET_IMAGE=$image_base:ztnet-$requested_release"
            echo "ZTPLANET_GATEWAY_IMAGE=$image_base:gateway-$requested_release"
            echo "ZTPLANET_RELAY_IMAGE=$image_base:relay-$requested_release"
        } > "$image_tmp"
        chown root:root "$image_tmp"
        chmod 0640 "$image_tmp"
        mv "$image_tmp" "$image_env"
    fi
    chown root:root "$image_env"
    chmod 0640 "$image_env"
}

deploy_images_and_start() {
    deploy_mode=$(sed -n 's/^ZTPLANET_DEPLOY_MODE=//p' "$image_env")
    case "$deploy_mode" in
        local) COMPOSE_PROFILES=relay compose -f "$install_dir/docker-compose.build.yml" build --pull ;;
        pull) COMPOSE_PROFILES=relay compose pull ;;
        *) echo "Invalid ZTPLANET_DEPLOY_MODE in $image_env" >&2; exit 1 ;;
    esac
    compose up -d --no-build --wait --wait-timeout 180
}

rebuild_local_images_for_rollback() {
    deploy_mode=$(sed -n 's/^ZTPLANET_DEPLOY_MODE=//p' "$image_env")
    if [ "$deploy_mode" = local ]; then
        COMPOSE_PROFILES=relay compose -f "$install_dir/docker-compose.build.yml" build >/dev/null 2>&1 || true
    fi
}

copy_release() {
    install -d -m 0755 "$install_dir"
    tar \
        --exclude=.git \
        --exclude=node_modules \
        --exclude=target \
        --exclude=.next \
        --exclude=data \
        --exclude=outputs \
        -C "$source_dir" -cf - . | tar -C "$install_dir" -xf -
    chmod 0755 "$install_dir/deploy.sh" "$install_dir/build.sh" "$install_dir/scripts/"*.sh
    chmod 0755 "$install_dir/services/config-agent/ztplanet_agent.py" "$install_dir/services/zerotier/entrypoint.sh"
}

initialize_data_dirs() {
    install -d -m 0750 -o root -g root "$data_dir"
    for directory in postgres zerotier ztnet-planet ztnet-backups gateway-data gateway-config; do
        install -d -m 0750 -o root -g root "$data_dir/$directory"
    done
}

check_legacy_named_storage() {
    legacy_volumes=
    for volume in ztplanet_postgres-data ztplanet_zerotier-data ztplanet_ztnet-planet ztplanet_ztnet-backups ztplanet_gateway-data ztplanet_gateway-config; do
        if docker volume inspect "$volume" >/dev/null 2>&1; then
            legacy_volumes="$legacy_volumes $volume"
        fi
    done
    if [ -z "$legacy_volumes" ]; then
        return
    fi
    if [ -s "$data_dir/zerotier/identity.secret" ] && [ -n "$(find "$data_dir/ztnet-planet" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
        echo "Legacy named volumes retained after bind migration:$legacy_volumes" >&2
        echo "The bind data is populated; continuing without using those volumes." >&2
        return
    fi
    echo "Legacy Docker named volumes detected:$legacy_volumes" >&2
    echo "Convert them to $data_dir before upgrading; no data will be copied automatically." >&2
    exit 1
}

initialize_secrets() {
    install -d -m 0750 -o root -g root "$state_dir"
    if [ ! -f "$runtime_env" ]; then
        postgres_password=$(openssl rand -hex 32)
        auth_secret=$(openssl rand -hex 48)
        umask 027
        {
            echo "POSTGRES_USER=ztnet"
            echo "POSTGRES_DB=ztnet"
            echo "POSTGRES_PASSWORD=$postgres_password"
            echo "DATABASE_URL=postgresql://ztnet:$postgres_password@postgres:5432/ztnet?schema=public"
            echo "NEXTAUTH_SECRET=$auth_secret"
        } > "$runtime_env"
        chown root:root "$runtime_env"
        chmod 0600 "$runtime_env"
    fi
    python3 "$install_dir/services/config-agent/ztplanet_agent.py" \
        --project-dir "$install_dir" \
        --state-dir "$state_dir" \
        --socket-gid 1001 \
        --gateway-gid 1002 \
        --initialize-only
}

install_agent() {
    install -m 0644 "$install_dir/services/config-agent/ztplanet-agent.service" \
        /etc/systemd/system/ztplanet-agent.service
    systemctl daemon-reload
    systemctl enable ztplanet-agent.service
    systemctl restart ztplanet-agent.service
    count=0
    while [ ! -S /run/ztplanet/agent.sock ]; do
        count=$((count + 1))
        if [ "$count" -gt 30 ]; then
            echo "Configuration agent did not create its socket." >&2
            systemctl status --no-pager ztplanet-agent.service || true
            exit 1
        fi
        sleep 1
    done
}

legacy_backup_and_import() {
    legacy=$source_dir/data/zerotier/one
    if [ ! -d "$legacy" ] || [ -f "$state_dir/legacy-imported" ]; then
        return
    fi
    backup_dir=/var/backups/ztplanet
    install -d -m 0700 "$backup_dir"
    timestamp=$(date -u +%Y%m%dT%H%M%SZ)
    tar -C "$legacy" -czf "$backup_dir/legacy-zerotier-$timestamp.tar.gz" .
    target=$data_dir/zerotier
    if [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        echo "Target bind directory is not empty; import skipped." >&2
        exit 1
    fi
    cp -a "$legacy"/. "$target"/
    touch "$state_dir/legacy-imported"
    chmod 0640 "$state_dir/legacy-imported"
    echo "Legacy ZeroTier state imported. Backup: $backup_dir/legacy-zerotier-$timestamp.tar.gz"
}

stop_legacy_for_migration() {
    if ! docker container inspect "$legacy_container" >/dev/null 2>&1; then
        return
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$legacy_container")" = true ]; then
        legacy_was_running=true
        docker stop --time 30 "$legacy_container" >/dev/null
    fi
}

recover_failed_install() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$install_succeeded" = true ]; then
        return
    fi
    echo "Installation failed; stopping the new stack and restoring the legacy service." >&2
    if [ -f "$runtime_env" ] && [ -f "$generated_env" ] && [ -f "$override_file" ]; then
        compose down >/dev/null 2>&1 || true
    fi
    if [ "$legacy_was_running" = true ]; then
        docker start "$legacy_container" >/dev/null || true
    fi
    exit "$status"
}

recover_failed_upgrade() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$upgrade_succeeded" = true ]; then
        exit "$status"
    fi
    echo "Upgrade failed; restoring the previous release and data snapshot." >&2
    systemctl stop ztplanet-agent.service >/dev/null 2>&1 || true
    if [ -n "$release_backup" ] && [ -f "$release_backup" ]; then
        failed_dir="${install_dir}.failed.$(date -u +%Y%m%dT%H%M%SZ)"
        mv "$install_dir" "$failed_dir"
        install -d -m 0755 "$install_dir"
        tar -C "$install_dir" -xzf "$release_backup"
        install -m 0644 "$install_dir/services/config-agent/ztplanet-agent.service" \
            /etc/systemd/system/ztplanet-agent.service
        systemctl daemon-reload
        systemctl restart ztplanet-agent.service
        rebuild_local_images_for_rollback
    fi
    if [ -n "$upgrade_backup" ] && [ -d "$upgrade_backup" ]; then
        ZTPLANET_INTERNAL_ROLLBACK=1 "$install_dir/scripts/restore.sh" --automatic "$upgrade_backup" || true
    fi
    echo "Automatic rollback attempted. Failed release retained under ${failed_dir:-$install_dir.failed}." >&2
    exit "$status"
}

install_stack() {
    require_root install
    for command in docker python3 openssl iptables systemctl tar; do require_command "$command"; done
    docker compose version >/dev/null
    copy_release
    initialize_data_dirs
    initialize_secrets
    configure_images
    trap recover_failed_install EXIT HUP INT TERM
    stop_legacy_for_migration
    legacy_backup_and_import
    "$install_dir/scripts/relay-firewall.sh" remove || true
    install_agent
    deploy_images_and_start
    compose ps
    install_succeeded=true
    trap - EXIT HUP INT TERM
    echo "Management URL: $(sed -n "s/^NEXTAUTH_URL='\(.*\)'$/\1/p" "$generated_env")"
    echo "The first registered account becomes administrator; no default password is created."
}

upgrade_stack() {
    require_root upgrade
    if [ ! -f "$runtime_env" ]; then
        echo "No installed stack was found; use install." >&2
        exit 1
    fi
    if [ ! -f "$image_env" ]; then
        saved_repository=$requested_repository
        requested_repository=
        configure_images
        requested_repository=$saved_repository
    fi
    check_legacy_named_storage
    upgrade_backup=$("$source_dir/scripts/backup.sh")
    release_backup=$upgrade_backup/release.tar.gz
    tar -C "$install_dir" -czf "$release_backup" .
    sha256sum "$release_backup" >> "$upgrade_backup/SHA256SUMS"
    trap recover_failed_upgrade EXIT HUP INT TERM
    copy_release
    initialize_data_dirs
    initialize_secrets
    configure_images
    install_agent
    deploy_images_and_start
    compose ps
    upgrade_succeeded=true
    trap - EXIT HUP INT TERM
}

status_stack() {
    require_root status
    compose ps
    echo "Configuration agent:"
    systemctl is-active ztplanet-agent.service
    echo "Configured system state:"
    python3 -c 'import json; print(json.dumps(json.load(open("/etc/ztplanet/config.json"))["config"], indent=2))'
    echo "Image deployment state:"
    sed -n '/^ZTPLANET_/p' "$image_env"
}

uninstall_stack() {
    require_root uninstall
    compose down
    systemctl disable --now ztplanet-agent.service || true
    "$install_dir/scripts/relay-firewall.sh" remove || true
    echo "Containers were removed. /etc/ztplanet and $data_dir were retained."
    echo "To irreversibly remove data, run: sudo /opt/ztplanet/scripts/manage.sh purge-data"
}

purge_data() {
    require_root purge-data
    printf 'Type DELETE-ZTPLANET-DATA to remove databases, identities and configuration: '
    read -r confirmation
    if [ "$confirmation" != "DELETE-ZTPLANET-DATA" ]; then
        echo "Cancelled."
        exit 1
    fi
    compose down
    systemctl disable --now ztplanet-agent.service || true
    "$install_dir/scripts/relay-firewall.sh" remove || true
    rm -rf --one-file-system "$data_dir"
    rm -rf --one-file-system "$state_dir"
    echo "ZeroTier identities, PostgreSQL data and configuration were permanently removed."
}

case "${1:-install}" in
    install) install_stack ;;
    install-dockerhub)
        if [ "$#" -ne 3 ]; then echo "usage: $0 install-dockerhub namespace/repository release" >&2; exit 2; fi
        requested_repository=$2
        requested_release=$3
        install_stack
        ;;
    upgrade) upgrade_stack ;;
    upgrade-dockerhub)
        if [ "$#" -ne 3 ]; then echo "usage: $0 upgrade-dockerhub namespace/repository release" >&2; exit 2; fi
        requested_repository=$2
        requested_release=$3
        upgrade_stack
        ;;
    status) status_stack ;;
    backup) require_root backup; "$source_dir/scripts/backup.sh" ;;
    restore) require_root restore; shift; "$source_dir/scripts/restore.sh" "$@" ;;
    uninstall) uninstall_stack ;;
    purge-data) purge_data ;;
    *) echo "usage: $0 install|install-dockerhub REPOSITORY RELEASE|upgrade|upgrade-dockerhub REPOSITORY RELEASE|status|backup|restore BACKUP_DIR|uninstall|purge-data" >&2; exit 2 ;;
esac
