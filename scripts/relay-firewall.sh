#!/bin/sh
set -eu

action=${1:-}
chain=ZTPLANET_RELAY_EGRESS
subnet=172.31.254.0/28

if ! command -v iptables >/dev/null 2>&1; then
    echo "iptables is required for relay egress isolation" >&2
    exit 1
fi

remove_rules() {
    while iptables -C DOCKER-USER -s "$subnet" -j "$chain" 2>/dev/null; do
        iptables -D DOCKER-USER -s "$subnet" -j "$chain"
    done
    iptables -F "$chain" 2>/dev/null || true
    iptables -X "$chain" 2>/dev/null || true
}

case "$action" in
    install)
        iptables -N "$chain" 2>/dev/null || true
        iptables -F "$chain"
        iptables -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
        for cidr in \
            0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
            169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 \
            192.88.99.0/24 \
            192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 \
            203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
            iptables -A "$chain" -d "$cidr" -j REJECT
        done
        iptables -A "$chain" -p udp -j RETURN
        iptables -A "$chain" -j REJECT
        iptables -C DOCKER-USER -s "$subnet" -j "$chain" 2>/dev/null || \
            iptables -I DOCKER-USER 1 -s "$subnet" -j "$chain"
        ;;
    remove)
        remove_rules
        ;;
    *)
        echo "usage: $0 install|remove" >&2
        exit 2
        ;;
esac
