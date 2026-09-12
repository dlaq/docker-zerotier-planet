import * as cron from "cron";
import { prisma } from "./server/db";
import * as ztController from "~/utils/ztApi";

import { reconcileNetworkMembersOnce } from "./server/api/services/memberService";

type FakeContext = {
	session: {
		user: {
			id: string;
		};
	};
};

/**
 * Checks for expired users and deactivates them.
 * This includes both individually expired users and users in expired groups.
 * Returns the number of users that were deactivated.
 */
export const checkAndDeactivateExpiredUsers = async (): Promise<number> => {
	// Check for individually expired users
	const expUsers = await prisma.user.findMany({
		where: {
			expiresAt: {
				lt: new Date(),
			},
			isActive: true,
			NOT: {
				role: "ADMIN",
			},
		},
		select: {
			network: true,
			id: true,
			role: true,
		},
	});

	// Check for users in expired groups
	const usersInExpiredGroups = await prisma.user.findMany({
		where: {
			isActive: true,
			NOT: {
				role: "ADMIN",
			},
			userGroup: {
				expiresAt: {
					lt: new Date(),
				},
			},
		},
		select: {
			network: true,
			id: true,
			role: true,
			userGroup: {
				select: {
					name: true,
					expiresAt: true,
				},
			},
		},
	});

	// Combine both expired user types (need to type them properly)
	const allExpiredUsers: Array<{
		network: Array<{ nwid: string }>;
		id: string;
		role: string;
		userGroup?: {
			name: string;
			expiresAt: Date | null;
		} | null;
	}> = [
		...expUsers.map((user) => ({ ...user, userGroup: undefined })),
		...usersInExpiredGroups,
	];

	// if no users return
	if (allExpiredUsers.length === 0) return 0;

	for (const userObj of allExpiredUsers) {
		if (userObj.role === "ADMIN") continue;

		const context: FakeContext = {
			session: {
				user: {
					id: userObj.id,
				},
			},
		};

		// Deauthorize all network members for this user
		for (const network of userObj.network) {
			try {
				const members = await ztController.network_members(
					// @ts-ignore
					context,
					network.nwid,
					false,
				);
				for (const member in members) {
					const ctx = {
						session: {
							user: {
								id: userObj.id,
							},
						},
					};
					await ztController.member_update({
						// @ts-ignore
						ctx,
						nwid: network.nwid,
						central: false,
						memberId: member,
						updateParams: {
							authorized: false,
						},
					});
				}
			} catch (error) {
				// Continue with other networks if one fails
				console.error(
					`Failed to deauthorize members for network ${network.nwid}:`,
					error,
				);
			}
		}

		// update user isActive to false
		await prisma.user.update({
			where: {
				id: userObj.id,
			},
			data: {
				isActive: false,
			},
		});
	}

	return allExpiredUsers.length;
};

export const CheckExpiredUsers = async () => {
	new cron.CronJob(
		// "*/10 * * * * *", // every 10 seconds ( testing )
		"0 0 0 * * *", // 12:00:00 AM (midnight) every day
		async () => {
			try {
				await checkAndDeactivateExpiredUsers();
			} catch (error) {
				console.error("Error in CheckExpiredUsers cron job:", error);
			}
		},
		null,
		true,
		"America/Los_Angeles",
	);
};

/** Observe managed networks even when nobody has a browser tab open. */
let monitorStarted = false;
export const updatePeers = async () => {
	if (monitorStarted) return;
	monitorStarted = true;
	const tick = async () => {
		try {
			const networks = await prisma.network.findMany({
				select: {
					nwid: true,
					authorId: true,
					organization: { select: { ownerId: true } },
				},
			});
			for (const network of networks) {
				const ownerId = network.authorId || network.organization?.ownerId;
				if (!ownerId) continue;
				try {
					await reconcileNetworkMembersOnce(
						{ session: { user: { id: ownerId } } } as import("~/types/ctx").UserContext,
						network.nwid,
					);
				} catch (_error) {
					console.error(`Member observation failed for network ${network.nwid}`);
				}
			}
		} catch (_error) {
			console.error("Member observation unavailable");
		}
		setTimeout(tick, 15000).unref();
	};
	setTimeout(tick, 5000).unref();
};
