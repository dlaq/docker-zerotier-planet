#!/usr/bin/env python3
"""Restricted host configuration agent for the ZeroTier Planet stack.

The agent deliberately exposes only typed operations over a Unix socket.  It
does not accept commands, paths, Compose fragments, or environment names from
the web application.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socketserver
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

MAX_BODY = 1024 * 1024
MAX_AUDIT_RESULTS = 200
DOCKER_BIN = "/usr/bin/docker"
IP_BIN = "/usr/sbin/ip"
SS_BIN = "/usr/bin/ss"
OPENSSL_BIN = "/usr/bin/openssl"
SAFE_INTERFACE = re.compile(r"^zt[a-zA-Z0-9_-]{0,30}$")
SAFE_HOSTNAME = re.compile(
    r"^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$"
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def default_config() -> dict[str, Any]:
    return {
        "management": {
            "publicUrl": "https://127.0.0.1:3443",
            "listeners": [
                {
                    "address": "127.0.0.1",
                    "port": 3443,
                    "tlsMode": "self-signed",
                    "allowedCidrs": [],
                }
            ],
            "allowZeroTier": False,
            "zeroTierInterface": "",
            "zeroTierAddress": "",
            "sessionMaxAgeSeconds": 28800,
            "loginAttempts": 5,
            "loginLockoutSeconds": 900,
        },
        "zerotier": {
            "enabled": True,
            # Intentional ZeroTier UDP default; management remains loopback-only.
            "bindAddress": "0.0.0.0",  # nosec B104
            "publicPort": 9993,
            "secondaryPort": 0,
            "tertiaryPort": 0,
            "allowSecondaryPort": True,
            "portMappingEnabled": True,
        },
        "controller": {
            "exposure": "internal",
            "bindAddress": "127.0.0.1",
            "port": 9993,
        },
        "relayServer": {
            "enabled": False,
            # Wildcard is inert until an admin explicitly enables the relay.
            "bindAddress": "0.0.0.0",  # nosec B104
            "port": 443,
            "allowedSourceCidrs": [],
            "maxConnections": 128,
            "maxConnectionsPerIp": 4,
            "packetsPerSecond": 200,
            "bytesPerSecond": 2097152,
            "globalPacketsPerSecond": 2000,
            "globalBytesPerSecond": 20971520,
            "handshakeTimeoutSeconds": 10,
            "idleTimeoutSeconds": 300,
            "maxDestinations": 64,
            "minDestinationPort": 1025,
        },
        "relayClient": {
            "mode": "off",
            "host": "",
            "port": 443,
        },
    }


class ValidationError(ValueError):
    pass


def require_dict(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{name} must be an object")
    return value


def require_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValidationError(f"{name} must be a boolean")
    return value


def require_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValidationError(f"{name} must be an integer from {minimum} to {maximum}")
    return value


def require_ip(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{name} must be an IP address")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as error:
        raise ValidationError(f"{name} must be an IP address") from error


def require_cidrs(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or len(value) > 64:
        raise ValidationError(f"{name} must be a list with at most 64 entries")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValidationError(f"{name} contains a non-string value")
        try:
            result.append(str(ipaddress.ip_network(item, strict=False)))
        except ValueError as error:
            raise ValidationError(f"{name} contains invalid CIDR {item!r}") from error
    return result


def require_host(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 253:
        raise ValidationError(f"{name} must be a host name or IP address")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if not SAFE_HOSTNAME.fullmatch(value):
            raise ValidationError(f"{name} must be a host name or IP address")
        return value.rstrip(".").lower()


def bindings_overlap(left_address: str, left_port: int, right_address: str, right_port: int) -> bool:
    if left_port != right_port:
        return False
    left = ipaddress.ip_address(left_address)
    right = ipaddress.ip_address(right_address)
    return left.version == right.version and (left == right or left.is_unspecified or right.is_unspecified)


def validate_config(raw: Any) -> tuple[dict[str, Any], list[str]]:
    root = require_dict(raw, "config")
    expected = {"management", "zerotier", "controller", "relayServer", "relayClient"}
    if set(root) != expected:
        raise ValidationError(f"config keys must be exactly: {', '.join(sorted(expected))}")
    warnings: list[str] = []

    management = require_dict(root["management"], "management")
    listeners = management.get("listeners")
    if not isinstance(listeners, list) or not 1 <= len(listeners) <= 16:
        raise ValidationError("management.listeners must contain 1 to 16 listeners")
    clean_listeners = []
    seen: set[tuple[str, int]] = set()
    for index, item in enumerate(listeners):
        listener = require_dict(item, f"management.listeners[{index}]")
        address = require_ip(listener.get("address"), f"management.listeners[{index}].address")
        port = require_int(listener.get("port"), f"management.listeners[{index}].port", 1, 65535)
        tls_mode = listener.get("tlsMode")
        if tls_mode not in {"off", "self-signed", "files"}:
            raise ValidationError(f"management.listeners[{index}].tlsMode is invalid")
        allowed = require_cidrs(
            listener.get("allowedCidrs", []), f"management.listeners[{index}].allowedCidrs"
        )
        key = (address, port)
        if key in seen:
            raise ValidationError(f"duplicate management listener {address}:{port}")
        seen.add(key)
        if any(bindings_overlap(address, port, item["address"], item["port"]) for item in clean_listeners):
            raise ValidationError(f"management listener {address}:{port} overlaps another listener")
        ip = ipaddress.ip_address(address)
        if ip.is_unspecified:
            warnings.append(f"management listener {address}:{port} accepts every local interface")
        elif not ip.is_private and not ip.is_loopback:
            warnings.append(f"management listener {address}:{port} is bound to a public address")
        if tls_mode == "off":
            warnings.append(f"management listener {address}:{port} uses clear-text HTTP")
        if not allowed and not ip.is_loopback:
            warnings.append(f"management listener {address}:{port} has no source CIDR restriction")
        clean_listeners.append(
            {"address": address, "port": port, "tlsMode": tls_mode, "allowedCidrs": allowed}
        )

    public_url = management.get("publicUrl")
    if not isinstance(public_url, str) or len(public_url) > 512:
        raise ValidationError("management.publicUrl is invalid")
    parsed_url = urlparse(public_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname or parsed_url.path not in {"", "/"}:
        raise ValidationError("management.publicUrl must be an http(s) origin without a path")
    if parsed_url.username or parsed_url.password or parsed_url.query or parsed_url.fragment:
        raise ValidationError("management.publicUrl must not contain credentials, query, or fragment")
    try:
        public_port = parsed_url.port or (443 if parsed_url.scheme == "https" else 80)
    except ValueError as error:
        raise ValidationError("management.publicUrl contains an invalid port") from error
    if not any(item["port"] == public_port for item in clean_listeners):
        warnings.append("management.publicUrl port is not present in the configured management listeners")
    if parsed_url.scheme == "https" and not any(
        item["port"] == public_port and item["tlsMode"] != "off" for item in clean_listeners
    ):
        warnings.append("management.publicUrl uses HTTPS but no listener on that port has TLS")

    allow_zt = require_bool(management.get("allowZeroTier"), "management.allowZeroTier")
    zt_interface = management.get("zeroTierInterface", "")
    zt_address = management.get("zeroTierAddress", "")
    if not isinstance(zt_interface, str) or not isinstance(zt_address, str):
        raise ValidationError("ZeroTier management interface and address must be strings")
    if allow_zt:
        if not SAFE_INTERFACE.fullmatch(zt_interface):
            raise ValidationError("management.zeroTierInterface must be a zt* interface name")
        zt_address = require_ip(zt_address, "management.zeroTierAddress")
        if all(item["address"] != zt_address for item in clean_listeners):
            warnings.append("ZeroTier management access adds a listener inheriting the first listener's port, TLS and CIDR policy")

    clean_management = {
        "publicUrl": public_url.rstrip("/"),
        "listeners": clean_listeners,
        "allowZeroTier": allow_zt,
        "zeroTierInterface": zt_interface,
        "zeroTierAddress": zt_address,
        "sessionMaxAgeSeconds": require_int(
            management.get("sessionMaxAgeSeconds"), "management.sessionMaxAgeSeconds", 900, 28800
        ),
        "loginAttempts": require_int(management.get("loginAttempts"), "management.loginAttempts", 1, 20),
        "loginLockoutSeconds": require_int(
            management.get("loginLockoutSeconds"), "management.loginLockoutSeconds", 60, 86400
        ),
    }

    zerotier = require_dict(root["zerotier"], "zerotier")
    clean_zerotier = {
        "enabled": require_bool(zerotier.get("enabled"), "zerotier.enabled"),
        "bindAddress": require_ip(zerotier.get("bindAddress"), "zerotier.bindAddress"),
        "publicPort": require_int(zerotier.get("publicPort"), "zerotier.publicPort", 1, 65535),
        "secondaryPort": require_int(zerotier.get("secondaryPort", 0), "zerotier.secondaryPort", 0, 65535),
        "tertiaryPort": require_int(zerotier.get("tertiaryPort", 0), "zerotier.tertiaryPort", 0, 65535),
        "allowSecondaryPort": require_bool(
            zerotier.get("allowSecondaryPort"), "zerotier.allowSecondaryPort"
        ),
        "portMappingEnabled": require_bool(
            zerotier.get("portMappingEnabled"), "zerotier.portMappingEnabled"
        ),
    }
    configured_udp_ports = [
        clean_zerotier["publicPort"],
        *[port for port in (clean_zerotier["secondaryPort"], clean_zerotier["tertiaryPort"]) if port],
    ]
    if len(configured_udp_ports) != len(set(configured_udp_ports)):
        raise ValidationError("ZeroTier public, secondary and tertiary UDP ports must be distinct")

    controller = require_dict(root["controller"], "controller")
    exposure = controller.get("exposure")
    if exposure not in {"internal", "direct", "https"}:
        raise ValidationError("controller.exposure is invalid")
    clean_controller = {
        "exposure": exposure,
        "bindAddress": require_ip(controller.get("bindAddress"), "controller.bindAddress"),
        "port": require_int(controller.get("port"), "controller.port", 1, 65535),
    }
    if exposure == "direct":
        warnings.append("the token-authenticated Controller API is directly exposed without TLS")
    if exposure == "https" and any(item["tlsMode"] == "off" for item in clean_listeners):
        warnings.append("Controller API proxy is also reachable over listeners where TLS is disabled")

    relay = require_dict(root["relayServer"], "relayServer")
    clean_relay = {
        "enabled": require_bool(relay.get("enabled"), "relayServer.enabled"),
        "bindAddress": require_ip(relay.get("bindAddress"), "relayServer.bindAddress"),
        "port": require_int(relay.get("port"), "relayServer.port", 1, 65535),
        "allowedSourceCidrs": require_cidrs(
            relay.get("allowedSourceCidrs", []), "relayServer.allowedSourceCidrs"
        ),
        "maxConnections": require_int(relay.get("maxConnections"), "relayServer.maxConnections", 1, 4096),
        "maxConnectionsPerIp": require_int(
            relay.get("maxConnectionsPerIp"), "relayServer.maxConnectionsPerIp", 1, 256
        ),
        "packetsPerSecond": require_int(
            relay.get("packetsPerSecond"), "relayServer.packetsPerSecond", 1, 100000
        ),
        "bytesPerSecond": require_int(
            relay.get("bytesPerSecond"), "relayServer.bytesPerSecond", 1024, 1073741824
        ),
        "globalPacketsPerSecond": require_int(
            relay.get("globalPacketsPerSecond"), "relayServer.globalPacketsPerSecond", 1, 1000000
        ),
        "globalBytesPerSecond": require_int(
            relay.get("globalBytesPerSecond"), "relayServer.globalBytesPerSecond", 1024, 10737418240
        ),
        "handshakeTimeoutSeconds": require_int(
            relay.get("handshakeTimeoutSeconds"), "relayServer.handshakeTimeoutSeconds", 1, 60
        ),
        "idleTimeoutSeconds": require_int(
            relay.get("idleTimeoutSeconds"), "relayServer.idleTimeoutSeconds", 30, 3600
        ),
        "maxDestinations": require_int(
            relay.get("maxDestinations"), "relayServer.maxDestinations", 1, 1024
        ),
        "minDestinationPort": require_int(
            relay.get("minDestinationPort"), "relayServer.minDestinationPort", 1, 65535
        ),
    }
    if any(ipaddress.ip_network(cidr).version != 4 for cidr in clean_relay["allowedSourceCidrs"]):
        raise ValidationError("relayServer.allowedSourceCidrs currently supports IPv4 CIDRs only")
    if clean_relay["enabled"] and not clean_relay["allowedSourceCidrs"]:
        warnings.append("TCP relay accepts clients from any source and the protocol has no client authentication")
    relay_address = ipaddress.ip_address(clean_relay["bindAddress"])
    if clean_relay["enabled"] and (
        relay_address.is_unspecified or (not relay_address.is_private and not relay_address.is_loopback)
    ):
        warnings.append("TCP relay is bound to a public or wildcard address")

    relay_client = require_dict(root["relayClient"], "relayClient")
    mode = relay_client.get("mode")
    if mode not in {"off", "official-auto", "custom-auto", "custom-force"}:
        raise ValidationError("relayClient.mode is invalid")
    host = relay_client.get("host", "")
    if mode in {"custom-auto", "custom-force"}:
        host = require_host(host, "relayClient.host")
    elif not isinstance(host, str):
        raise ValidationError("relayClient.host must be a string")
    clean_client = {
        "mode": mode,
        "host": host,
        "port": require_int(relay_client.get("port"), "relayClient.port", 1, 65535),
    }
    if mode == "custom-force":
        warnings.append("forceTcpRelay disables direct UDP transmission and should normally be used only for testing")

    conflict_listeners = effective_management_listeners({"management": clean_management})
    if clean_relay["enabled"] and any(bindings_overlap(
        clean_relay["bindAddress"], clean_relay["port"], item["address"], item["port"]
    ) for item in conflict_listeners):
        raise ValidationError("TCP relay conflicts with a management listener")
    if clean_controller["exposure"] == "direct" and any(bindings_overlap(
        clean_controller["bindAddress"], clean_controller["port"], item["address"], item["port"]
    ) for item in conflict_listeners):
        raise ValidationError("Controller API conflicts with a management listener")
    if clean_relay["enabled"] and clean_controller["exposure"] == "direct" and bindings_overlap(
        clean_relay["bindAddress"], clean_relay["port"],
        clean_controller["bindAddress"], clean_controller["port"],
    ):
        raise ValidationError("TCP relay conflicts with the directly exposed Controller API")

    return {
        "management": clean_management,
        "zerotier": clean_zerotier,
        "controller": clean_controller,
        "relayServer": clean_relay,
        "relayClient": clean_client,
    }, warnings


class Agent:
    def __init__(
        self,
        state_dir: Path,
        project_dir: Path,
        apply_docker: bool = True,
        runtime_gid: int | None = None,
        gateway_gid: int | None = None,
    ):
        self.state_dir = state_dir
        self.project_dir = project_dir
        self.generated_dir = state_dir / "generated"
        self.history_dir = state_dir / "history"
        self.config_path = state_dir / "config.json"
        self.audit_path = state_dir / "audit.jsonl"
        self.secret_path = state_dir / "agent.secret"
        self.apply_docker = apply_docker
        self.runtime_gid = runtime_gid
        self.gateway_gid = gateway_gid
        self.lock = threading.RLock()
        self.idempotency: dict[str, dict[str, Any]] = {}
        for directory in (state_dir, self.generated_dir, self.history_dir, state_dir / "tls"):
            directory.mkdir(parents=True, exist_ok=True, mode=0o750)
            if os.geteuid() == 0:
                directory_gid = gateway_gid if directory == state_dir / "tls" else 0
                os.chown(directory, 0, directory_gid or 0)
                # Group traversal is required; write remains owner-only.
                os.chmod(directory, 0o750)  # nosec B103
        if not self.secret_path.exists():
            atomic_write(self.secret_path, secrets.token_hex(32) + "\n", 0o640)
        if not self.config_path.exists():
            envelope = {"revision": 1, "updatedAt": utc_now(), "config": default_config()}
            atomic_write_json(self.config_path, envelope, 0o640)
            self.render(envelope["config"])
        self.make_runtime_readable(self.secret_path)

    def make_runtime_readable(self, path: Path) -> None:
        if self.runtime_gid is not None and os.geteuid() == 0:
            os.chown(path, 0, self.runtime_gid)

    def make_gateway_readable(self, path: Path) -> None:
        if self.gateway_gid is not None and os.geteuid() == 0:
            os.chown(path, 0, self.gateway_gid)

    def compose_command(self) -> list[str]:
        return [
            DOCKER_BIN, "compose",
            "--project-directory", str(self.project_dir),
            "--env-file", str(self.state_dir / "runtime.env"),
            "--env-file", str(self.state_dir / "images.env"),
            "--env-file", str(self.generated_dir / "stack.env"),
            "-f", str(self.project_dir / "docker-compose.yml"),
            "-f", str(self.generated_dir / "compose.override.yml"),
        ]

    def secret(self) -> bytes:
        return self.secret_path.read_text(encoding="utf-8").strip().encode()

    def envelope(self) -> dict[str, Any]:
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def validate(self, raw: Any) -> dict[str, Any]:
        config, warnings = validate_config(raw)
        return {"valid": True, "config": config, "warnings": warnings, "risky": bool(warnings)}

    def apply(self, request: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.lock:
            key = request.get("idempotencyKey")
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", key):
                raise ValidationError("idempotencyKey is required")
            if key in self.idempotency:
                return self.idempotency[key]
            current = self.envelope()
            expected = request.get("expectedRevision")
            if expected != current["revision"]:
                raise ConflictError(f"revision changed from {expected} to {current['revision']}")
            config, warnings = validate_config(request.get("config"))
            history_path = self.history_dir / f"revision-{current['revision']:08d}.json"
            atomic_write_json(history_path, current, 0o640)
            updated = {
                "revision": current["revision"] + 1,
                "updatedAt": utc_now(),
                "config": config,
            }
            try:
                atomic_write_json(self.config_path, updated, 0o640)
                self.render(config)
                services = changed_services(current["config"], config)
                runtime = self.apply_runtime(services, config)
            except Exception:
                atomic_write_json(self.config_path, current, 0o640)
                self.render(current["config"])
                try:
                    self.apply_runtime(changed_services(config, current["config"]), current["config"])
                except Exception as rollback_error:
                    self.audit("rollback-failed", actor, {"error": str(rollback_error)})
                raise
            result = {"applied": True, **updated, "warnings": warnings, "runtime": runtime}
            self.idempotency[key] = result
            if len(self.idempotency) > 256:
                self.idempotency.pop(next(iter(self.idempotency)))
            self.audit("apply", actor, {"revision": updated["revision"], "services": services, "warnings": warnings})
            return result

    def rollback(self, actor: str) -> dict[str, Any]:
        with self.lock:
            candidates = sorted(self.history_dir.glob("revision-*.json"), reverse=True)
            if not candidates:
                raise ValidationError("no previous revision is available")
            target = json.loads(candidates[0].read_text(encoding="utf-8"))
            current = self.envelope()
            target["revision"] = current["revision"] + 1
            target["updatedAt"] = utc_now()
            try:
                atomic_write_json(self.config_path, target, 0o640)
                self.render(target["config"])
                runtime = self.apply_runtime(changed_services(current["config"], target["config"]), target["config"])
            except Exception:
                atomic_write_json(self.config_path, current, 0o640)
                self.render(current["config"])
                self.apply_runtime(changed_services(target["config"], current["config"]), current["config"])
                raise
            candidates[0].unlink(missing_ok=True)
            self.audit("rollback", actor, {"revision": target["revision"]})
            return {"rolledBack": True, **target, "runtime": runtime}

    def render(self, config: dict[str, Any]) -> None:
        self.generated_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
        relay = config["relayServer"]
        zt = config["zerotier"]
        management = config["management"]
        controller = config["controller"]
        client = config["relayClient"]
        env_lines = {
            "COMPOSE_PROFILES": "relay" if relay["enabled"] else "",
            "NEXTAUTH_URL": management["publicUrl"],
            "NEXTAUTH_SESSION_MAX_AGE": str(management["sessionMaxAgeSeconds"]),
            "ZTPLANET_LOGIN_ATTEMPTS": str(management["loginAttempts"]),
            "ZTPLANET_LOGIN_LOCKOUT_SECONDS": str(management["loginLockoutSeconds"]),
            "ZT_BIND_ADDRESS": zt["bindAddress"],
            "ZT_PUBLIC_PORT": str(zt["publicPort"]),
            "CONTROLLER_BIND_ADDRESS": controller["bindAddress"],
            "CONTROLLER_PORT": str(controller["port"]),
            "CONTROLLER_EXPOSURE": controller["exposure"],
            "RELAY_BIND_ADDRESS": relay["bindAddress"],
            "RELAY_PORT": str(relay["port"]),
            "RELAY_ALLOWED_CIDRS": ",".join(relay["allowedSourceCidrs"]),
            "RELAY_MAX_CONNECTIONS": str(relay["maxConnections"]),
            "RELAY_MAX_CONNECTIONS_PER_IP": str(relay["maxConnectionsPerIp"]),
            "RELAY_PACKETS_PER_SECOND": str(relay["packetsPerSecond"]),
            "RELAY_BYTES_PER_SECOND": str(relay["bytesPerSecond"]),
            "RELAY_GLOBAL_PACKETS_PER_SECOND": str(relay["globalPacketsPerSecond"]),
            "RELAY_GLOBAL_BYTES_PER_SECOND": str(relay["globalBytesPerSecond"]),
            "RELAY_HANDSHAKE_TIMEOUT_SECONDS": str(relay["handshakeTimeoutSeconds"]),
            "RELAY_IDLE_TIMEOUT_SECONDS": str(relay["idleTimeoutSeconds"]),
            "RELAY_MAX_DESTINATIONS": str(relay["maxDestinations"]),
            "RELAY_MIN_DESTINATION_PORT": str(relay["minDestinationPort"]),
        }
        atomic_write(
            self.generated_dir / "stack.env",
            "".join(f"{key}={dotenv_escape(value)}\n" for key, value in sorted(env_lines.items())),
            0o640,
        )
        local_settings: dict[str, Any] = {
            "primaryPort": 9993,
            "allowManagementFrom": ["127.0.0.1", "172.31.255.0/24"],
            "allowSecondaryPort": zt["allowSecondaryPort"],
            "portMappingEnabled": zt["portMappingEnabled"],
            "allowTcpFallbackRelay": client["mode"] != "off",
            "forceTcpRelay": client["mode"] == "custom-force",
        }
        if zt["secondaryPort"]:
            local_settings["secondaryPort"] = zt["secondaryPort"]
        if zt["tertiaryPort"]:
            local_settings["tertiaryPort"] = zt["tertiaryPort"]
        if client["mode"] in {"custom-auto", "custom-force"}:
            local_settings["tcpFallbackRelay"] = f"{client['host']}/{client['port']}"
        atomic_write_json(self.generated_dir / "local.conf", {"settings": local_settings}, 0o640)
        atomic_write_json(self.generated_dir / "client-local.conf", {"settings": {
            key: value for key, value in local_settings.items()
            if key in {"allowTcpFallbackRelay", "forceTcpRelay", "tcpFallbackRelay"}
        }}, 0o640)
        atomic_write(self.generated_dir / "Caddyfile", render_caddy(config), 0o640)
        self.make_gateway_readable(self.generated_dir / "Caddyfile")
        atomic_write(self.generated_dir / "compose.override.yml", render_compose_override(config), 0o640)
        manifest = {}
        for name in ("stack.env", "local.conf", "client-local.conf", "Caddyfile", "compose.override.yml"):
            manifest[name] = sha256_file(self.generated_dir / name)
        atomic_write_json(self.generated_dir / "manifest.json", manifest, 0o640)

    def apply_runtime(self, services: list[str], config: dict[str, Any]) -> dict[str, Any]:
        if not self.apply_docker:
            return {"mode": "render-only", "services": services}
        compose = self.compose_command()
        firewall = self.project_dir / "scripts" / "relay-firewall.sh"
        if config["relayServer"]["enabled"]:
            subprocess.run([str(firewall), "install"], check=True, timeout=30)
        if not config["relayServer"]["enabled"]:
            subprocess.run(compose + ["stop", "relay"], check=False, timeout=60)
            subprocess.run([str(firewall), "remove"], check=False, timeout=30)
        # Explicitly naming a Compose service starts it even when its profile is
        # disabled. A relay-off change must stop it, never include it in `up`.
        selected = [name for name in services if name != "relay" or config["relayServer"]["enabled"]]
        if not selected:
            return {"mode": "docker", "services": [], "running": []}
        completed = subprocess.run(
            compose + ["up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "--no-deps", "--force-recreate", *selected],
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"docker compose apply failed: {completed.stderr[-2000:]}")
        health = subprocess.run(
            compose + ["ps", "--format", "json"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        records: list[dict[str, Any]] = []
        try:
            parsed = json.loads(health.stdout or "[]")
            records = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError:
            for line in health.stdout.splitlines():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        running = {
            str(item.get("Service")) for item in records
            if str(item.get("State", "")).lower() == "running"
            and str(item.get("Health", "")).lower() not in {"unhealthy", "starting"}
        }
        required = {name for name in selected if name != "relay" or config["relayServer"]["enabled"]}
        missing = sorted(required - running)
        if health.returncode != 0 or missing:
            raise RuntimeError(f"services failed health check: {', '.join(missing)}")
        return {"mode": "docker", "services": selected, "running": sorted(running)}

    def status(self) -> dict[str, Any]:
        envelope = self.envelope()
        manifest_path = self.generated_dir / "manifest.json"
        drift: list[str] = []
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for name, expected in manifest.items():
                path = self.generated_dir / name
                if not path.exists() or sha256_file(path) != expected:
                    drift.append(name)
        interfaces = []
        try:
            proc = subprocess.run(
                [IP_BIN, "-json", "address", "show"], capture_output=True, text=True, timeout=5, check=False
            )
            for interface in json.loads(proc.stdout or "[]"):
                if interface.get("ifname", "").startswith("zt"):
                    interfaces.append({
                        "name": interface["ifname"],
                        "addresses": [item.get("local") for item in interface.get("addr_info", []) if item.get("local")],
                    })
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        actual_listeners: list[dict[str, str]] = []
        try:
            proc = subprocess.run(
                [SS_BIN, "-H", "-lntu"], capture_output=True, text=True, timeout=5, check=False
            )
            for line in proc.stdout.splitlines()[:1024]:
                columns = line.split()
                if len(columns) >= 5:
                    actual_listeners.append({"protocol": columns[0], "endpoint": columns[4]})
        except (OSError, subprocess.SubprocessError):
            pass
        relay_metrics: dict[str, float] = {}
        if envelope["config"]["relayServer"]["enabled"]:
            try:
                # Fixed scheme, address and path; no user-controlled URL reaches urlopen.
                with urlopen("http://172.31.254.2:9090/metrics", timeout=2) as response:  # nosec B310
                    for line in response.read(131072).decode("utf-8", "replace").splitlines():
                        if line.startswith("zt_relay_"):
                            key, value = line.split(None, 1)
                            relay_metrics[key] = float(value)
            except (OSError, ValueError):
                pass
        config = envelope["config"]
        exposures: list[dict[str, Any]] = []
        for listener in effective_management_listeners(config):
            address = ipaddress.ip_address(listener["address"])
            risk = "high" if address.is_unspecified or (not address.is_private and not address.is_loopback) else (
                "low" if address.is_loopback else "private-network"
            )
            exposures.append({
                "purpose": "Management UI" + (" + Controller API" if config["controller"]["exposure"] == "https" else ""),
                "protocol": "tcp",
                "address": listener["address"],
                "port": listener["port"],
                "tls": listener["tlsMode"],
                "authentication": "session + administrator role",
                "allowedSources": listener["allowedCidrs"] or ["any"],
                "health": "listening" if listener_is_present(actual_listeners, "tcp", listener["port"], listener["address"]) else "not-observed",
                "risk": risk,
            })
        if config["zerotier"]["enabled"]:
            exposures.append({
                "purpose": "ZeroTier root/data plane", "protocol": "udp",
                "address": config["zerotier"]["bindAddress"], "port": config["zerotier"]["publicPort"],
                "tls": "ZeroTier wire encryption", "authentication": "ZeroTier identity",
                "allowedSources": ["any"],
                "health": "listening" if listener_is_present(actual_listeners, "udp", config["zerotier"]["publicPort"], config["zerotier"]["bindAddress"]) else "not-observed",
                "risk": "intended-public-service",
            })
        if config["controller"]["exposure"] == "direct":
            exposures.append({
                "purpose": "Controller API", "protocol": "tcp",
                "address": config["controller"]["bindAddress"], "port": config["controller"]["port"],
                "tls": "off", "authentication": "bearer token",
                "allowedSources": ["any"],
                "health": "listening" if listener_is_present(actual_listeners, "tcp", config["controller"]["port"], config["controller"]["bindAddress"]) else "not-observed",
                "risk": "high",
            })
        if config["relayServer"]["enabled"]:
            relay = config["relayServer"]
            exposures.append({
                "purpose": "TCP fallback relay", "protocol": "tcp",
                "address": relay["bindAddress"], "port": relay["port"],
                "tls": "fake TLS framing (not TLS)", "authentication": "none in protocol",
                "allowedSources": relay["allowedSourceCidrs"] or ["any"],
                "health": "listening" if listener_is_present(actual_listeners, "tcp", relay["port"], relay["bindAddress"]) else "not-observed",
                "risk": "high" if not relay["allowedSourceCidrs"] else "restricted-source",
            })
        return {
            **envelope,
            "drift": drift,
            "zeroTierInterfaces": interfaces,
            "effectiveManagementListeners": effective_management_listeners(envelope["config"]),
            "actualListeners": actual_listeners,
            "relayMetrics": relay_metrics,
            "exposures": exposures,
        }

    def generate_certificate(self, names: list[str], actor: str) -> dict[str, Any]:
        if not isinstance(names, list) or not 1 <= len(names) <= 16:
            raise ValidationError("names must contain 1 to 16 IP addresses or host names")
        san_items = []
        for raw in names:
            if not isinstance(raw, str):
                raise ValidationError("certificate names must be strings")
            try:
                san_items.append(f"IP:{ipaddress.ip_address(raw)}")
            except ValueError:
                san_items.append(f"DNS:{require_host(raw, 'certificate name')}")
        cert_path = self.state_dir / "tls" / "self-signed.crt"
        key_path = self.state_dir / "tls" / "self-signed.key"
        tmp_dir = Path(tempfile.mkdtemp(prefix="certificate-", dir=self.state_dir / "tls"))
        try:
            tmp_cert = tmp_dir / "certificate.crt"
            tmp_key = tmp_dir / "certificate.key"
            subprocess.run(
                [
                    OPENSSL_BIN, "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes",
                    "-days", "825", "-subj", "/CN=ZeroTier Planet Management",
                    "-addext", f"subjectAltName={','.join(san_items)}",
                    "-keyout", str(tmp_key), "-out", str(tmp_cert),
                ],
                check=True,
                capture_output=True,
                timeout=30,
            )
            os.replace(tmp_cert, cert_path)
            os.replace(tmp_key, key_path)
            os.chmod(cert_path, 0o644)
            os.chmod(key_path, 0o640)
            self.make_runtime_readable(cert_path)
            self.make_runtime_readable(key_path)
            self.make_gateway_readable(cert_path)
            self.make_gateway_readable(key_path)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        self.audit("certificate-generated", actor, {"names": names})
        return {"generated": True, "certificate": str(cert_path), "names": names}

    def install_custom_certificate(self, certificate: Any, private_key: Any, actor: str) -> dict[str, Any]:
        if not isinstance(certificate, str) or not isinstance(private_key, str):
            raise ValidationError("certificate and privateKey must be PEM strings")
        if not 256 <= len(certificate) <= 262144 or not 256 <= len(private_key) <= 262144:
            raise ValidationError("certificate or private key size is invalid")
        if "-----BEGIN CERTIFICATE-----" not in certificate or "PRIVATE KEY-----" not in private_key:
            raise ValidationError("certificate and privateKey must use PEM encoding")
        tls_dir = self.state_dir / "tls"
        tmp_dir = Path(tempfile.mkdtemp(prefix="custom-certificate-", dir=tls_dir))
        try:
            tmp_cert = tmp_dir / "custom.crt"
            tmp_key = tmp_dir / "custom.key"
            atomic_write(tmp_cert, certificate.rstrip() + "\n", 0o644)
            atomic_write(tmp_key, private_key.rstrip() + "\n", 0o600)
            cert_key = subprocess.run(
                [OPENSSL_BIN, "x509", "-in", str(tmp_cert), "-pubkey", "-noout"],
                check=True, capture_output=True, timeout=15,
            ).stdout
            private_public = subprocess.run(
                [OPENSSL_BIN, "pkey", "-in", str(tmp_key), "-pubout"],
                check=True, capture_output=True, timeout=15,
            ).stdout
            if not hmac.compare_digest(cert_key, private_public):
                raise ValidationError("certificate does not match the private key")
            subprocess.run(
                [OPENSSL_BIN, "x509", "-in", str(tmp_cert), "-noout", "-checkend", "0"],
                check=True, capture_output=True, timeout=15,
            )
            cert_path = tls_dir / "custom.crt"
            key_path = tls_dir / "custom.key"
            os.replace(tmp_cert, cert_path)
            os.replace(tmp_key, key_path)
            os.chmod(cert_path, 0o644)
            os.chmod(key_path, 0o640)
            self.make_gateway_readable(cert_path)
            self.make_gateway_readable(key_path)
        except subprocess.CalledProcessError as error:
            raise ValidationError("certificate or private key validation failed") from error
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        self.audit("custom-certificate-installed", actor, {"certificateBytes": len(certificate)})
        return {"installed": True}

    def rotate_controller_token(self, actor: str) -> dict[str, Any]:
        if not self.apply_docker:
            self.audit("controller-token-rotation-preview", actor, {})
            return {"rotated": False, "mode": "render-only"}
        token = secrets.token_hex(32) + "\n"
        compose = self.compose_command()
        fixed_script = (
            "umask 027; p=/var/lib/zerotier-one/authtoken.secret; "
            "t=/var/lib/zerotier-one/.authtoken.secret.new; cat >$t; "
            "chown 0:1001 $t; chmod 0640 $t; mv -f $t $p"
        )
        completed = subprocess.run(
            compose + ["exec", "-T", "zerotier", "sh", "-eu", "-c", fixed_script],
            input=token, text=True, capture_output=True, timeout=30, check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError("Controller token rotation failed")
        subprocess.run(compose + ["restart", "zerotier", "ztnet"], check=True, timeout=120)
        self.audit("controller-token-rotated", actor, {})
        return {"rotated": True}

    def audit(self, action: str, actor: str, details: dict[str, Any]) -> None:
        event = {"time": utc_now(), "action": action, "actor": actor[:128], "details": details}
        with self.audit_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(self.audit_path, 0o640)

    def audit_events(self) -> list[dict[str, Any]]:
        if not self.audit_path.exists():
            return []
        lines = self.audit_path.read_text(encoding="utf-8").splitlines()[-MAX_AUDIT_RESULTS:]
        return [json.loads(line) for line in reversed(lines) if line]


class ConflictError(RuntimeError):
    pass


def changed_services(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    services = set()
    if old["management"] != new["management"]:
        services.update({"gateway", "ztnet"})
    if old["zerotier"] != new["zerotier"] or old["relayClient"] != new["relayClient"]:
        services.update({"zerotier", "ztnet"})
    if old["controller"] != new["controller"]:
        services.update({"zerotier", "gateway", "ztnet"})
    if old["relayServer"] != new["relayServer"]:
        services.add("relay")
    return sorted(services)


def listener_is_present(listeners: list[dict[str, str]], protocol: str, port: int, address: str) -> bool:
    expected = ipaddress.ip_address(address)
    for item in listeners:
        if not item.get("protocol", "").lower().startswith(protocol):
            continue
        host, separator, actual_port = item.get("endpoint", "").rpartition(":")
        if not separator or actual_port != str(port):
            continue
        try:
            actual = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            # `ss` may print `*` for a dual-stack socket; its address family
            # cannot be inferred reliably, so leave it unconfirmed.
            continue
        if actual.version == expected.version and (actual == expected or actual.is_unspecified):
            return True
    return False


def effective_management_listeners(config: dict[str, Any]) -> list[dict[str, Any]]:
    listeners = copy.deepcopy(config["management"]["listeners"])
    management = config["management"]
    if management["allowZeroTier"] and management["zeroTierAddress"]:
        selected = ipaddress.ip_address(management["zeroTierAddress"])
        covered = any(
            listener["address"] == management["zeroTierAddress"]
            or (
                ipaddress.ip_address(listener["address"]).is_unspecified
                and ipaddress.ip_address(listener["address"]).version == selected.version
            )
            for listener in listeners
        )
        if not covered:
            inherited = copy.deepcopy(listeners[0])
            inherited["address"] = management["zeroTierAddress"]
            listeners.append(inherited)
    return listeners


def render_caddy(config: dict[str, Any]) -> str:
    blocks = ["{\n\tadmin off\n\tauto_https off\n}\n"]
    for listener in effective_management_listeners(config):
        scheme = "http" if listener["tlsMode"] == "off" else "https"
        address = listener["address"]
        shown_address = f"[{address}]" if ":" in address else address
        lines = [f"{scheme}://{shown_address}:{listener['port']} {{", f"\tbind {address}"]
        if listener["tlsMode"] == "self-signed":
            lines.append("\ttls /etc/ztplanet/tls/self-signed.crt /etc/ztplanet/tls/self-signed.key")
        elif listener["tlsMode"] == "files":
            lines.append("\ttls /etc/ztplanet/tls/custom.crt /etc/ztplanet/tls/custom.key")
        if listener["allowedCidrs"]:
            lines.extend([
                f"\t@blocked not remote_ip {' '.join(listener['allowedCidrs'])}",
                "\trespond @blocked 403",
            ])
        if config["controller"]["exposure"] == "https":
            lines.extend([
                "\thandle_path /controller-api/* {",
                "\t\treverse_proxy 172.31.255.2:9993",
                "\t}",
            ])
        lines.extend([
            "\theader {",
            "\t\t-Server",
            "\t\tX-Content-Type-Options \"nosniff\"",
            "\t\tX-Frame-Options \"DENY\"",
            "\t\tReferrer-Policy \"no-referrer\"",
            "\t\tPermissions-Policy \"camera=(), microphone=(), geolocation=()\"",
            "\t}",
        ])
        if listener["tlsMode"] != "off":
            lines.append('\theader Strict-Transport-Security "max-age=31536000"')
        lines.extend(["\treverse_proxy 127.0.0.1:3000", "}"])
        blocks.append("\n".join(lines) + "\n")
    return "\n".join(blocks)


def render_compose_override(config: dict[str, Any]) -> str:
    zt = config["zerotier"]
    controller = config["controller"]
    lines = [
        "services:",
        "  zerotier:",
        "    ports: !override",
    ]
    if zt["enabled"]:
        zt_host = compose_host(zt["bindAddress"])
        lines.append(f"      - \"{zt_host}:{zt['publicPort']}:9993/udp\"")
        if zt["secondaryPort"]:
            lines.append(f"      - \"{zt_host}:{zt['secondaryPort']}:{zt['secondaryPort']}/udp\"")
        if zt["tertiaryPort"]:
            lines.append(f"      - \"{zt_host}:{zt['tertiaryPort']}:{zt['tertiaryPort']}/udp\"")
    if controller["exposure"] == "direct":
        lines.append(f"      - \"{compose_host(controller['bindAddress'])}:{controller['port']}:9993/tcp\"")
    if not zt["enabled"] and controller["exposure"] != "direct":
        lines[-1] = "    ports: !override []"
    lines.extend([
        "    volumes:",
        "      - /etc/ztplanet/generated/local.conf:/var/lib/zerotier-one/local.conf:ro",
        "  gateway:",
        "    volumes:",
        "      - /etc/ztplanet/generated/Caddyfile:/etc/caddy/Caddyfile:ro",
        "      - /etc/ztplanet/tls:/etc/ztplanet/tls:ro",
        "  relay:",
        "    ports: !override",
        f"      - \"{compose_host(config['relayServer']['bindAddress'])}:{config['relayServer']['port']}:4443/tcp\"",
    ])
    return "\n".join(lines) + "\n"


def compose_host(address: str) -> str:
    return f"[{address}]" if ":" in address else address


def dotenv_escape(value: str) -> str:
    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValidationError("environment value contains a prohibited character")
    return "'" + value.replace("'", "'\"'\"'") + "'"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def atomic_write_json(path: Path, value: Any, mode: int) -> None:
    atomic_write(path, json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n", mode)


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "ztplanet-agent/1"

    @property
    def agent(self) -> Agent:
        return self.server.agent  # type: ignore[attr-defined]

    def log_message(self, format_string: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        body = b""
        if not self.authorized(body):
            return
        try:
            if self.path == "/v1/config":
                self.send_json(200, self.agent.envelope())
            elif self.path == "/v1/status":
                self.send_json(200, self.agent.status())
            elif self.path == "/v1/audit":
                self.send_json(200, {"events": self.agent.audit_events()})
            elif self.path == "/v1/client-config":
                config = json.loads((self.agent.generated_dir / "client-local.conf").read_text(encoding="utf-8"))
                self.send_json(200, config)
            else:
                self.send_json(404, {"error": "not found"})
        except Exception as error:
            self.send_error_json(error)

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self.read_body()
        except Exception as error:
            self.send_error_json(error)
            return
        if not self.authorized(body):
            return
        try:
            request = json.loads(body or b"{}")
            actor = self.headers.get("X-ZT-Actor", "unknown")
            if self.path == "/v1/validate":
                self.send_json(200, self.agent.validate(request.get("config")))
            elif self.path == "/v1/apply":
                self.send_json(200, self.agent.apply(request, actor))
            elif self.path == "/v1/rollback":
                self.send_json(200, self.agent.rollback(actor))
            elif self.path == "/v1/certificates/self-signed":
                self.send_json(200, self.agent.generate_certificate(request.get("names"), actor))
            elif self.path == "/v1/certificates/custom":
                self.send_json(200, self.agent.install_custom_certificate(
                    request.get("certificate"), request.get("privateKey"), actor
                ))
            elif self.path == "/v1/controller/token/rotate":
                self.send_json(200, self.agent.rotate_controller_token(actor))
            else:
                self.send_json(404, {"error": "not found"})
        except Exception as error:
            self.send_error_json(error)

    def read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValidationError("invalid Content-Length") from error
        if length < 0 or length > MAX_BODY:
            raise ValidationError("request body is too large")
        return self.rfile.read(length)

    def authorized(self, body: bytes) -> bool:
        timestamp = self.headers.get("X-ZT-Timestamp", "")
        nonce = self.headers.get("X-ZT-Nonce", "")
        signature = self.headers.get("X-ZT-Signature", "")
        try:
            unix_time = int(timestamp)
        except ValueError:
            self.send_json(401, {"error": "invalid authentication"})
            return False
        if abs(int(time.time()) - unix_time) > 30 or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce):
            self.send_json(401, {"error": "expired or invalid authentication"})
            return False
        server = self.server  # type: ignore[assignment]
        with server.nonce_lock:  # type: ignore[attr-defined]
            now = time.time()
            server.nonces = {key: seen for key, seen in server.nonces.items() if now - seen <= 60}  # type: ignore[attr-defined]
            if nonce in server.nonces:  # type: ignore[attr-defined]
                self.send_json(401, {"error": "replayed authentication"})
                return False
            canonical = b"\n".join([
                self.command.encode(), self.path.encode(), timestamp.encode(), nonce.encode(),
                self.headers.get("X-ZT-Actor", "unknown").encode(), body
            ])
            expected = hmac.new(self.agent.secret(), canonical, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature):
                self.send_json(401, {"error": "invalid authentication"})
                return False
            server.nonces[nonce] = now  # type: ignore[attr-defined]
        return True

    def send_error_json(self, error: Exception) -> None:
        if isinstance(error, ValidationError):
            status = 400
        elif isinstance(error, ConflictError):
            status = 409
        else:
            status = 500
        self.send_json(status, {"error": str(error) if status < 500 else "internal agent error"})

    def send_json(self, status: int, value: Any) -> None:
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", default="/run/ztplanet/agent.sock")
    parser.add_argument("--socket-gid", type=int, default=1001)
    parser.add_argument("--gateway-gid", type=int, default=1002)
    parser.add_argument("--state-dir", default="/etc/ztplanet")
    parser.add_argument("--project-dir", default="/opt/ztplanet")
    parser.add_argument("--render-only", action="store_true")
    parser.add_argument("--initialize-only", action="store_true")
    args = parser.parse_args()
    agent = Agent(
        Path(args.state_dir),
        Path(args.project_dir),
        not args.render_only,
        runtime_gid=args.socket_gid,
        gateway_gid=args.gateway_gid,
    )
    if args.initialize_only:
        # Re-render an existing configuration when release templates change.
        agent.render(agent.envelope()["config"])
        if not (agent.state_dir / "tls" / "self-signed.crt").exists():
            agent.generate_certificate(["localhost", "127.0.0.1"], "installer")
        return
    socket_path = Path(args.socket)
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    socket_path.unlink(missing_ok=True)
    server = UnixHTTPServer(str(socket_path), Handler)
    server.agent = agent  # type: ignore[attr-defined]
    server.nonce_lock = threading.Lock()  # type: ignore[attr-defined]
    server.nonces = {}  # type: ignore[attr-defined]
    # Read/write is limited to root and the dedicated web service group.
    os.chmod(socket_path, 0o660)  # nosec B103
    os.chown(socket_path, 0, args.socket_gid)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    run()
