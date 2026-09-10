#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_dir=/opt/ztplanet
state_dir=/etc/ztplanet
data_dir=$install_dir/data
release=${1:-v1.1.4}
repository=${2:-dlaq/zerotier-planet-test}

if [ "$(id -u)" -ne 0 ]; then
    echo "请使用 root 运行：sudo ./scripts/prepare-1panel.sh [版本] [命名空间/仓库]" >&2
    exit 1
fi
case "$release" in
    ''|*[!A-Za-z0-9._-]*|-*|.*) echo "版本标签无效" >&2; exit 2 ;;
esac
case "$repository" in
    ''|*[!a-z0-9._/-]*|/*|*/|*//*|*/*/*) echo "Docker Hub 仓库必须是 命名空间/仓库" >&2; exit 2 ;;
    */*) ;;
    *) echo "Docker Hub 仓库必须是 命名空间/仓库" >&2; exit 2 ;;
esac

for command in docker python3 openssl systemctl tar; do
    command -v "$command" >/dev/null 2>&1 || { echo "缺少命令：$command" >&2; exit 1; }
done
docker compose version >/dev/null
compose_version=$(docker compose version --short | sed 's/^v//')
python3 - "$compose_version" <<'PY'
import sys
parts = []
for value in sys.argv[1].split(".")[:3]:
    digits = "".join(ch for ch in value if ch.isdigit())
    parts.append(int(digits or 0))
parts.extend([0] * (3 - len(parts)))
if tuple(parts) < (2, 24, 4):
    raise SystemExit("Docker Compose 必须为 2.24.4 或更高版本")
PY

machine=$(uname -m)
case "$machine" in
    x86_64|aarch64|arm64) ;;
    *) echo "当前仅支持 x86_64 和 ARM64，检测到：$machine" >&2; exit 1 ;;
esac

install -d -m 0755 "$install_dir"
if [ "$source_dir" != "$install_dir" ]; then
    tar --exclude=.git --exclude=node_modules --exclude=target --exclude=.next \
        --exclude=data --exclude=outputs -C "$source_dir" -cf - . | tar -C "$install_dir" -xf -
fi
chmod 0755 "$install_dir/deploy.sh" "$install_dir/build.sh" "$install_dir/scripts/"*.sh
chmod 0755 "$install_dir/services/config-agent/ztplanet_agent.py" "$install_dir/services/zerotier/entrypoint.sh"

install -d -m 0750 -o root -g root "$data_dir"
for directory in postgres zerotier ztnet-planet ztnet-backups gateway-data gateway-config; do
    install -d -m 0750 -o root -g root "$data_dir/$directory"
done

install -d -m 0750 -o root -g root "$state_dir"
runtime_env=$state_dir/runtime.env
if [ ! -f "$runtime_env" ]; then
    postgres_password=$(openssl rand -hex 32)
    auth_secret=$(openssl rand -hex 48)
    umask 077
    {
        echo "POSTGRES_USER=ztnet"
        echo "POSTGRES_DB=ztnet"
        echo "POSTGRES_PASSWORD=$postgres_password"
        echo "DATABASE_URL=postgresql://ztnet:$postgres_password@postgres:5432/ztnet?schema=public"
        echo "NEXTAUTH_SECRET=$auth_secret"
    } > "$runtime_env"
fi
if ! grep -q '^DATABASE_URL=' "$runtime_env"; then
    postgres_user=$(sed -n 's/^POSTGRES_USER=//p' "$runtime_env")
    postgres_db=$(sed -n 's/^POSTGRES_DB=//p' "$runtime_env")
    postgres_password=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$runtime_env")
    test -n "$postgres_user" && test -n "$postgres_db" && test -n "$postgres_password"
    database_url=$(python3 - "$postgres_user" "$postgres_password" "$postgres_db" <<'PY'
import sys
from urllib.parse import quote
user, password, database = (quote(value, safe="") for value in sys.argv[1:])
print(f"postgresql://{user}:{password}@postgres:5432/{database}?schema=public")
PY
    )
    echo "DATABASE_URL=$database_url" >> "$runtime_env"
fi
chown root:root "$runtime_env"
chmod 0600 "$runtime_env"

image_base=docker.io/$repository
umask 027
{
    echo "ZTPLANET_DEPLOY_MODE=pull"
    echo "ZTPLANET_IMAGE_RELEASE=$release"
    echo "ZTPLANET_RELEASE=$release"
    echo "ZTPLANET_POSTGRES_IMAGE=$image_base:postgres-$release"
    echo "ZTPLANET_ZEROTIER_IMAGE=$image_base:zerotier-$release"
    echo "ZTPLANET_ZTNET_IMAGE=$image_base:ztnet-$release"
    echo "ZTPLANET_GATEWAY_IMAGE=$image_base:gateway-$release"
    echo "ZTPLANET_RELAY_IMAGE=$image_base:relay-$release"
} > "$state_dir/images.env"
chown root:root "$state_dir/images.env"
chmod 0640 "$state_dir/images.env"

python3 "$install_dir/services/config-agent/ztplanet_agent.py" \
    --project-dir "$install_dir" --state-dir "$state_dir" \
    --socket-gid 1001 --gateway-gid 1002 --initialize-only

install -m 0644 "$install_dir/services/config-agent/ztplanet-agent.service" \
    /etc/systemd/system/ztplanet-agent.service
systemctl daemon-reload
systemctl enable ztplanet-agent.service
systemctl restart ztplanet-agent.service

cat <<EOF
1Panel 编排准备完成。
项目名称：ztplanet
Compose 文件：$install_dir/docker-compose.yml
环境变量文件：$state_dir/images.env
架构：$machine
版本：$release

请在 1Panel 的“容器 -> 编排”中新建项目，名称必须为 ztplanet，
选择“路径选择”并指定 $install_dir/docker-compose.yml，
然后添加环境变量：ZTPLANET_RELEASE=$release。
不要把 $runtime_env 中的密钥粘贴到 1Panel 或聊天中。
EOF
