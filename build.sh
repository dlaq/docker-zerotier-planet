#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"
COMPOSE_PROFILES=relay docker compose \
    -f docker-compose.yml -f docker-compose.build.yml build --pull
