#!/bin/sh
set -eu

state_dir=/var/lib/zerotier-one
mkdir -p "$state_dir"
chown 0:1001 "$state_dir"
chmod 2770 "$state_dir"

ensure_token_permissions() {
    if [ -e "$state_dir/authtoken.secret" ]; then
        # ZeroTier may recreate this file after a daemon restart. Keep it
        # readable only by the controller process (UID 1001).
        chown 0:1001 "$state_dir/authtoken.secret" 2>/dev/null || true
        chmod 0640 "$state_dir/authtoken.secret" 2>/dev/null || true
    fi
}

# Older controller images sometimes persist a final LF/CRLF in the token file.
# ZeroTier's local API treats that byte as part of the token and returns 401,
# which in turn makes the container health check fail after a data migration.
# Normalize only the trailing line ending before starting the daemon; reject
# embedded whitespace instead of silently changing a malformed credential.
normalize_token_file() {
    token_file="$state_dir/authtoken.secret"
    if [ ! -f "$token_file" ]; then
        return 0
    fi

    normalized=$(sed '$s/\r$//' "$token_file") || {
        echo "Unable to read authtoken.secret" >&2
        return 1
    }
    case "$normalized" in
        ''|*[!A-Za-z0-9._-]*)
            echo "Invalid authtoken.secret format" >&2
            return 1
            ;;
    esac

    original_size=$(wc -c < "$token_file")
    normalized_size=$(printf '%s' "$normalized" | wc -c)
    if [ "$original_size" -eq "$normalized_size" ]; then
        return 0
    fi

    temporary="$state_dir/.authtoken.secret.$$"
    (umask 027; printf '%s' "$normalized" > "$temporary")
    chown 0:1001 "$temporary"
    chmod 0640 "$temporary"
    mv -f "$temporary" "$token_file"
}

normalize_token_file

/usr/sbin/zerotier-one -p9993 &
daemon_pid=$!
permissions_pid=""

shutdown() {
    if [ -n "$permissions_pid" ]; then
        kill -TERM "$permissions_pid" 2>/dev/null || true
        wait "$permissions_pid" 2>/dev/null || true
    fi
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

ensure_token_permissions
find "$state_dir" -maxdepth 1 -type d -exec chmod 2770 {} \;

(
    while kill -0 "$daemon_pid" 2>/dev/null; do
        ensure_token_permissions
        sleep 2
    done
) &
permissions_pid=$!

if wait "$daemon_pid"; then
    daemon_status=0
else
    daemon_status=$?
fi
kill -TERM "$permissions_pid" 2>/dev/null || true
wait "$permissions_pid" 2>/dev/null || true
exit "$daemon_status"
