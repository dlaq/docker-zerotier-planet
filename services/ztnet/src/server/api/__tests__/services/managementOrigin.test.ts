import { managementTrustedOrigins } from "~/lib/managementOrigin";
import { auth } from "~/lib/auth";

const saved = { ...process.env };
beforeEach(() => {
	process.env.MANAGEMENT_HOST = "";
	process.env.ZTPLANET_TRUST_PROXY = "true";
	process.env.NEXTAUTH_URL = "https://localhost:3443";
});
afterEach(() => {
	process.env = { ...saved };
});

it.each(["", "0.0.0.0"])(
	"supports dynamic IP login when MANAGEMENT_HOST=%s",
	(host) => {
		process.env.MANAGEMENT_HOST = host;
		const req = new Request("http://ztnet:3000/api/auth/sign-in/email", {
			headers: {
				host: "198.51.100.8:3443",
				origin: "https://attacker.example",
				"x-forwarded-host": "198.51.100.8:3443",
			},
		});
		expect(managementTrustedOrigins(req)).toEqual([
			"https://198.51.100.8:3443",
		]);
	},
);

it("does not add a request host when the operator configured a fixed management host", () => {
	process.env.MANAGEMENT_HOST = "management.example";
	expect(
		managementTrustedOrigins(new Request("https://attacker.example")),
	).toEqual([]);
});

it("does not trust forwarding headers without a trusted reverse proxy", () => {
	process.env.ZTPLANET_TRUST_PROXY = "false";
	const req = new Request("https://192.0.2.8:3443", {
		headers: { "x-forwarded-host": "attacker.example" },
	});
	expect(managementTrustedOrigins(req)).toEqual(["https://192.0.2.8:3443"]);
});

it("does not let a client-supplied forwarding host authorize its own Origin", () => {
	process.env.ZTPLANET_TRUST_PROXY = "true";
	const req = new Request("https://192.0.2.8:3443", {
		headers: {
			host: "192.0.2.8:3443",
			"x-forwarded-host": "attacker.example",
		},
	});
	expect(managementTrustedOrigins(req)).toEqual(["https://192.0.2.8:3443"]);
});

it("keeps real cross-origin sign-in requests blocked in dynamic-host mode", async () => {
	const response = await auth.handler(
		new Request("https://192.0.2.8:3443/api/auth/sign-in/email", {
			method: "POST",
			headers: {
				host: "192.0.2.8:3443",
				origin: "https://attacker.example",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				email: "test@example.com",
				password: "SomePassword1234",
			}),
		}),
	);
	expect(response.status).toBe(403);
});
