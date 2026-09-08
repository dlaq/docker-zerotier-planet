import { auth } from "./auth";
import { prisma } from "~/server/db";

/** A valid cookie alone does not authorize a disabled or expired account. */
export async function getActiveSession(options: { headers: Headers }) {
	const session = await auth.api.getSession(options);
	if (!session) return null;
	const user = await prisma.user.findUnique({
		where: { id: session.user.id },
		select: {
			isActive: true,
			expiresAt: true,
			role: true,
			userGroup: { select: { expiresAt: true } },
		},
	});
	const now = Date.now();
	if (
		!user?.isActive ||
		(user.expiresAt && user.expiresAt.getTime() <= now) ||
		(user.role !== "ADMIN" &&
			user.userGroup?.expiresAt &&
			user.userGroup.expiresAt.getTime() <= now)
	)
		return null;
	// Use the current role even if a future auth-library cache changes defaults.
	return { ...session, user: { ...session.user, role: user.role } };
}
