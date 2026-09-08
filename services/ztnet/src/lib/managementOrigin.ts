/**
 * Wildcard management hosts support a changing VPS IP. Trust only the request's
 * own authority, never its Origin value, so cross-site requests remain blocked.
 */
export function managementTrustedOrigins(request?: Request): string[] {
	const hostSetting = process.env.MANAGEMENT_HOST?.trim();
	const dynamic = hostSetting === "" || hostSetting === "0.0.0.0";
	if (!dynamic || !request) return [];
	const trustProxy = process.env.ZTPLANET_TRUST_PROXY === "true";
	// Prefer the request authority. A browser can send X-Forwarded-Host itself;
	// using it first would let an attacker make their own Origin appear trusted.
	// Only fall back to the header when the operator explicitly placed a trusted
	// reverse proxy in front and that proxy rewrites the Host header.
	const host =
		request.headers.get("host") ||
		(trustProxy && request.headers.get("x-forwarded-host")) ||
		new URL(request.url).host;
	const protocol = new URL(process.env.NEXTAUTH_URL).protocol;
	if (!host || !/^[A-Za-z0-9.\-\[\]:]+$/.test(host)) return [];
	try {
		const origin = new URL(`${protocol}//${host}`);
		if (
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.hostname === "0.0.0.0"
		)
			return [];
		return [origin.origin];
	} catch {
		return [];
	}
}
