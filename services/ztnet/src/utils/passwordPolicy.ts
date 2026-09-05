/**
 * Runtime-configurable password policy.
 *
 * The policy is deliberately evaluated when it is used instead of when this
 * module is imported.  This keeps tests deterministic and makes the values
 * supplied to the running container's environment authoritative after a
 * restart.
 */

export const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_MIN_ALLOWED_LENGTH = 8;
const PASSWORD_DEFAULT_MIN_LENGTH = 14;
const PASSWORD_DEFAULT_MIN_CLASSES = 2;

export type PasswordPolicy = {
	minLength: number;
	minClasses: number;
};

function boundedInteger(
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = process.env[name]?.trim();
	if (!raw || !/^\d+$/.test(raw)) return fallback;

	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return fallback;
	return Math.min(maximum, Math.max(minimum, parsed));
}

/** Return the effective policy after applying safe bounds to environment input. */
export function getPasswordPolicy(): PasswordPolicy {
	return {
		minLength: boundedInteger(
			"ZTPLANET_PASSWORD_MIN_LENGTH",
			PASSWORD_DEFAULT_MIN_LENGTH,
			PASSWORD_MIN_ALLOWED_LENGTH,
			PASSWORD_MAX_LENGTH,
		),
		// At least one character class is always required.  Setting this to one
		// is the supported personal-use relaxation; zero would make a leaked or
		// guessed short password materially easier to attack.
		minClasses: boundedInteger(
			"ZTPLANET_PASSWORD_MIN_CLASSES",
			PASSWORD_DEFAULT_MIN_CLASSES,
			1,
			3,
		),
	};
}

/** Test a password against the effective runtime policy. */
export function passwordMeetsPolicy(
	password: string,
	policy: PasswordPolicy = getPasswordPolicy(),
): boolean {
	if (typeof password !== "string") return false;
	if (password.length < policy.minLength || password.length > PASSWORD_MAX_LENGTH) {
		return false;
	}

	let classes = 0;
	if (/[a-z]/.test(password)) classes += 1;
	if (/[A-Z]/.test(password)) classes += 1;
	if (/[0-9]/.test(password)) classes += 1;
	return classes >= policy.minClasses;
}

/** Message shared by the API and Better Auth's direct sign-up endpoint. */
export function passwordPolicyMessage(
	policy: PasswordPolicy = getPasswordPolicy(),
): string {
	const classText =
		policy.minClasses === 1
			? "one of lowercase letters, uppercase letters, or digits"
			: `at least ${policy.minClasses} of lowercase letters, uppercase letters, and digits`;
	return `Password must be ${policy.minLength}-${PASSWORD_MAX_LENGTH} characters and contain ${classText}.`;
}
