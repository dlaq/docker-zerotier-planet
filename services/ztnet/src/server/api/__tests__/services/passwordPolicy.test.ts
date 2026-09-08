import { afterEach, describe, expect, it } from "@jest/globals";
import { passwordSchema } from "~/server/api/routers/_schema";
import {
	getPasswordPolicy,
	passwordMeetsPolicy,
	passwordPolicyMessage,
} from "~/utils/passwordPolicy";

const ORIGINAL_ENV = {
	minLength: process.env.ZTPLANET_PASSWORD_MIN_LENGTH,
	minClasses: process.env.ZTPLANET_PASSWORD_MIN_CLASSES,
};

const clearEnv = (name: string) => {
	Reflect.deleteProperty(process.env, name);
};

afterEach(() => {
	if (ORIGINAL_ENV.minLength === undefined)
		clearEnv("ZTPLANET_PASSWORD_MIN_LENGTH");
	else process.env.ZTPLANET_PASSWORD_MIN_LENGTH = ORIGINAL_ENV.minLength;
	if (ORIGINAL_ENV.minClasses === undefined)
		clearEnv("ZTPLANET_PASSWORD_MIN_CLASSES");
	else process.env.ZTPLANET_PASSWORD_MIN_CLASSES = ORIGINAL_ENV.minClasses;
});

describe("runtime password policy", () => {
	it("requires a password for registration and reset, while allowing explicit optional fields", () => {
		expect(passwordSchema().safeParse(undefined).success).toBe(false);
		expect(passwordSchema().safeParse("").success).toBe(false);
		expect(passwordSchema().optional().safeParse(undefined).success).toBe(true);
	});

	it("reports the effective runtime policy even for an already-created schema", () => {
		const schema = passwordSchema();
		process.env.ZTPLANET_PASSWORD_MIN_LENGTH = "8";
		process.env.ZTPLANET_PASSWORD_MIN_CLASSES = "1";
		expect(schema.safeParse("password").success).toBe(true);
		const invalid = schema.safeParse("short");
		if (invalid.success) throw new Error("short password accepted");
		expect(invalid.error.issues[0].message).toContain("8-128");
	});
	it("keeps the secure defaults", () => {
		clearEnv("ZTPLANET_PASSWORD_MIN_LENGTH");
		clearEnv("ZTPLANET_PASSWORD_MIN_CLASSES");

		expect(getPasswordPolicy()).toEqual({ minLength: 14, minClasses: 2 });
		expect(passwordMeetsPolicy("shortA1")).toBe(false);
		expect(passwordMeetsPolicy("LongEnoughPassword1")).toBe(true);
	});

	it("accepts a bounded personal-use override", () => {
		process.env.ZTPLANET_PASSWORD_MIN_LENGTH = "8";
		process.env.ZTPLANET_PASSWORD_MIN_CLASSES = "1";

		expect(getPasswordPolicy()).toEqual({ minLength: 8, minClasses: 1 });
		expect(passwordMeetsPolicy("password")).toBe(true);
		expect(passwordMeetsPolicy("short")).toBe(false);
		expect(passwordPolicyMessage()).toContain("8-128");
	});

	it("clamps unsafe values instead of disabling validation", () => {
		process.env.ZTPLANET_PASSWORD_MIN_LENGTH = "1";
		process.env.ZTPLANET_PASSWORD_MIN_CLASSES = "0";

		expect(getPasswordPolicy()).toEqual({ minLength: 8, minClasses: 1 });
	});
});
