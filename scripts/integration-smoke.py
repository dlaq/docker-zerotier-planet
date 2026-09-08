#!/usr/bin/env python3
"""用本地镜像验证 1Panel 编排；随机项目、临时 bind 数据、仅回环端口。

先按 docker-compose.build.yml 构建五个本地镜像，再运行本脚本。
可用 SMOKE_ZTNET_IMAGE 指定待测 ZTNet 镜像。不读取生产 .env，不操作生产编排。
"""

import concurrent.futures
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
IMAGES = {
    "postgres": "ztplanet-postgres:17",
    "zerotier": "ztplanet-zerotier:latest",
    "ztnet": os.environ.get("SMOKE_ZTNET_IMAGE", "ztplanet-ztnet:latest"),
    "gateway": "ztplanet-gateway:2.11.4",
}


def run(*args, env=None, timeout=60):
    result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        # 不打印命令参数或渲染后的配置，避免把测试口令留在 CI 日志里。
        raise RuntimeError(f"{args[0]} 执行失败：{result.stderr[-3000:]}")
    return result.stdout


class Client:
    def __init__(self, origin, source="198.51.100.10"):
        self.origin = origin
        self.source = source
        # 仅此一次性本地测试信任自动生成的自签名证书。
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
            urllib.request.HTTPCookieProcessor(self.cookies),
        )

    def request(self, path, data=None, origin=None):
        request = urllib.request.Request(
            self.origin + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={
                "Content-Type": "application/json",
                "Origin": origin or self.origin,
                "X-Forwarded-For": self.source,
            },
        )
        try:
            response = self.opener.open(request, timeout=25)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read().decode()
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                pass
            return response.status, body

    def trpc(self, path, data=None, expected=200):
        endpoint = "/api/trpc/" + path
        status, body = self.request(endpoint, None if data is None else {"json": data})
        if status != expected:
            # 输入中有口令；只输出错误的过程名和 HTTP 状态。
            raise AssertionError(f"{path}: HTTP {status}，预期 {expected}")
        if expected == 200:
            return body["result"]["data"]["json"]
        return body

    def login(self, email, password, expected=200):
        status, body = self.request("/api/auth/sign-in/email", {"email": email, "password": password})
        error_code = body.get("code", "") if isinstance(body, dict) else ""
        assert status == expected, f"登录 HTTP {status}，预期 {expected}，错误码 {error_code}"
        if status == 200:
            assert self.cookies, "登录成功但没有会话 Cookie"
            assert not any(body["user"].get(key) for key in ("hash", "tempPassword", "twoFactorSecret"))
        return body


def main():
    for image in set(IMAGES.values()):
        run("docker", "image", "inspect", image)
    directory = Path(tempfile.mkdtemp(prefix="ztplanet-smoke-"))
    project = "ztplanet-smoke-" + secrets.token_hex(5)
    config_file = directory / "compose.json"
    command = ["docker", "compose", "-p", project, "-f", str(config_file)]
    env = {key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")}
    env.update({
        "ZTPLANET_DB_PASSWORD": secrets.token_hex(32),
        "ZTPLANET_AUTH_SECRET": secrets.token_hex(48),
        "MANAGEMENT_HOST": "", "MANAGEMENT_PORT": "3443",
        "ZTPLANET_PASSWORD_MIN_LENGTH": "8", "ZTPLANET_PASSWORD_MIN_CLASSES": "1",
        "ZTPLANET_TRUSTED_PROXIES": "172.31.255.0/24",
        # Keep this deterministic functional smoke from consuming the normal
        # short-window login bucket; rate-limit partitioning has dedicated unit tests.
        "RATE_LIMIT_MAX_REQUESTS_SHORT": "50",
        "RATE_LIMIT_MAX_REQUESTS": "100",
    })
    try:
        model = json.loads(run(
            "docker", "compose", "--env-file", "/dev/null", "-p", project,
            "-f", str(ROOT / "docker-compose.1panel.yml"), "config", "--format", "json", env=env,
        ))
        model["name"] = project
        model["services"].pop("relay", None)
        model["networks"].pop("relay-egress", None)
        for name, service in model["services"].items():
            component = {"gateway-init": "postgres", "ztnet-init": "ztnet"}.get(name, name)
            service["image"] = IMAGES[component]
            service["pull_policy"] = "never"
            for mount in service.get("volumes", []):
                assert mount["type"] == "bind", "持久化数据必须使用 bind 目录"
                relative = Path(mount["source"]).relative_to(ROOT / "data")
                mount["source"] = str(directory / "data" / relative)
                (directory / "data" / relative).mkdir(parents=True, exist_ok=True)
        model["services"]["zerotier"].pop("ports", None)
        model["services"]["gateway"]["ports"] = [
            {"target": 3443, "published": "0", "host_ip": "127.0.0.1", "protocol": "tcp"},
        ]
        # Compose config 的输出保留 $$，可以直接再次作为 Compose 输入。
        config_file.write_text(json.dumps(model))
        config_file.chmod(0o600)
        print("启动隔离的 1Panel 编排（不开放公网端口）", flush=True)
        run(*command, "up", "-d", "--wait", "--wait-timeout", "240", env=env, timeout=270)
        origin = "https://" + run(*command, "port", "gateway", "3443", env=env).strip()
        client = Client(origin)
        for _ in range(30):
            try:
                if client.request("/auth/login")[0] == 200:
                    break
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(1)
        else:
            raise AssertionError("网关未能提供登录页")
        print("PASS 启动依赖、控制器令牌权限、自签名 HTTPS、登录页", flush=True)
        client.trpc("auth.register", {"name": "Missing", "email": "missing@example.test"}, expected=400)
        password = secrets.token_hex(6)

        def register(index):
            return Client(origin).request("/api/trpc/auth.register", {"json": {
                "name": f"Admin {index}", "email": f"admin{index}@example.test", "password": password,
            }})

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            registrations = list(executor.map(register, range(2)))
        assert sorted(status for status, _ in registrations) == [200, 400], "并发首次注册未正确关闭注册入口"
        first = next(body["result"]["data"]["json"]["user"] for status, body in registrations if status == 200)
        assert first["role"] == "ADMIN"
        client.login(first["email"], password)
        me = client.trpc("auth.me")
        assert not any(me.get(key) for key in ("hash", "tempPassword", "twoFactorSecret"))
        local_secret = "controller-secret-must-not-leak"
        local_update = client.trpc("auth.setLocalZt", {"localControllerSecret": local_secret})
        assert not local_update.get("options", {}).get("localControllerSecret")
        assert local_update.get("options", {}).get("localControllerSecretConfigured") is True
        me = client.trpc("auth.me")
        assert not me.get("options", {}).get("localControllerSecret")
        assert me.get("options", {}).get("localControllerSecretConfigured") is True
        client.trpc("auth.register", {"name": "Blocked", "email": "blocked@example.test", "password": password}, expected=400)
        print("PASS 动态 IP 登录、缺失密码校验、首次管理员并发注册、注册自动关闭", flush=True)
        user_password = "abcdefgh"
        created = client.trpc("admin.createUser", {
            "name": "Regular User", "email": "regular@example.test", "password": user_password, "role": "USER",
        })
        regular = Client(origin, "198.51.100.11")
        regular.login(created["email"], user_password)
        assert regular.request("/api/auth/update-user", {"role": "ADMIN"})[0] == 400
        assert regular.trpc("auth.me")["role"] == "USER"
        regular.trpc("admin.getAllOptions", expected=403)
        assert client.request("/api/auth/sign-up/email", {})[0] == 404
        assert client.request("/api/auth/change-password", {})[0] == 404
        assert client.request("/api/auth/sign-in/email", {"email": first["email"], "password": password}, origin="https://attacker.example")[0] == 403
        print("PASS 管理员创建用户使用 .env 密码策略、权限越界及跨站登录拦截", flush=True)
        new_password = " leading trailing "
        regular.trpc("auth.update", {"password": user_password, "newPassword": new_password, "repeatNewPassword": new_password})
        Client(origin, "198.51.100.12").login(created["email"], new_password)
        Client(origin, "198.51.100.13").login(created["email"], new_password.strip(), expected=401)
        client.trpc("admin.updateUser", {"id": created["id"], "params": {"isActive": False}})
        regular.trpc("auth.me", expected=401)
        print("PASS 改密双表同步、不截断空格、停用账户的旧 Cookie 失效", flush=True)
        # 不删除数据，完整重建容器；验证旧 UID 私有目录和 init 幂等性。
        run(*command, "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "240", env=env, timeout=270)
        recreated_origin = "https://" + run(*command, "port", "gateway", "3443", env=env).strip()
        Client(recreated_origin, "198.51.100.14").login(first["email"], password)
        print("PASS 保留 bind 数据重新部署后仍可登录；全部 HTTP 集成检查通过", flush=True)
    except Exception:
        if config_file.exists():
            print(run(*command, "logs", "--no-color", "--tail", "15", "gateway-init", "ztnet-init", env=env), flush=True)
            # 仅打印本次测试进程的错误行，不输出请求体、Cookie、Token 或数据库记录。
            logs = run(*command, "logs", "--no-color", "--tail", "50", "ztnet", env=env)
            print("\n".join(line for line in logs.splitlines() if "ERROR" in line or "Error:" in line), flush=True)
        raise
    finally:
        if config_file.exists():
            run(*command, "down", "--remove-orphans", env=env, timeout=90)
        # 此随机目录由脚本独占；清理容器创建的不同 UID 文件，不触碰项目 ./data。
        assert directory.name.startswith("ztplanet-smoke-") and directory.parent == Path(tempfile.gettempdir())
        run(
            "docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
            "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges:true",
            "--mount", f"type=bind,source={directory},target=/smoke",
            "--entrypoint", "/bin/sh", IMAGES["postgres"], "-ec", "find /smoke -mindepth 1 -delete",
        )
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
