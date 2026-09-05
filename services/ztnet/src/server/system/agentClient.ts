import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const AGENT_SOCKET = process.env.ZTPLANET_AGENT_SOCKET || "/run/ztplanet/agent.sock";
const AGENT_SECRET_FILE =
	process.env.ZTPLANET_AGENT_SECRET_FILE || "/run/ztplanet/agent.secret";
const MAX_RESPONSE = 2 * 1024 * 1024;

type Method = "GET" | "POST";

function secret(): Buffer {
	const value = fs.readFileSync(/* turbopackIgnore: true */ AGENT_SECRET_FILE, "utf8").trim();
	if (!/^[a-f0-9]{64}$/i.test(value)) {
		throw new Error("The configuration agent secret is invalid");
	}
	return Buffer.from(value, "utf8");
}

export async function callAgent<T>(
	method: Method,
	path: string,
	payload?: unknown,
	actor = "ztnet",
): Promise<T> {
	if (!/^\/v1\/[a-z0-9/-]+$/.test(path)) {
		throw new Error("Invalid configuration agent endpoint");
	}
	const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const nonce = crypto.randomBytes(24).toString("base64url");
	const safeActor = actor.replace(/[^a-zA-Z0-9@._:-]/g, "_").slice(0, 128);
	const canonical = Buffer.concat([
		Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${safeActor}\n`),
		body,
	]);
	const signature = crypto.createHmac("sha256", secret()).update(canonical).digest("hex");

	return await new Promise<T>((resolve, reject) => {
		const request = http.request(
			{
				socketPath: AGENT_SOCKET,
				path,
				method,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": body.length,
					"X-ZT-Timestamp": timestamp,
					"X-ZT-Nonce": nonce,
					"X-ZT-Signature": signature,
					"X-ZT-Actor": safeActor,
				},
				timeout: 15_000,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let length = 0;
				response.on("data", (chunk: Buffer) => {
					length += chunk.length;
					if (length > MAX_RESPONSE) {
						request.destroy(new Error("Configuration agent response is too large"));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					try {
						const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
							error?: string;
						};
						if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
							reject(new Error(parsed.error || `Configuration agent returned ${response.statusCode}`));
							return;
						}
						resolve(parsed as T);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		request.on("timeout", () => request.destroy(new Error("Configuration agent timed out")));
		request.on("error", reject);
		request.end(body);
	});
}
