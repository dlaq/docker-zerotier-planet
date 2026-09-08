import { prisma } from "~/server/db";
import type { Prisma, PrismaClient } from "@prisma/client";

// REST callers may already be inside a transaction; never open a second
// connection for a credential row whose User is still uncommitted.
export async function withAccountTransaction<T>(
	client: PrismaClient | Prisma.TransactionClient,
	work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return "$transaction" in client ? client.$transaction(work) : work(client);
}

/**
 * Keep `Account` (better-auth's credential store, where `providerId="credential"`)
 * in sync with `User.hash` whenever a password is written.
 *
 * better-auth verifies passwords on sign-in by reading `Account.password` for the
 * row with `providerId="credential"` (see better-auth's `/sign-in/email` handler).
 * If we only update `User.hash`, the next login fails because the two stores drift.
 *
 * Use this any time `User.hash` is written from outside better-auth (registration,
 * password reset, profile-page password change).
 */
export async function upsertCredentialAccount(
	userId: string,
	passwordHash: string,
	client: Pick<Prisma.TransactionClient, "account"> = prisma,
): Promise<void> {
	await client.account.upsert({
		where: {
			providerId_accountId: {
				providerId: "credential",
				accountId: userId,
			},
		},
		create: {
			userId,
			accountId: userId,
			providerId: "credential",
			password: passwordHash,
		},
		update: {
			password: passwordHash,
		},
	});
}
