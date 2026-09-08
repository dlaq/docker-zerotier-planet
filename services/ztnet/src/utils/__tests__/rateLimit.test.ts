import rateLimit, {
	getClientRateLimitIdentifier,
	RATE_LIMIT_CONFIG,
} from "~/utils/rateLimit";

it("allows exactly the configured quota, then rejects until the window expires", async () => {
	const limiter = rateLimit({ interval: 25 });
	const res = { setHeader: jest.fn() } as never;
	await expect(limiter.check(res, 1, "register", "a")).resolves.toBeUndefined();
	await expect(limiter.check(res, 1, "register", "a")).rejects.toBeUndefined();
	await expect(limiter.check(res, 1, "register", "b")).resolves.toBeUndefined();
	// LRUCache captures performance.now at import time; exercise real expiry.
	await new Promise((resolve) => setTimeout(resolve, 60));
	await expect(limiter.check(res, 1, "register", "a")).resolves.toBeUndefined();
});

it("ignores spoofed forwarding headers unless the operator trusts a reverse proxy", () => {
	const old = process.env.ZTPLANET_TRUST_PROXY;
	try {
		const req = {
			headers: { "x-forwarded-for": "198.51.100.2" },
			socket: { remoteAddress: "::ffff:192.0.2.1" },
		};
		process.env.ZTPLANET_TRUST_PROXY = "false";
		expect(getClientRateLimitIdentifier(req)).toBe("192.0.2.1");
		process.env.ZTPLANET_TRUST_PROXY = "true";
		expect(getClientRateLimitIdentifier(req)).toBe("198.51.100.2");
		expect(
			getClientRateLimitIdentifier({
				headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.7" },
				socket: { remoteAddress: "192.0.2.1" },
			}),
		).toBe("203.0.113.7");
	} finally {
		if (old === undefined)
			Reflect.deleteProperty(process.env, "ZTPLANET_TRUST_PROXY");
		else process.env.ZTPLANET_TRUST_PROXY = old;
	}
});

it("clamps invalid API rate-limit environment values to safe bounds", () => {
	const oldWindow = process.env.RATE_LIMIT_API_WINDOW;
	const oldMax = process.env.RATE_LIMIT_API_MAX_REQUESTS;
	try {
		process.env.RATE_LIMIT_API_WINDOW = "-10";
		process.env.RATE_LIMIT_API_MAX_REQUESTS = "0";
		expect(RATE_LIMIT_CONFIG.API_WINDOW_MS).toBe(60 * 1000);
		expect(RATE_LIMIT_CONFIG.API_MAX_REQUESTS).toBe(1);
	} finally {
		if (oldWindow === undefined)
			Reflect.deleteProperty(process.env, "RATE_LIMIT_API_WINDOW");
		else process.env.RATE_LIMIT_API_WINDOW = oldWindow;
		if (oldMax === undefined)
			Reflect.deleteProperty(process.env, "RATE_LIMIT_API_MAX_REQUESTS");
		else process.env.RATE_LIMIT_API_MAX_REQUESTS = oldMax;
	}
});
