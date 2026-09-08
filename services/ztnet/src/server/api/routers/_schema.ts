import { z } from "zod";
import { normalizeEmail } from "~/utils/email";
import {
	PASSWORD_MAX_LENGTH,
	passwordMeetsPolicy,
	passwordPolicyMessage,
} from "~/utils/passwordPolicy";

/**
 * Email input schema: normalize first, then validate the normalized value.
 *
 * Order matters. `z.string().email().transform(normalizeEmail)` runs the
 * validation before the transform, so a padded address from autofill or a
 * copy/paste (" user@example.com ") is rejected before it can ever be
 * trimmed. Piping the other way around trims and lowercases first, so the
 * value that reaches the database is always the same one better-auth will
 * later look up.
 *
 * @param invalidMessage overrides the "invalid address" message
 * @param requiredError overrides the message for a missing/non-string value
 */
export const emailSchema = (invalidMessage?: string, requiredError?: string) =>
	(requiredError ? z.string({ error: requiredError }) : z.string())
		.transform(normalizeEmail)
		.pipe(z.string().email(invalidMessage));

// Kept as a small compatibility wrapper for callers that previously imported
// `mediumPassword`.  The effective policy is read from the container
// environment by passwordMeetsPolicy at validation time.
export const mediumPassword = { test: passwordMeetsPolicy };

// create a zod password schema
export const passwordSchema = (errorMessage?: string) =>
	z
		.string()
		.max(PASSWORD_MAX_LENGTH, {
			message: "Password must not exceed 128 characters",
		})
		.superRefine((value, ctx) => {
			if (!passwordMeetsPolicy(value)) {
				ctx.addIssue({
					code: "custom",
					message: errorMessage || passwordPolicyMessage(),
				});
			}
		});
