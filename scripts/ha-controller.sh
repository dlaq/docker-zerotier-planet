#!/bin/sh
set -eu

# Active-passive guard for the Controller/Planet stack.  This script never
# copies identity.secret or changes a Planet file.  Promotion is deliberately
# explicit because two writers with the same Controller identity can corrupt
# membership state and make clients see an identity collision.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_dir=${ZTPLANET_INSTALL_DIR:-$(CDPATH= cd -- "$script_dir/.." && pwd)}
state_dir=${ZTPLANET_STATE_DIR:-/etc/ztplanet}
data_dir=${ZTPLANET_DATA_DIR:-$install_dir/data}
compose_file=${ZTPLANET_COMPOSE_FILE:-$install_dir/docker-compose.yml}
compose_project=${ZTPLANET_COMPOSE_PROJECT:-ztplanet}
runtime_env=$state_dir/runtime.env
image_env=$state_dir/images.env
generated_env=$state_dir/generated/stack.env
override_file=$state_dir/generated/compose.override.yml
ha_env_file=${ZTPLANET_HA_ENV_FILE:-$state_dir/ha.env}

env_file_value() {
    key=$1
    if [ ! -r "$ha_env_file" ]; then
        return 0
    fi
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ha_env_file"
}

# 1Panel can keep these values outside the Compose environment.  Read only the
# known keys from a root-owned, plain KEY=VALUE file; never source it as shell.
ha_mode=${ZTPLANET_HA_MODE:-$(env_file_value ZTPLANET_HA_MODE)}
ha_node_id=${ZTPLANET_HA_NODE_ID:-$(env_file_value ZTPLANET_HA_NODE_ID)}
ha_peer=${ZTPLANET_HA_PEER:-$(env_file_value ZTPLANET_HA_PEER)}
ha_state_dir=${ZTPLANET_HA_STATE_DIR:-$(env_file_value ZTPLANET_HA_STATE_DIR)}
ha_lease_file=${ZTPLANET_HA_LEASE_FILE:-$(env_file_value ZTPLANET_HA_LEASE_FILE)}
expected_planet_sha256=${ZTPLANET_HA_EXPECTED_PLANET_SHA256:-$(env_file_value ZTPLANET_HA_EXPECTED_PLANET_SHA256)}
ha_mode=${ha_mode:-standalone}
ha_node_id=${ha_node_id:-$(hostname -s 2>/dev/null || echo node)}
ha_state_dir=${ha_state_dir:-$state_dir/ha}
ha_lease_file=${ha_lease_file:-$ha_state_dir/active.lease}
role_file=$ha_state_dir/role
planet_file=${ZTPLANET_PLANET_FILE:-$data_dir/zerotier/planet}
if [ ! -f "$planet_file" ] && [ -f "$data_dir/ztnet-planet/planet" ]; then
    planet_file=$data_dir/ztnet-planet/planet
fi
identity_public_file=$data_dir/zerotier/identity.public
identity_secret_file=$data_dir/zerotier/identity.secret

die() { echo "ha-controller: $*" >&2; exit 1; }
usage() {
    cat >&2 <<EOF
用法：$0 status|check|snapshot|promote|demote

promote/demote 必须由 root 在维护窗口中显式执行。主备节点必须使用同一份
Controller 数据和逐字节相同的 Planet；任意时刻只能有一个节点运行 zerotier。
EOF
    exit 2
}

require_root() {
    [ "$(id -u)" -eq 0 ] || die "请使用 root 运行"
}

require_commands() {
    command -v docker >/dev/null 2>&1 || die "缺少 docker"
    docker compose version >/dev/null 2>&1 || die "缺少 Docker Compose v2"
    command -v sha256sum >/dev/null 2>&1 || die "缺少 sha256sum"
    command -v awk >/dev/null 2>&1 || die "缺少 awk"
}

validate_settings() {
    case "$ha_mode" in
        standalone|primary|standby) ;;
        *) die "ZTPLANET_HA_MODE 必须是 standalone、primary 或 standby" ;;
    esac
    case "$ha_node_id" in
        ''|*[!A-Za-z0-9._-]*) die "ZTPLANET_HA_NODE_ID 只能包含字母、数字、点、下划线和短横线" ;;
    esac
    if [ -n "$expected_planet_sha256" ]; then
        case "$expected_planet_sha256" in
            *[!A-Fa-f0-9]*) die "ZTPLANET_HA_EXPECTED_PLANET_SHA256 必须是十六进制" ;;
        esac
        [ "${#expected_planet_sha256}" -eq 64 ] || die "ZTPLANET_HA_EXPECTED_PLANET_SHA256 必须是 64 位十六进制"
    fi
    [ -f "$compose_file" ] || die "Compose 文件不存在：$compose_file"
}

compose() {
    if [ -f "$runtime_env" ] && [ -f "$image_env" ] && [ -f "$generated_env" ] && [ -f "$override_file" ]; then
        docker compose --project-directory "$install_dir" \
            --env-file "$runtime_env" --env-file "$image_env" --env-file "$generated_env" \
            -f "$compose_file" -f "$override_file" -p "$compose_project" "$@"
    elif [ -f "$ha_env_file" ]; then
        # A 1Panel path-selection deployment normally has only the Compose file.
        docker compose --project-directory "$install_dir" -f "$compose_file" -p "$compose_project" "$@"
    else
        docker compose --project-directory "$install_dir" -f "$compose_file" -p "$compose_project" "$@"
    fi
}

service_running() {
    service=$1
    compose ps --status running --services 2>/dev/null | grep -Fx "$service" >/dev/null 2>&1
}

controller_running() { service_running zerotier; }

file_sha256() {
    sha256sum "$1" | awk '{print $1}'
}

validate_state_files() {
    [ -s "$identity_secret_file" ] || die "缺少 ZeroTier identity.secret：$identity_secret_file"
    [ -s "$identity_public_file" ] || die "缺少 ZeroTier identity.public：$identity_public_file"
    [ -s "$planet_file" ] || die "缺少 Planet 文件：$planet_file"
    identity_sha256=$(file_sha256 "$identity_public_file")
    planet_sha256=$(file_sha256 "$planet_file")
    [ -z "$expected_planet_sha256" ] || [ "$planet_sha256" = "$(printf '%s' "$expected_planet_sha256" | tr '[:upper:]' '[:lower:]')" ] \
        || die "Planet 校验和不符合 ZTPLANET_HA_EXPECTED_PLANET_SHA256"
}

read_role() {
    if [ -r "$role_file" ]; then
        role=$(sed -n '1p' "$role_file")
    else
        role=$([ "$ha_mode" = standby ] && printf standby || printf active)
    fi
    case "$role" in active|standby) ;; *) role=unknown ;; esac
}

ensure_state_dir() {
    install -d -m 0750 -o root -g root "$ha_state_dir"
}

acquire_lease_lock() {
    lease_lock=$ha_lease_file.lock
    install -d -m 0750 -o root -g root "$(dirname "$ha_lease_file")"
    # mkdir is an atomic lock and does not require a shared shell FD.  If the
    # process is killed, the operator can remove the lock after checking that
    # no promotion/demotion command is still running.
    if ! mkdir "$lease_lock" 2>/dev/null; then
        die "主备租约正在被其它操作占用：$lease_lock"
    fi
    lock_acquired=true
    trap release_lease_lock EXIT HUP INT TERM
}

release_lease_lock() {
    if [ "${lock_acquired:-false}" = true ]; then
        rmdir "$lease_lock" 2>/dev/null || true
        lock_acquired=false
    fi
}

lease_owner() {
    [ -r "$ha_lease_file" ] || return 0
    sed -n 's/^nodeId=//p' "$ha_lease_file" | sed -n '1p'
}

write_lease() {
    temporary=$ha_lease_file.$$
    umask 027
    {
        echo "nodeId=$ha_node_id"
        echo "mode=$ha_mode"
        echo "startedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "identityPublicSha256=$identity_sha256"
        echo "planetSha256=$planet_sha256"
        [ -z "$ha_peer" ] || echo "peer=$ha_peer"
    } > "$temporary"
    chmod 0640 "$temporary"
    chown root:root "$temporary"
    mv -f "$temporary" "$ha_lease_file"
}

remove_lease_if_owned() {
    if [ ! -e "$ha_lease_file" ]; then
        return 0
    fi
    owner=$(lease_owner)
    [ "$owner" = "$ha_node_id" ] || die "租约属于节点 $owner；先在该节点执行 demote 并确认它已停止"
    rm -f -- "$ha_lease_file"
}

write_role() {
    temporary=$role_file.$$
    printf '%s\n' "$1" > "$temporary"
    chmod 0640 "$temporary"
    chown root:root "$temporary"
    mv -f "$temporary" "$role_file"
}

status() {
    require_root
    require_commands
    validate_settings
    read_role
    identity_sha256=missing
    planet_sha256=missing
    identity_size=0
    planet_size=0
    if [ -s "$identity_public_file" ]; then
        identity_sha256=$(file_sha256 "$identity_public_file")
        identity_size=$(wc -c < "$identity_public_file")
    fi
    if [ -s "$planet_file" ]; then
        planet_sha256=$(file_sha256 "$planet_file")
        planet_size=$(wc -c < "$planet_file")
    fi
    lease_node=$(lease_owner || true)
    echo "mode=$ha_mode"
    echo "nodeId=$ha_node_id"
    echo "peer=${ha_peer:-}"
    echo "role=$role"
    echo "controllerRunning=$(controller_running && echo true || echo false)"
    echo "identityPublicSha256=$identity_sha256"
    echo "identityPublicBytes=$identity_size"
    echo "planetFile=$planet_file"
    echo "planetSha256=$planet_sha256"
    echo "planetBytes=$planet_size"
    echo "leaseOwner=${lease_node:-}"
    echo "leaseFile=$ha_lease_file"
}

check() {
    require_root
    require_commands
    validate_settings
    validate_state_files
    read_role
    if [ "$ha_mode" = standby ] && controller_running && [ "$role" = standby ]; then
        die "standby 节点仍运行 zerotier；请先执行 demote，避免双写"
    fi
    owner=$(lease_owner || true)
    if [ -n "$owner" ] && [ "$owner" != "$ha_node_id" ]; then
        die "共享租约由节点 $owner 持有"
    fi
    echo "HA check passed"
    echo "identityPublicSha256=$identity_sha256"
    echo "planetSha256=$planet_sha256"
    echo "role=$role"
}

snapshot() {
    require_root
    require_commands
    validate_settings
    validate_state_files
    [ -x "$install_dir/scripts/backup.sh" ] || die "缺少 backup.sh：$install_dir/scripts/backup.sh"
    backup_dir=$($install_dir/scripts/backup.sh)
    manifest=$backup_dir/ha-manifest.txt
    umask 027
    {
        echo "nodeId=$ha_node_id"
        echo "mode=$ha_mode"
        echo "createdAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "identityPublicSha256=$identity_sha256"
        echo "planetSha256=$planet_sha256"
        echo "planetBytes=$(wc -c < "$planet_file")"
    } > "$manifest"
    chmod 0600 "$manifest"
    echo "$backup_dir"
}

promote() {
    require_root
    require_commands
    validate_settings
    [ "$ha_mode" != standalone ] || die "standalone 节点不能执行 promote；设置 ZTPLANET_HA_MODE=primary 或 standby"
    validate_state_files
    ensure_state_dir
    acquire_lease_lock
    read_role
    owner=$(lease_owner || true)
    if [ -n "$owner" ] && [ "$owner" != "$ha_node_id" ]; then
        die "租约属于节点 $owner；先在旧主节点执行 demote"
    fi
    if controller_running; then
        write_role active
        write_lease
        echo "节点已经是 active，租约已刷新"
        return 0
    fi
    write_lease
    if ! compose up -d --no-build --wait --wait-timeout 180; then
        rm -f -- "$ha_lease_file"
        die "启动主备栈失败；租约已释放"
    fi
    if ! controller_running; then
        compose stop --timeout 30 gateway ztnet relay zerotier postgres >/dev/null 2>&1 || true
        rm -f -- "$ha_lease_file"
        die "Compose 返回成功但 zerotier 未运行；租约已释放"
    fi
    write_role active
    echo "promote completed; Controller identity and Planet were preserved"
}

demote() {
    require_root
    require_commands
    validate_settings
    acquire_lease_lock
    owner=$(lease_owner || true)
    [ -z "$owner" ] || [ "$owner" = "$ha_node_id" ] || die "租约属于节点 $owner；不能在备节点强制停止"
    # Stop every writer, including postgres and relay, so a standby cannot
    # serve stale data or publish telemetry that looks like an active root.
    compose stop --timeout 30 gateway ztnet relay zerotier postgres >/dev/null 2>&1 || true
    remove_lease_if_owned
    ensure_state_dir
    write_role standby
    echo "demote completed; all Controller/Planet services are stopped"
}

command=${1:-status}
case "$command" in
    status) status ;;
    check) check ;;
    snapshot) snapshot ;;
    promote) promote ;;
    demote) demote ;;
    -h|--help|help) usage ;;
    *) usage ;;
esac
