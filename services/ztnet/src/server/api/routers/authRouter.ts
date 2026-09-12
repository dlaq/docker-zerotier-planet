import { accountNotification } from "~/server/notifications/service";
import { z } from "zod";
import bcrypt from "bcryptjs";
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
	adminRoleProtectedRoute,
	//   protectedProcedure,
} from "~/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { throwError } from "~/server/helpers/errorHandler";
import jwt from "jsonwebtoken";
import { createHash, randomUUID } from "node:crypto";
import { sendMailWithTemplate } from "~/utils/mail";
import * as ztController from "~/utils/ztApi";
import {
	API_TOKEN_SECRET,
	PASSWORD_RESET_SECRET,
	VERIFY_EMAIL_SECRET,
	encrypt,
	generateInstanceSecret,
} from "~/utils/encryption";
import { isRunningInDocker } from "~/utils/docker";
import { Invitation, UserOptions } from "@prisma/client";
import { validateOrganizationToken } from "../services/organizationAuthService";
import rateLimit, { getClientRateLimitIdentifier } from "~/utils/rateLimit";
import { ErrorCode } from "~/utils/errorCode";
import { MailTemplateKey } from "~/utils/enums";
import { emailSchema, passwordSchema } from "./_schema";
import {
	upsertCredentialAccount,
	withAccountTransaction,
} from "~/server/api/services/credentialAccountService";
import { DEVICE_SALT_COOKIE_NAME } from "~/utils/devices";
import { normalizeEmail } from "~/utils/email";
import { passwordMeetsPolicy, passwordPolicyMessage } from "~/utils/passwordPolicy";

type PublicUserOptions = Partial<
	Omit<UserOptions, "ztCentralApiKey" | "localControllerSecret">
> & {
	ztCentralApiKey: null;
	localControllerSecret: null;
	ztCentralApiKeyConfigured: boolean;
	localControllerSecretConfigured: boolean;
	urlFromEnv?: boolean;
	secretFromEnv?: boolean;
	localControllerUrlPlaceholder?: string;
};

function sanitizeUserOptions(
	options: UserOptions | null | undefined,
): PublicUserOptions | null {
	if (!options) return null;
	return {
		...options,
		ztCentralApiKey: null,
		localControllerSecret: null,
		ztCentralApiKeyConfigured: Boolean(options.ztCentralApiKey),
		localControllerSecretConfigured: Boolean(options.localControllerSecret),
	};
}

// Rate limit configuration from environment variables
// RATE_LIMIT_WINDOW: Time window in minutes (default: 10 minutes)
// RATE_LIMIT_MAX_REQUESTS: Max requests for general operations (default: 60)
// RATE_LIMIT_MAX_REQUESTS_SHORT: Max requests for sensitive operations (default: 5)
const RATE_LIMIT_WINDOW_MS =
	(Number.parseInt(process.env.RATE_LIMIT_WINDOW || "10", 10) || 10) * 60 * 1000;
const GENERAL_REQUEST_LIMIT =
	Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60", 10) || 60;
const SHORT_REQUEST_LIMIT =
	Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS_SHORT || "10", 10) || 10;
const REGISTER_RATE_LIMIT_WINDOW_MS =
	(Number.parseInt(
		process.env.ZTPLANET_REGISTER_RATE_LIMIT_WINDOW ||
			process.env.RATE_LIMIT_WINDOW ||
			"10",
		10,
	) || 10) *
	60 *
	1000;
const REGISTER_REQUEST_LIMIT =
	Number.parseInt(
		process.env.ZTPLANET_REGISTER_RATE_LIMIT_MAX ||
			process.env.RATE_LIMIT_MAX_REQUESTS ||
			"60",
		10,
	) || 60;

const limiter = rateLimit({
	interval: RATE_LIMIT_WINDOW_MS,
	uniqueTokenPerInterval: 1000,
});
const registerLimiter = rateLimit({
	interval: REGISTER_RATE_LIMIT_WINDOW_MS,
	uniqueTokenPerInterval: 10000,
});

// Rate limit tokens - each endpoint should have its own token to prevent
// different operations from consuming each other's rate limits
const RATE_LIMIT_TOKENS = {
	REGISTER_USER: "REGISTER_USER",
	VALIDATE_RESET_TOKEN: "VALIDATE_RESET_TOKEN",
	PASSWORD_RESET_LINK: "PASSWORD_RESET_LINK",
	CHANGE_PASSWORD: "CHANGE_PASSWORD",
	SEND_EMAIL_VERIFICATION: "SEND_EMAIL_VERIFICATION",
	EMAIL_VERIFICATION_LINK: "EMAIL_VERIFICATION_LINK",
} as const;

const resetTokenRecord = (token: string, userId: string) => ({
	identifier: `ztplanet-password-reset:${userId}`,
	value: createHash("sha256").update(token).digest("hex"),
	expiresAt: { gt: new Date() },
});

export const authRouter = createTRPCRouter({
	register: publicProcedure
		.input(
			z.object({
				email: emailSchema(),
				password: passwordSchema(),
				name: z.string().min(3, "Name must contain at least 3 character(s)").max(40),
				expiresAt: z.string().optional(),
				ztnetInvitationCode: z.string().optional(),
				ztnetOrganizationToken: z.string().optional(),
				token: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// add rate limit
			try {
				await registerLimiter.check(
					ctx.res,
					REGISTER_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.REGISTER_USER,
					getClientRateLimitIdentifier(ctx.req),
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded",
				});
			}

			const {
				email,
				password,
				name,
				ztnetInvitationCode,
				ztnetOrganizationToken,
				token,
				expiresAt: expiresAtInput,
			} = input;
			const expiresAt = expiresAtInput?.trim() ? new Date(expiresAtInput.trim()) : null;
			if (expiresAtInput?.trim() && (!expiresAt || Number.isNaN(expiresAt.getTime()))) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid expiration date",
				});
			}
			const settings = await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
			});

			// Validate the organization token if it exists
			const decryptedOrgToken = await validateOrganizationToken(
				ztnetOrganizationToken,
				email,
			);
			const invitationToken = ztnetInvitationCode?.trim() || token?.trim();

			// ztnet user invitation
			let invitation: Invitation | null = null;

			// ztnet user invitation
			const hasValidCode =
				invitationToken &&
				(await (async () => {
					if (!ztnetInvitationCode?.trim() || !token?.trim()) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "No invitation code provided",
						});
					}
					invitation = await ctx.prisma.invitation.findUnique({
						where: { token: token.trim(), secret: ztnetInvitationCode.trim() },
					});

					if (
						!invitation ||
						invitation.expiresAt <= new Date() ||
						(invitation.email && normalizeEmail(invitation.email) !== email) ||
						invitation.used ||
						invitation.timesUsed >= invitation.timesCanUse
					) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: invitation
								? "Code has already been used"
								: "Invitation has expired or is invalid",
						});
					}

					// Validate the token using jwt
					try {
						jwt.verify(token.trim(), process.env.NEXTAUTH_SECRET);
					} catch (_e) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Invitation has expired or is invalid",
						});
					}

					return true;
				})());

			// check if enableRegistration is true
			if (!settings?.enableRegistration && !hasValidCode && !decryptedOrgToken) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Registration is disabled! Please contact the administrator.",
				});
			}

			// Email validation
			if (!email) return new Error("Email required!");
			if (!z.string().nonempty().parse(email)) return new Error("Email not supported!");

			// Fecth from database
			// const user = await client.query(`SELECT * FROM users WHERE email = $1 FETCH FIRST ROW ONLY`, [email]);
			const registerUser = await ctx.prisma.user.findFirst({
				where: {
					email,
				},
			});

			// validate
			if (registerUser) {
				// eslint-disable-next-line no-throw-literal
				// throw new AuthenticationError(`email "${email}" already taken`);
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `email "${email}" already taken`,
					// optional: pass the original error to retain stack trace
					// cause: theError,
				});
			}

			// hash password
			if (password) {
				if (!passwordMeetsPolicy(password))
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: passwordPolicyMessage(),
						// optional: pass the original error to retain stack trace
						// cause: theError,
					});
			}

			const hash = bcrypt.hashSync(password, 12);

			// TODO send validation link to user by mail
			// sendMailValidationLink(i);

			const newUser = await withAccountTransaction(ctx.prisma, async (registrationDb) => {
				// Serialize bootstrap and invitation consumption across all processes.
				await registrationDb.$executeRaw`SELECT pg_advisory_xact_lock(748937621)`;
				const latestSettings = await registrationDb.globalOptions.findFirst({
					where: { id: 1 },
				});
				if (!latestSettings?.enableRegistration && !hasValidCode && !decryptedOrgToken) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Registration is disabled! Please contact the administrator.",
					});
				}
				if (invitation) {
					const consumed = await registrationDb.invitation.updateMany({
						where: {
							id: invitation.id,
							used: false,
							timesUsed: invitation.timesUsed,
							expiresAt: { gt: new Date() },
						},
						data: {
							used: invitation.timesUsed + 1 >= invitation.timesCanUse,
							timesUsed: { increment: 1 },
						},
					});
					if (consumed.count !== 1)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Invitation has expired or is invalid",
						});
				}
				if (decryptedOrgToken) {
					// Organization invitations are one-time credentials too. Consume the
					// exact row inside the same transaction as user creation; deleting it
					// after commit allowed two concurrent registrations to reuse a token.
					const organizationInvitationId = decryptedOrgToken.invitation?.id;
					if (typeof organizationInvitationId !== "number" || !ztnetOrganizationToken) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Invalid token data!",
						});
					}
					const consumed = await registrationDb.invitation.deleteMany({
						where: {
							id: organizationInvitationId,
							token: ztnetOrganizationToken.trim(),
						},
					});
					if (consumed.count !== 1) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Invitation has expired or is invalid",
						});
					}
				}
				const userCount = await registrationDb.user.count();

				// Fetch the default user group if any.
				const defaultUserGroup = await registrationDb.userGroup.findFirst({
					where: {
						isDefault: true,
					},
				});

				// create new user
				const created = await registrationDb.user.create({
					data: {
						name,
						email,
						expiresAt,
						lastLogin: new Date().toISOString(),
						role: userCount === 0 ? "ADMIN" : (invitation?.role ?? "USER"),
						hash,

						// Conditionally assign user to a group
						...(invitation?.userGroupId
							? {
									userGroup: {
										connect: {
											id: invitation.userGroupId,
										},
									},
								}
							: defaultUserGroup
								? {
										userGroup: {
											connect: {
												id: defaultUserGroup.id,
											},
										},
									}
								: {}),
						// add user to organizationRoles if the token is valid
						organizationRoles: decryptedOrgToken
							? {
									create: {
										organizationId: decryptedOrgToken.organizationId,
										role: decryptedOrgToken.invitation.role,
									},
								}
							: undefined,
						// add the user to the organization if the token is valid
						memberOfOrgs: decryptedOrgToken
							? {
									connect: {
										id: decryptedOrgToken.organizationId,
									},
								}
							: undefined,
						options: {
							create: {
								localControllerUrl: isRunningInDocker()
									? "http://zerotier:9993"
									: "http://127.0.0.1:9993",
							},
						},
					},
					select: {
						id: true,
						name: true,
						email: true,
						expiresAt: true,
						role: true,
						memberOfOrgs: {
							select: {
								id: true,
								orgName: true,
							},
						},
					},
				});

				// Mirror the password into the better-auth credential Account row so the
				// user can immediately sign in via `authClient.signIn.email`.
				await upsertCredentialAccount(created.id, hash, registrationDb);

				// Bootstrap is intentionally one-shot: the first account is the administrator,
				// then open registration closes automatically. The administrator can explicitly
				// re-enable registration or issue invitations from the existing settings UI.
				if (userCount === 0) {
					await registrationDb.globalOptions.update({
						where: { id: 1 },
						data: { enableRegistration: false },
					});
				}
				return created;
			});

			// Send admin notification
			const globalOptions = await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
			});

			if (globalOptions?.userRegistrationNotification) {
				// A failed admin-notification email (e.g. misconfigured SMTP or a
				// secret mismatch) must never break the user's registration. Isolate
				// each recipient so one failure doesn't skip the other admins.
				try {
					const adminUsers = await ctx.prisma.user.findMany({
						where: {
							role: "ADMIN",
						},
					});

					for (const adminUser of adminUsers) {
						try {
							await sendMailWithTemplate(MailTemplateKey.Notification, {
								to: adminUser.email,
								userId: adminUser.id,
								templateData: {
									toName: adminUser.name,
									notificationMessage: `A new user with the name ${name} and email ${email} has just registered!`,
								},
							});
						} catch (e) {
							console.error(
								`Failed to send registration notification to admin ${adminUser.email}:`,
								e,
							);
						}
					}
				} catch (e) {
					console.error("Failed to load admins for registration notification:", e);
				}
			}
			// add log if hasValidOrganizationToken is true
			if (decryptedOrgToken) {
				// Log the action
				await ctx.prisma.activityLog.create({
					data: {
						action: `User ${newUser.name} has registered with email ${newUser.email} and has been added to the organization ${decryptedOrgToken.organizationId} with the role ${decryptedOrgToken?.invitation.role}!`,
						performedById: decryptedOrgToken?.invitation?.invitedById,
						organizationId: decryptedOrgToken?.organizationId,
					},
				});
			}
			return {
				user: newUser,
			};
		}),
	me: protectedProcedure.query(async ({ ctx }) => {
		const user = await ctx.prisma.user.findFirst({
			where: {
				id: ctx.session.user.id,
			},
			include: {
				options: true,
				memberOfOrgs: true,
				UserDevice: true,
			},
		});
		if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
		// Controller and Central API credentials are only needed by the server.
		// Returning them from this endpoint made every authenticated browser a
		// credential exfiltration target. Keep presence flags for the UI, never
		// the secret values themselves. Older installations may not have a row;
		// return the same safe shape so the UI can still render its controls.
		const options: PublicUserOptions = {
			...(sanitizeUserOptions(user.options) ?? {
				ztCentralApiKey: null,
				localControllerSecret: null,
				ztCentralApiKeyConfigured: false,
				localControllerSecretConfigured: false,
			}),
			localControllerUrlPlaceholder: isRunningInDocker()
				? "http://zerotier:9993"
				: "http://127.0.0.1:9993",
			urlFromEnv: !!process.env.ZT_ADDR,
			secretFromEnv: !!process.env.ZT_SECRET,
		};

		// Read current device ID from cookie for device identification.
		// Cookie name is preserved across the next-auth → better-auth migration on
		// purpose (see DEVICE_SALT_COOKIE_NAME); this lookup uses the constant so
		// the path through the codebase stays consistent.
		const cookieHeader = ctx.req?.headers?.cookie || "";
		const deviceCookie = cookieHeader
			.split(";")
			.find((c) => c.trim().startsWith(`${DEVICE_SALT_COOKIE_NAME}=`));
		const currentDeviceId = deviceCookie?.split("=")?.[1]?.trim() || undefined;

		return {
			...user,
			options,
			currentDeviceId,
			hash: null,
			tempPassword: null,
			twoFactorSecret: null,
			twoFactorRecoveryCodes: [],
		};
	}),
	update: protectedProcedure
		.input(
			z.object({
				email: emailSchema().optional(),
				password: z.string().optional(),
				// Passwords are opaque values: never trim or otherwise normalize them.
				newPassword: passwordSchema().optional(),
				repeatNewPassword: passwordSchema().optional(),
				name: z.string().nonempty().max(40).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const user = await ctx.prisma.user.findFirst({
				where: {
					id: ctx.session.user.id,
				},
				include: {
					accounts: true,
				},
			});

			// validate
			if (!user) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found!",
				});
			}

			if (input.newPassword || input.repeatNewPassword || input.password) {
				// User authenticates exclusively via OAuth when they have no local
				// password hash. We check `user.hash` directly — the previous form
				// (`user.accounts && !user.hash`) was always-truthy on the LHS because
				// `accounts` is an array, so the OAuth path was never gated on whether
				// the user actually had any OAuth account rows.
				const isOAuthUser = !user.hash;

				// For setting new password, all fields are required
				if (
					!input.newPassword ||
					!input.repeatNewPassword ||
					(!input.password && !isOAuthUser)
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Please fill all required fields!",
					});
				}

				if (!passwordMeetsPolicy(input.newPassword))
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: passwordPolicyMessage(),
						// optional: pass the original error to retain stack trace
						// cause: theError,
					});

				// check if old password is correct
				if (!isOAuthUser && !bcrypt.compareSync(input.password, user.hash)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Old password is incorrect!",
						// optional: pass the original error to retain stack trace
						// cause: theError,
					});
				}
				// make sure both new passwords are the same
				if (input.newPassword !== input.repeatNewPassword) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Passwords do not match!",
						// optional: pass the original error to retain stack trace
						// cause: theError,
					});
				}
			}

			const newHash = input.newPassword ? bcrypt.hashSync(input.newPassword, 12) : null;

			await withAccountTransaction(ctx.prisma, async (tx) => {
				await tx.user.update({
					where: {
						id: user.id,
					},
					data: {
						email: input.email || user.email,
						name: input.name || user.name,
						hash: newHash ?? user.hash,
						// Clear the requestChangePassword flag when user changes password
						requestChangePassword: input.newPassword ? false : user.requestChangePassword,
					},
				});

				// Keep the better-auth credential Account row in sync. better-auth
				// authenticates against `Account.password` (not `User.hash`); without this
				// the user's next sign-in would silently fail with "invalid credentials".
				if (newHash) {
					await upsertCredentialAccount(user.id, newHash, tx);
					await accountNotification(
						"user.password.changed",
						user,
						{
							ip: getClientRateLimitIdentifier(ctx.req),
							device: String(ctx.req?.headers?.["user-agent"] || "未采集"),
							result: "密码已修改；其他登录会话保持原有状态。",
						},
						tx,
					);
				}
			});
		}),
	validateResetPasswordToken: publicProcedure
		.input(
			z.object({
				token: z.string({ error: "Token is required!" }),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { token } = input;
			if (!token) return { error: ErrorCode.InvalidToken };
			try {
				const secret = generateInstanceSecret(PASSWORD_RESET_SECRET);
				const decoded = jwt.verify(token, secret) as {
					id: string;
					email: string;
				};

				// add rate limit
				try {
					await limiter.check(
						ctx.res,
						GENERAL_REQUEST_LIMIT,
						RATE_LIMIT_TOKENS.VALIDATE_RESET_TOKEN,
						getClientRateLimitIdentifier(ctx.req),
					);
				} catch {
					throw new TRPCError({
						code: "TOO_MANY_REQUESTS",
						message: "Rate limit exceeded",
					});
				}

				const user = await ctx.prisma.user.findFirst({
					where: {
						id: decoded.id,
					},
				});

				// `id` is the identity; the email is a binding check, compared
				// normalized so a token issued before the migration still resolves.
				if (!user || normalizeEmail(user.email) !== normalizeEmail(decoded.email))
					return { error: ErrorCode.InvalidToken };
				if (
					!(await ctx.prisma.verification.findFirst({
						where: resetTokenRecord(token, user.id),
					}))
				) {
					return { error: ErrorCode.InvalidToken };
				}

				return { email: user.email };
			} catch (_error) {
				return { error: ErrorCode.InvalidToken };
			}
		}),
	passwordResetLink: publicProcedure
		.input(
			z.object({
				email: emailSchema(undefined, "Email is required!"),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { email } = input;
			try {
				await limiter.check(
					ctx.res,
					SHORT_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.PASSWORD_RESET_LINK,
					getClientRateLimitIdentifier(ctx.req),
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded, please try again later",
				});
			}
			if (!email) throwError("Email is required!");

			const user = await ctx.prisma.user.findFirst({
				where: {
					email,
				},
			});

			if (!user) return "Mail sent if email exist!";

			const secret = generateInstanceSecret(PASSWORD_RESET_SECRET);
			const validationToken = jwt.sign(
				{
					id: user.id,
					email: user.email,
				},
				secret,
				{
					expiresIn: "15m",
					jwtid: randomUUID(),
				},
			);
			const record = resetTokenRecord(validationToken, user.id);
			await ctx.prisma.verification.create({
				data: {
					identifier: record.identifier,
					value: record.value,
					expiresAt: new Date(Date.now() + 15 * 60 * 1000),
				},
			});

			const resetLink = `${process.env.NEXTAUTH_URL}/auth/forgotPassword/reset?token=${validationToken}`;
			// Send email
			try {
				await sendMailWithTemplate(MailTemplateKey.ForgotPassword, {
					to: email,
					userId: user.id,
					templateData: {
						toEmail: email,
						forgotLink: resetLink,
						// Add any other fields that might be used in the template
					},
				});
			} catch (error) {
				console.error("Failed to send password reset email:", error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to send reset email. Please try again later.",
				});
			}

			return { message: "If the email exists, a reset link has been sent." };
		}),

	changePasswordFromJwt: publicProcedure
		.input(
			z.object({
				token: z.string({ error: "Token is required!" }),
				password: passwordSchema(),
				newPassword: passwordSchema(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { token, password, newPassword } = input;
			try {
				await limiter.check(
					ctx.res,
					SHORT_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.CHANGE_PASSWORD,
					getClientRateLimitIdentifier(ctx.req),
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded, please try again later",
				});
			}

			if (!token) throwError("token is required!");

			if (password !== newPassword) throwError("Passwords does not match!");

			try {
				const secret = generateInstanceSecret(PASSWORD_RESET_SECRET);
				const decoded = jwt.verify(token, secret);
				if (
					typeof decoded === "string" ||
					typeof decoded.id !== "string" ||
					typeof decoded.email !== "string"
				) {
					throwError("This link is not valid!");
				}
				const { id, email } = decoded as { id: string; email: string };
				const newHash = bcrypt.hashSync(password, 12);
				return await withAccountTransaction(ctx.prisma, async (tx) => {
					const user = await tx.user.findFirst({
						where: {
							id,
						},
					});

					if (!user || normalizeEmail(user.email) !== normalizeEmail(email))
						throwError("This link is not valid!");
					// DELETE is the single-use claim: simultaneous requests cannot both
					// consume the token, and a failed password write rolls it back.
					const consumed = await tx.verification.deleteMany({
						where: resetTokenRecord(token, id),
					});
					if (consumed.count !== 1) throwError("This link is not valid!");
					await tx.user.update({
						where: {
							id,
						},
						data: {
							hash: newHash,
							// Forced-reset implies the user just remembered/picked a fresh password —
							// clear the must-change-on-next-login flag if it was set.
							requestChangePassword: false,
							failedLoginAttempts: 0,
							lastFailedLoginAttempt: null,
						},
					});

					// Mirror into the better-auth credential Account so /sign-in/email succeeds.
					await upsertCredentialAccount(id, newHash, tx);
					await tx.session.deleteMany({ where: { userId: id } });
					await accountNotification(
						"user.password.reset_completed",
						user,
						{
							ip: getClientRateLimitIdentifier(ctx.req),
							device: String(ctx.req?.headers?.["user-agent"] || "未采集"),
							result: "密码重置完成，已撤销该账号的全部登录会话。",
						},
						tx,
					);
					return { success: true };
				});
			} catch (error) {
				console.error(error);
				throwError("token is not valid, please try again!");
			}
		}),
	sendVerificationEmail: protectedProcedure.mutation(async ({ ctx }) => {
		// add cooldown to prevent spam
		try {
			await limiter.check(
				ctx.res,
				SHORT_REQUEST_LIMIT,
				RATE_LIMIT_TOKENS.SEND_EMAIL_VERIFICATION,
				getClientRateLimitIdentifier(ctx.req),
			);
		} catch {
			throw new TRPCError({
				code: "TOO_MANY_REQUESTS",
				message: "Rate limit exceeded",
			});
		}
		const user = await ctx.prisma.user.findFirst({
			where: {
				id: ctx.session.user.id,
			},
		});

		if (!user) return { message: "Internal Error" };
		if (user.emailVerified) return { message: "Email is already verified!" };

		const secret = generateInstanceSecret(VERIFY_EMAIL_SECRET);
		const validationToken = jwt.sign(
			{
				id: user.id,
				email: user.email,
			},
			secret,
			{
				expiresIn: "15m",
			},
		);

		const verifyLink = `${process.env.NEXTAUTH_URL}/auth/verifyEmail?token=${validationToken}`;
		// Send email
		try {
			await sendMailWithTemplate(MailTemplateKey.VerifyEmail, {
				to: user.email,
				userId: user.id,
				templateData: {
					toName: user.name,
					verifyLink: verifyLink,
				},
			});
		} catch (error) {
			console.error("Failed to send verification email:", error);
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: error.message,
			});
		}

		return { message: "Verification link has been sent." };
	}),
	validateEmailVerificationToken: publicProcedure
		.input(
			z.object({
				token: z.string({ error: "Token is required!" }),
			}),
		)
		.query(async ({ ctx, input }) => {
			// add rate limit
			try {
				await limiter.check(
					ctx.res,
					SHORT_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.EMAIL_VERIFICATION_LINK,
					getClientRateLimitIdentifier(ctx.req),
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded",
				});
			}

			const { token } = input;
			if (!token) return { error: ErrorCode.InvalidToken };
			try {
				const secret = generateInstanceSecret(VERIFY_EMAIL_SECRET);
				const decoded = jwt.verify(token, secret) as {
					id: string;
					email: string;
				};

				const user = await ctx.prisma.user.findFirst({
					where: {
						id: decoded.id,
					},
				});

				// The email in the token is a binding check; see validateResetToken.
				if (
					!user ||
					user.emailVerified ||
					normalizeEmail(user.email) !== normalizeEmail(decoded.email)
				)
					return { error: ErrorCode.InvalidToken };

				// set emailVerified to true
				await ctx.prisma.user.update({
					where: {
						id: user.id,
					},
					data: {
						emailVerified: true,
					},
				});
				return { message: "Email verified successfully!" };
			} catch (_error) {
				return { error: ErrorCode.InvalidToken };
			}
		}),
	/**
	 * Update the specified NetworkMemberNotation instance.
	 *
	 * This protectedProcedure takes an input of object type with properties: notationId, nodeid,
	 * useAsTableBackground, and showMarkerInTable. It updates the fields showMarkerInTable and
	 * useAsTableBackground in the NetworkMemberNotation model for the specified notationId and nodeid.
	 *
	 * @input An object with properties:
	 * - notationId: a number representing the unique ID of the notation
	 * - nodeid: a number representing the ID of the node to which the notation is linked
	 * - useAsTableBackground: an optional boolean that determines whether the notation is used as a background in the table
	 * - showMarkerInTable: an optional boolean that determines whether to show a marker in the table for the notation
	 * @returns A Promise that resolves with the updated NetworkMemberNotation instance.
	 */
	updateUserOptions: protectedProcedure
		.input(
			z.object({
				useNotationColorAsBg: z.boolean().optional(),
				showNotationMarkerInTableRow: z.boolean().optional(),
				deAuthorizeWarning: z.boolean().optional(),
				addMemberIdAsName: z.boolean().optional(),
				renameNodeGlobally: z.boolean().optional(),
				newDeviceNotification: z.boolean().optional(),
				deviceIpChangeNotification: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			return await ctx.prisma.user.update({
				where: { id: ctx.session.user.id },
				data: {
					options: {
						upsert: {
							create: input,
							update: input,
						},
					},
				},
			});
		}),
	setZtApi: protectedProcedure
		.input(
			z.object({
				ztCentralApiKey: z.string().optional(),
				ztCentralApiUrl: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// we use upsert in case the user has no options yet
			const updated = await ctx.prisma.user.update({
				where: {
					id: ctx.session.user.id,
				},
				data: {
					options: {
						upsert: {
							create: {
								ztCentralApiKey: input.ztCentralApiKey,
								ztCentralApiUrl: input.ztCentralApiUrl,
							},
							update: {
								ztCentralApiKey: input.ztCentralApiKey,
								ztCentralApiUrl: input.ztCentralApiUrl,
							},
						},
					},
				},
				include: {
					options: true,
				},
			});
			ztController.clearApiCredentialsCache?.(ctx.session.user.id);

			if (updated.options?.ztCentralApiKey) {
				try {
					await ztController.ping_api({ ctx });
					return { status: "success" };
				} catch (error) {
					throw new TRPCError({
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
						message: error.message,
						code: "FORBIDDEN",
					});
				}
			}

			return {
				status: "success",
				options: sanitizeUserOptions(updated.options),
			};
		}),
	// The local Controller token is a server-wide credential (and may fall back
	// to ZT_SECRET). Restrict its URL/secret mutation to administrators; allowing
	// any logged-in user to point it at an arbitrary host would create an SSRF
	// primitive carrying that privileged header.
	setLocalZt: adminRoleProtectedRoute
		.input(
			z.object({
				localControllerUrl: z.string().optional(),
				localControllerSecret: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (input?.localControllerUrl && process.env.ZT_ADDR) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Remove the ZT_ADDR environment variable to use this feature!",
				});
			}

			const defaultLocalZtUrl = isRunningInDocker()
				? "http://zerotier:9993"
				: "http://127.0.0.1:9993";

			// we use upsert in case the user has no options yet
			const updated = await ctx.prisma.user.update({
				where: {
					id: ctx.session.user.id,
				},
				data: {
					options: {
						upsert: {
							create: {
								localControllerUrl: input.localControllerUrl || defaultLocalZtUrl,
								localControllerSecret: input.localControllerSecret,
							},
							update: {
								localControllerUrl: input.localControllerUrl || defaultLocalZtUrl,
								localControllerSecret: input.localControllerSecret,
							},
						},
					},
				},
				include: {
					options: true,
				},
			});
			ztController.clearApiCredentialsCache?.(ctx.session.user.id);

			return {
				status: "success",
				options: sanitizeUserOptions(updated.options),
			};
		}),
	getApiToken: protectedProcedure.query(async ({ ctx }) => {
		const tokens = await ctx.prisma.aPIToken.findMany({
			where: {
				userId: ctx.session.user.id,
			},
			orderBy: {
				createdAt: "asc",
			},
		});

		// if expiresAt is < now, set isActive to false. use for of loop to avoid async issues
		for (const token of tokens) {
			if (token.expiresAt) {
				await ctx.prisma.aPIToken.update({
					where: {
						id: token.id,
					},
					data: {
						isActive: token.expiresAt > new Date(),
					},
				});
			}
		}
		return tokens;
	}),
	addApiToken: protectedProcedure
		.input(
			z.object({
				name: z.string().min(3).max(50),
				daysToExpire: z.string(),
				apiAuthorizationType: z.array(z.enum(["PERSONAL", "ORGANIZATION"])),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// generate daysToExpire date. If "never" is selected or an empty string, the token will never expire.
				const daysToExpire = parseInt(input.daysToExpire);
				let expiresAt: Date | null = new Date();
				if (!Number.isNaN(daysToExpire) && daysToExpire > 0) {
					expiresAt.setDate(expiresAt.getDate() + daysToExpire);
				} else {
					expiresAt = null; // Token never expires
				}

				// token factory
				const tokenContent = JSON.stringify({
					userId: ctx.session.user.id,
					apiAuthorizationType: input.apiAuthorizationType,
				});

				// hash token
				const tokenHash = encrypt(tokenContent, generateInstanceSecret(API_TOKEN_SECRET));

				// store token in database with tokenHash
				const token = await ctx.prisma.aPIToken.create({
					data: {
						token: tokenHash,
						name: input.name,
						apiAuthorizationType: input.apiAuthorizationType,
						userId: ctx.session.user.id,
						expiresAt,
					},
				});

				// Add the database token ID to the token hash for reference
				const tokenId = token.id.toString(); // Just in case the token id is not a string ( old db structure )
				const tokenWithIdContent = JSON.stringify({
					...JSON.parse(tokenContent),
					tokenId,
				});

				// hash token with token id
				const tokenWithIdHash = encrypt(
					tokenWithIdContent,
					generateInstanceSecret(API_TOKEN_SECRET),
				);

				// Update the token in the database with the new hash that includes the tokenId
				const updatedToken = await ctx.prisma.aPIToken.update({
					where: { id: token.id },
					data: { token: tokenWithIdHash },
				});

				return updatedToken;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error.message,
				});
			}
		}),

	deleteApiToken: protectedProcedure
		.input(
			z.object({
				id: z.union([z.string(), z.number()]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			return await ctx.prisma.aPIToken.delete({
				where: {
					id: input.id.toString(),
					userId: ctx.session.user.id,
				},
			});
		}),
	deleteUserDevice: protectedProcedure
		.input(
			z.object({
				deviceId: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Verify the device belongs to the current user before deleting
			const device = await ctx.prisma.userDevice.findUnique({
				where: {
					deviceId: input.deviceId,
				},
				select: { userId: true },
			});

			if (!device || device.userId !== ctx.session.user.id) {
				throw new Error("Device not found or you do not have permission to delete it.");
			}

			await ctx.prisma.userDevice.delete({
				where: {
					deviceId: input.deviceId,
				},
			});

			return input.deviceId;
		}),
});
