#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
container_gate=false
if [ "${1:-}" = "--containers" ]; then
    container_gate=true
elif [ -n "${1:-}" ]; then
    echo "usage: $0 [--containers]" >&2
    exit 2
fi

command -v python3 >/dev/null
command -v npm >/dev/null
cargo_command=${CARGO_BIN:-cargo}
command -v "$cargo_command" >/dev/null

cd "$repo_dir/services/config-agent"
python3 -m py_compile ztplanet_agent.py
python3 -m unittest -v test_agent.py

cd "$repo_dir"
for file in build.sh deploy.sh scripts/*.sh services/zerotier/entrypoint.sh services/ztnet/init-db.sh; do
    sh -n "$file"
done
python3 -m json.tool security/relay-seccomp.json >/dev/null

# The production guide is intentionally a standalone deliverable. Fail the
# release if its embedded Compose ever drifts from the validated source file.
python3 - <<'PY'
from pathlib import Path
import re

root = Path.cwd()
document = (root / "docs/PRODUCTION-DEPLOYMENT.md").read_text(encoding="utf-8")
compose = (root / "docker-compose.1panel.yml").read_text(encoding="utf-8").rstrip("\n")
begin = "<!-- ZTPLANET-COMPOSE-BEGIN -->\n\n```yaml\n"
end = "\n```\n\n<!-- ZTPLANET-COMPOSE-END -->"
if document.count(begin) != 1 or document.count(end) != 1:
    raise SystemExit("Production guide must contain exactly one embedded Compose block")
embedded = document.split(begin, 1)[1].split(end, 1)[0]
if embedded != compose:
    raise SystemExit("Embedded production Compose differs from docker-compose.1panel.yml")
gateway_init = (
    'command: ["chown 0:0 /data /config && chmod 0700 /data /config '
    '&& chown -R 1002:1002 /data /config"]'
)
if gateway_init not in compose:
    raise SystemExit("gateway-init must remain idempotent with only CAP_CHOWN")
for required in (
    'chown 0:0 /data /backups',
    'chmod 0750 /data /backups',
    'chown -R 1001:1001 /data /backups',
    'chown 0:1001 /controller',
    'chmod 2750 /controller',
    'chown 0:1001 "/controller/$${file}"',
    'chmod 0640 "/controller/$${file}"',
    'condition: service_healthy',
    './data/zerotier:/controller',
):
    if required not in compose:
        raise SystemExit(f"ztnet-init missing controller permission guard: {required}")
healthcheck = 'test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:3000/favicon.ico\').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]'
if healthcheck not in compose:
    raise SystemExit("ZTNet healthcheck must probe a static asset and accept HTTP 4xx responses")
for compose_path in (
    root / "docker-compose.1panel.yml",
    root / "docker-compose.yml",
    root / "services/ztnet/docker-compose.yml",
):
    text = compose_path.read_text(encoding="utf-8")
    if re.search(r"(?m)^volumes:\s*$", text):
        raise SystemExit(f"{compose_path} must not declare top-level named volumes")
    named_mounts = [
        line for line in text.splitlines()
        if re.search(r"^\s*-\s+[A-Za-z0-9_.-]+:/", line)
    ]
    if named_mounts:
        raise SystemExit(f"{compose_path} contains named volume mounts: {named_mounts}")
for script_name in ("scripts/backup.sh", "scripts/restore.sh"):
    script = (root / script_name).read_text(encoding="utf-8")
    if "docker volume" in script or "ztplanet_" in script:
        raise SystemExit(f"{script_name} must operate on ./data bind directories")
PY

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    compose_db_password=ci-only-0123456789abcdef0123456789abcdef0123456789abcdef
    compose_auth_secret=ci-only-abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    ZTPLANET_DB_PASSWORD="$compose_db_password" \
        ZTPLANET_AUTH_SECRET="$compose_auth_secret" \
        docker compose -f docker-compose.1panel.yml config --quiet
    ZTPLANET_DB_PASSWORD="$compose_db_password" \
        ZTPLANET_AUTH_SECRET="$compose_auth_secret" \
        COMPOSE_PROFILES=relay \
        docker compose -f docker-compose.1panel.yml config --quiet
else
    echo "NOTE: Docker Compose is unavailable; standalone 1Panel Compose validation skipped." >&2
fi

cd "$repo_dir/services/relay"
"$cargo_command" fmt -- --check
"$cargo_command" test --locked
"$cargo_command" clippy --locked --all-targets -- -D warnings
"$cargo_command" build --locked
python3 tests/protocol_test.py

cd "$repo_dir/services/ztnet"
npm ci --ignore-scripts
npx prisma generate
npm audit --audit-level=low
test_auth_material=test-only-not-a-credential-000000000000000000000000
NEXTAUTH_URL=https://127.0.0.1:3443 \
NEXTAUTH_SECRET="$test_auth_material" \
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/test \
npx jest --runInBand --config jest.pages.config.ts
NEXTAUTH_URL=https://127.0.0.1:3443 \
NEXTAUTH_SECRET="$test_auth_material" \
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/test \
npx jest --runInBand --config jest.api.config.ts
NEXTAUTH_URL=https://127.0.0.1:3443 \
NEXTAUTH_SECRET="$test_auth_material" \
SKIP_ENV_VALIDATION=1 npm run build
if find .next/server/pages/api -type f -path '*__tests__*' -print -quit | grep -q .; then
    echo "Test files were emitted as production API routes" >&2
    exit 1
fi
if find .next/server/pages/api -type f -name '_schema.*' -print -quit | grep -q .; then
    echo "Schema helpers were emitted as production API routes" >&2
    exit 1
fi

cd "$repo_dir"
if command -v gitleaks >/dev/null 2>&1; then
    # Scan the delivered tree. Historical upstream false positives remain in the
    # inherited git history, but are not present in this release's files.
    gitleaks dir . --no-banner --redact
else
    echo "NOTE: gitleaks is not installed; CI/--containers gate must run secret scanning." >&2
fi

if [ "$container_gate" = true ]; then
    command -v docker >/dev/null
    command -v trivy >/dev/null
    docker info >/dev/null
    docker compose version >/dev/null
    security_postgres_password=security-gate-only-postgres-password
    security_auth_secret=security-gate-only-auth-secret-000000000000000000
    POSTGRES_PASSWORD="$security_postgres_password" \
        NEXTAUTH_SECRET="$security_auth_secret" \
        docker compose config --quiet
    POSTGRES_PASSWORD="$security_postgres_password" \
        NEXTAUTH_SECRET="$security_auth_secret" \
        COMPOSE_PROFILES=relay docker compose \
            -f docker-compose.yml -f docker-compose.build.yml build --pull
    mkdir -p "$repo_dir/audit/sbom"
    for image_id in \
        ztplanet-zerotier:latest \
        ztplanet-ztnet:latest \
        ztplanet-relay:latest \
        ztplanet-postgres:17 \
        ztplanet-gateway:2.11.4; do
        if ! docker image inspect "$image_id" >/dev/null 2>&1; then
            echo "Unable to find built image $image_id" >&2
            exit 1
        fi
        trivy image --exit-code 1 --severity CRITICAL,HIGH,MEDIUM --ignore-unfixed=false "$image_id"
        image=$(printf '%s' "$image_id" | tr ':/' '__')
        if command -v syft >/dev/null 2>&1; then
            syft "$image_id" -o spdx-json="$repo_dir/audit/sbom/${image}.spdx.json"
        else
            # Trivy is already mandatory for this gate and can emit the same
            # SPDX JSON deliverable when Syft is unavailable on a minimal host.
            trivy image --format spdx-json --output "$repo_dir/audit/sbom/${image}.spdx.json" "$image_id"
        fi
    done
    trivy config --exit-code 1 --severity CRITICAL,HIGH,MEDIUM "$repo_dir"
    trivy fs --exit-code 1 --severity CRITICAL,HIGH,MEDIUM --scanners vuln,secret \
        --skip-dirs "$repo_dir/services/ztnet/docs" \
        --skip-dirs "$repo_dir/services/ztnet/install.ztnet" \
        "$repo_dir"
fi

echo "Security gate passed (containers=$container_gate)."
