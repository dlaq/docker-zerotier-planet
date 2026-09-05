#!/bin/sh
set -eu

state_dir=/var/lib/zerotier-one
mkdir -p "$state_dir"
chown 0:1001 "$state_dir"
chmod 2770 "$state_dir"

/usr/sbin/zerotier-one -p9993 &
daemon_pid=$!

shutdown() {
    kill -TERM "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
}
trap shutdown TERM INT HUP

count=0
while [ ! -s "$state_dir/authtoken.secret" ]; do
    if ! kill -0 "$daemon_pid" 2>/dev/null; then
        wait "$daemon_pid"
        exit $?
    fi
    count=$((count + 1))
    if [ "$count" -gt 60 ]; then
        echo "ZeroTier did not create authtoken.secret" >&2
        shutdown
        exit 1
    fi
    sleep 1
done

chown 0:1001 "$state_dir/authtoken.secret"
chmod 0640 "$state_dir/authtoken.secret"
find "$state_dir" -maxdepth 1 -type d -exec chmod 2770 {} \;

wait "$daemon_pid"
