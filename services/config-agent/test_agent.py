import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import subprocess

from ztplanet_agent import (
    Agent,
    ValidationError,
    changed_services,
    default_config,
    effective_management_listeners,
    listener_is_present,
    render_compose_override,
    validate_config,
)


class ValidationTests(unittest.TestCase):
    def test_defaults_are_valid(self):
        config, warnings = validate_config(default_config())
        self.assertEqual(config["relayClient"]["mode"], "off")
        self.assertEqual(warnings, [])

    def test_user_can_choose_non_443_relay_port_and_any_bind(self):
        config = default_config()
        config["relayServer"].update({"enabled": True, "port": 8443, "bindAddress": "0.0.0.0"})
        clean, warnings = validate_config(config)
        self.assertEqual(clean["relayServer"]["port"], 8443)
        self.assertTrue(any("no client authentication" in warning for warning in warnings))

    def test_listener_conflict_is_rejected(self):
        config = default_config()
        config["relayServer"].update({"enabled": True, "bindAddress": "127.0.0.1", "port": 3443})
        with self.assertRaises(ValidationError):
            validate_config(config)

    def test_wildcard_listener_conflicts_with_specific_relay_bind(self):
        config = default_config()
        config["management"]["listeners"][0].update({"address": "0.0.0.0", "port": 8443})
        config["management"]["publicUrl"] = "https://127.0.0.1:8443"
        config["relayServer"].update({"enabled": True, "bindAddress": "127.0.0.1", "port": 8443})
        with self.assertRaises(ValidationError):
            validate_config(config)

    def test_private_management_bind_is_not_forbidden(self):
        config = default_config()
        config["management"]["listeners"] = [
            {"address": "192.168.10.2", "port": 9443, "tlsMode": "self-signed", "allowedCidrs": ["192.168.0.0/16"]},
            {"address": "10.20.0.2", "port": 9443, "tlsMode": "off", "allowedCidrs": ["10.0.0.0/8"]},
        ]
        clean, warnings = validate_config(config)
        self.assertEqual(len(clean["management"]["listeners"]), 2)
        self.assertTrue(any("clear-text" in warning for warning in warnings))

    def test_unknown_keys_are_rejected(self):
        config = default_config()
        config["command"] = "rm -rf /"
        with self.assertRaises(ValidationError):
            validate_config(config)

    def test_zerotier_listener_inherits_first_listener_policy(self):
        config = default_config()
        config["management"].update({
            "allowZeroTier": True,
            "zeroTierInterface": "ztabc123",
            "zeroTierAddress": "10.44.0.5",
        })
        clean, _ = validate_config(config)
        listeners = effective_management_listeners(clean)
        self.assertEqual(listeners[-1]["address"], "10.44.0.5")
        self.assertEqual(listeners[-1]["port"], 3443)
        self.assertEqual(listeners[-1]["tlsMode"], "self-signed")

    def test_secondary_and_tertiary_udp_ports_are_published(self):
        config = default_config()
        config["zerotier"].update({"secondaryPort": 29993, "tertiaryPort": 39993})
        clean, _ = validate_config(config)
        override = render_compose_override(clean)
        self.assertIn('29993:29993/udp', override)
        self.assertIn('39993:39993/udp', override)

    def test_duplicate_udp_ports_are_rejected(self):
        config = default_config()
        config["zerotier"]["secondaryPort"] = 9993
        with self.assertRaises(ValidationError):
            validate_config(config)


class AgentTests(unittest.TestCase):
    def test_disabling_relay_never_starts_it_again(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = Agent(Path(directory) / "state", Path(directory), apply_docker=True)
            with patch("ztplanet_agent.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
                result = agent.apply_runtime(["relay"], default_config())
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(any(command[-2:] == ["stop", "relay"] for command in commands))
            self.assertFalse(any("up" in command for command in commands))
            self.assertEqual(result["services"], [])

    def test_disabled_relay_is_excluded_from_multi_service_recreation(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = Agent(Path(directory) / "state", Path(directory), apply_docker=True)
            healthy = json.dumps({"Service": "ztnet", "State": "running", "Health": "healthy"})
            with patch("ztplanet_agent.subprocess.run", return_value=subprocess.CompletedProcess([], 0, healthy, "")) as run:
                agent.apply_runtime(["relay", "ztnet"], default_config())
            up = next(call.args[0] for call in run.call_args_list if "up" in call.args[0])
            self.assertNotIn("relay", up)
            self.assertEqual(up[-1], "ztnet")

    def test_listener_health_matches_ip_as_well_as_port(self):
        listeners = [{"protocol": "tcp", "endpoint": "127.0.0.1:3443"}]
        self.assertTrue(listener_is_present(listeners, "tcp", 3443, "127.0.0.1"))
        self.assertFalse(listener_is_present(listeners, "tcp", 3443, "192.168.1.10"))
        self.assertFalse(listener_is_present(listeners, "tcp", 3443, "0.0.0.0"))
        self.assertFalse(listener_is_present(listeners, "udp", 3443, "127.0.0.1"))
        self.assertTrue(listener_is_present([{"protocol": "tcp", "endpoint": "0.0.0.0:3443"}], "tcp", 3443, "192.168.1.10"))
        self.assertTrue(listener_is_present([{"protocol": "tcp", "endpoint": "[::1]:3443"}], "tcp", 3443, "::1"))

    def test_compose_command_uses_published_image_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = Agent(root / "state", root / "project", apply_docker=False)
            command = agent.compose_command()
            self.assertIn(str(root / "state/images.env"), command)
            self.assertIn(str(root / "state/runtime.env"), command)
            self.assertIn(str(root / "state/generated/stack.env"), command)

    def test_apply_and_rollback_are_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            agent = Agent(state, Path(directory), apply_docker=False)
            current = agent.envelope()
            updated = copy.deepcopy(current["config"])
            updated["relayServer"]["port"] = 9443
            result = agent.apply(
                {"expectedRevision": current["revision"], "idempotencyKey": "abcdefghijklmnop", "config": updated},
                "admin-test",
            )
            self.assertEqual(result["revision"], 2)
            self.assertEqual(agent.envelope()["config"]["relayServer"]["port"], 9443)
            rolled_back = agent.rollback("admin-test")
            self.assertEqual(rolled_back["revision"], 3)
            self.assertEqual(agent.envelope()["config"]["relayServer"]["port"], 443)

    def test_client_config_contains_custom_port(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            agent = Agent(state, Path(directory), apply_docker=False)
            config = default_config()
            config["relayClient"] = {"mode": "custom-auto", "host": "relay.example.com", "port": 9443}
            clean, _ = validate_config(config)
            agent.render(clean)
            rendered = json.loads((state / "generated/client-local.conf").read_text())
            self.assertEqual(rendered["settings"]["tcpFallbackRelay"], "relay.example.com/9443")
            self.assertFalse(rendered["settings"]["forceTcpRelay"])
            local = json.loads((state / "generated/local.conf").read_text())
            self.assertEqual(local["settings"]["allowManagementFrom"], ["127.0.0.1", "172.31.255.3/32"])

    def test_service_diff_is_bounded(self):
        old = default_config()
        new = copy.deepcopy(old)
        new["relayServer"]["enabled"] = True
        self.assertEqual(changed_services(old, new), ["relay"])


if __name__ == "__main__":
    unittest.main()
