#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -eq 0 ]; then
    set -- install
fi
exec "$script_dir/scripts/manage.sh" "$@"
