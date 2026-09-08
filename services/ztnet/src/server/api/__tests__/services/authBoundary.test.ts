import { parseUserInput, parseUserOutput } from "better-auth/db";
import { auth } from "~/lib/auth";
import { Prisma } from "@prisma/client";
import { getAuthTables } from "@better-auth/core/db";

describe("Better Auth cannot bypass ZTNet account controls", () => {
	it("keeps Prisma account columns compatible with the installed authentication library", () => {
		const fields = Prisma.dmmf.datamodel.models.find(
			(model) => model.name === "Account",
		)!.fields;
		const names = new Set(fields.map((field) => field.name));
		for (const [name, field] of Object.entries(
			getAuthTables(auth.options).account.fields,
		)) {
			expect(names.has(field.fieldName || name)).toBe(true);
		}
	});
	it.each([
		["role", "ADMIN"],
		["hash", "injected-hash"],
		["twoFactorSecret", "injected-secret"],
		["isActive", true],
		["userGroupId", 1],
		["expiresAt", new Date()],
	])(
		"rejects client-controlled %s via the real auth input parser",
		(field, value) => {
			expect(() =>
				parseUserInput(auth.options, { [field]: value }, "update"),
			).toThrow();
		},
	);

	it("ignores falsy attempts to turn off MFA or password-change requirements", () => {
		const input = parseUserInput(
			auth.options,
			{
				twoFactorEnabled: false,
				requestChangePassword: false,
				failedLoginAttempts: 0,
			},
			"update",
		);
		expect(input).toEqual({});
	});

	it("does not expose password hashes or MFA secrets in auth responses", () => {
		const result = parseUserOutput(auth.options, {
			id: "u1",
			role: "USER",
			hash: "hash",
			tempPassword: "temporary",
			twoFactorSecret: "secret",
			twoFactorEnabled: true,
		} as never);
		expect(result).not.toHaveProperty("hash");
		expect(result).not.toHaveProperty("tempPassword");
		expect(result).not.toHaveProperty("twoFactorSecret");
		expect(result.role).toBe("USER");
	});

	it.each([
		"sign-up/email",
		"change-password",
		"set-password",
		"reset-password",
		"request-password-reset",
	])("does not expose the unused %s HTTP endpoint", async (path) => {
		const origin = process.env.NEXTAUTH_URL;
		const response = await auth.handler(
			new Request(`${origin}/api/auth/${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: "{}",
			}),
		);
		expect(response.status).toBe(404);
	});
});
