#!/usr/bin/env python3
import os
import socket
import struct
import subprocess
import time
import unittest
import urllib.request
from pathlib import Path


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class RelayProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.relay_port = free_port()
        cls.metrics_port = free_port()
        binary = Path(os.environ.get("RELAY_BINARY", "target/debug/ztplanet-relay"))
        environment = {
            **os.environ,
            "RELAY_LISTEN": f"127.0.0.1:{cls.relay_port}",
            "RELAY_METRICS_LISTEN": f"127.0.0.1:{cls.metrics_port}",
            "RELAY_HANDSHAKE_TIMEOUT_SECONDS": "1",
            "RELAY_IDLE_TIMEOUT_SECONDS": "30",
            "RELAY_MAX_CONNECTIONS": "4",
            "RELAY_MAX_CONNECTIONS_PER_IP": "4",
        }
        cls.process = subprocess.Popen(
            [str(binary)], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )
        for _ in range(50):
            try:
                urllib.request.urlopen(
                    f"http://127.0.0.1:{cls.metrics_port}/healthz", timeout=0.2
                ).read()
                break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("relay did not become ready")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=3)

    def metrics(self):
        body = urllib.request.urlopen(
            f"http://127.0.0.1:{self.metrics_port}/metrics", timeout=1
        ).read().decode()
        return {
            line.split()[0]: float(line.split()[1])
            for line in body.splitlines()
            if line.startswith("zt_relay_")
        }

    def test_split_greeting_and_private_destination_are_handled_safely(self):
        before = self.metrics()
        with socket.create_connection(("127.0.0.1", self.relay_port), timeout=2) as client:
            greeting = bytes([0x17, 0x03, 0x03, 0, 4, 1, 16, 0, 2])
            for byte in greeting:
                client.sendall(bytes([byte]))
            body = bytes([4, 169, 254, 169, 254]) + struct.pack("!H", 9993) + bytes(16)
            client.sendall(bytes([0x17, 0x03, 0x03]) + struct.pack("!H", len(body)) + body)
            client.sendall(bytes([0x16, 0x03, 0x03, 0, 23]))
            time.sleep(0.1)
        after = self.metrics()
        self.assertGreater(after["zt_relay_rejected_destination_total"], before["zt_relay_rejected_destination_total"])
        self.assertGreater(after["zt_relay_rejected_protocol_total"], before["zt_relay_rejected_protocol_total"])

    def test_slow_greeting_hits_absolute_deadline(self):
        before = self.metrics()
        with socket.create_connection(("127.0.0.1", self.relay_port), timeout=2) as client:
            client.sendall(b"\x17")
            time.sleep(1.3)
            client.settimeout(1)
            self.assertEqual(client.recv(1), b"")
        self.assertEqual(self.metrics()["zt_relay_connections_active"], before["zt_relay_connections_active"])


if __name__ == "__main__":
    unittest.main()
