import type { NextApiResponse } from "next";
import { LRUCache } from "lru-cache";
import { isIP } from "node:net";

type Options = {
	uniqueTokenPerInterval?: number;
	interval?: number;
};

type RequestLike = {
	headers?: Record<string, string | string[] | undefined>;
	socket?: { remoteAddress?: string | null };
};

function firstHeader(
	headers: Record<string, string | string[] | undefined> | undefined,
	name: string,
): string | undefined {
	const value = headers?.[name] ?? headers?.[name.toLowerCase()];
	if (Array.isArray(value)) return value[0]?.trim() || undefined;
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeAddress(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const candidate = value.trim().replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
	const mappedIpv4 = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
	const address = mappedIpv4 || candidate;
	return isIP(address) ? address : undefined;
}

/**
 * Return a stable, bounded source identifier for a request.
 *
 * The bundled Caddy gateway is the only public path in the production
 * Compose, so its X-Forwarded-For header may be trusted when
 * ZTPLANET_TRUST_PROXY=true.  Direct deployments default to the socket peer
 * and therefore cannot spoof the limiter with a user supplied header.
 */
export function getClientRateLimitIdentifier(req?: RequestLike): string {
	const trustProxy = process.env.ZTPLANET_TRUST_PROXY?.toLowerCase() === "true";
	if (trustProxy) {
		const forwarded = firstHeader(req?.headers, "x-forwarded-for")?.split(",", 1)[0];
		const forwardedAddress = normalizeAddress(forwarded?.trim());
		if (forwardedAddress) return forwardedAddress;

		const realAddress = normalizeAddress(firstHeader(req?.headers, "x-real-ip"));
		if (realAddress) return realAddress;
	}

	return normalizeAddress(req?.socket?.remoteAddress) || "unknown";
}

// Helper function to get rate limit config values
// This ensures values are read at runtime, not module load time
function getApiWindowMs(): number {
	const windowMinutes = Number.parseInt(process.env.RATE_LIMIT_API_WINDOW || "1", 10);
	return (Number.isNaN(windowMinutes) ? 1 : windowMinutes) * 60 * 1000;
}

function getApiMaxRequests(): number {
	const maxRequests = Number.parseInt(
		process.env.RATE_LIMIT_API_MAX_REQUESTS || "50",
		10,
	);
	return Number.isNaN(maxRequests) ? 50 : maxRequests;
}

// Rate limit configuration - use functions for lazy evaluation
export const RATE_LIMIT_CONFIG = {
	get API_WINDOW_MS(): number {
		return getApiWindowMs();
	},
	get API_MAX_REQUESTS(): number {
		return getApiMaxRequests();
	},
};

export default function rateLimit(options?: Options) {
	const tokenCache = new LRUCache({
		max: options?.uniqueTokenPerInterval || 500,
		ttl: options?.interval || 60000,
	});

	return {
		check: (res: NextApiResponse, limit: number, token: string, identifier = "global") =>
			new Promise<void>((resolve, reject) => {
				// Include the caller identity in the bucket when a route supplies it.
				// Keeping the default global preserves compatibility for internal jobs
				// that intentionally share a budget.
				const cacheKey = `${token}:${identifier}`;
				const tokenCount = (tokenCache.get(cacheKey) as number[]) || [0];
				if (tokenCount[0] === 0) {
					tokenCache.set(cacheKey, tokenCount);
				}
				tokenCount[0] += 1;

				const currentUsage = tokenCount[0];
				const isRateLimited = currentUsage >= limit;
				res.setHeader("X-RateLimit-Limit", limit);
				res.setHeader("X-RateLimit-Remaining", isRateLimited ? 0 : limit - currentUsage);

				return isRateLimited ? reject() : resolve();
			}),
		reset: () => tokenCache.clear(),
	};
}
