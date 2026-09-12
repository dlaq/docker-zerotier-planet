import {
	enqueueNotification,
	memberConfigSummary,
	nodeEventContext,
	persistObservedMember,
} from "~/server/notifications/service";
import { UserContext } from "~/types/ctx";
import { MemberEntity, Peers } from "~/types/local/member";
import { activePreferredPath } from "~/utils/memberConnection";
import {
	readLiveObservation,
	observeMember,
	type LiveObservation,
} from "../utils/memberObservation";
import * as ztController from "~/utils/ztApi";
import { prisma } from "~/server/db";
import { sendWebhook } from "~/utils/webhook";
import { HookType, MemberJoined } from "~/types/webhooks";
import { network_members, Prisma } from "@prisma/client";

/**
 * syncMemberPeersAndStatus
 * Synchronizes the peers and connection status of the given members.
 * @param ctx - The user context.
 * @param members - An array of member entities.
 */
export const syncMemberPeersAndStatus = async (
	ctx: UserContext,
	nwid: string,
	ztMembers: MemberEntity[],
) => {
	if (ztMembers.length === 0) return [];

	// PERFORMANCE OPTIMIZATION: Fetch all database members in a single query instead of N queries
	const dbMembersArray = await prisma.network_members.findMany({
		where: {
			nwid,
			id: { in: ztMembers.map((m) => m.id) },
			deleted: false,
		},
		include: { notations: { include: { label: true } } },
	});

	// Create a Map for O(1) lookup instead of repeated database queries
	const dbMembersMap = new Map(dbMembersArray.map((m) => [m.id, m]));

	// get peers
	const live = await readLiveObservation(ctx, nwid);
	const controllerPeers = [...live.peers.values()];

	//!TODO Promise.all causing race condition. Need to refactor to use for loop
	const updatedMembers = await Promise.all(
		ztMembers.map(async (ztMember) => {
			// TODO currently there is no way to distinguish peers by network id, so we have to fetch all peers
			// this will make the node active in all networks it is part of if it is active in one of them.
			// Should open a issue at ZeroTier
			const peers = controllerPeers.filter(
				(peer) => peer.address === ztMember.address,
			)[0];

			// PERFORMANCE: Retrieve from in-memory Map instead of database query
			const dbMember = dbMembersMap.get(ztMember.id) || null;

			// Find the active preferred path in the peers object
			const preferredPath = activePreferredPath(peers);
			const { physicalAddress, ...restOfDbMembers } = dbMember || {};

			// Capture DB name before merge so we can restore it if controller data overwrites with empty value
			// Need to safely access because restOfDbMembers may be an empty object
			const dbName = (restOfDbMembers as { name?: string } | undefined)?.name;

			// Merge the data from the database with the data from Controller
			const updatedMember = {
				...restOfDbMembers,
				...ztMember,
				physicalAddress: preferredPath?.address ?? physicalAddress,
				peers: peers || {},
			} as MemberEntity;

			// ISSUE #719: Smart name preservation - use database name if available, fallback to controller name
			if (dbName?.trim()) {
				// Database has a name - use it (preserves user customizations)
				updatedMember.name = dbName;
			} else if (!dbName && ztMember.name && ztMember.name.trim()) {
				// Database has no name but controller does - use controller name
				updatedMember.name = ztMember.name;
			} else if (dbName && !updatedMember.name) {
				// Fallback: preserve any database name if controller provides empty
				updatedMember.name = dbName;
			}

			const observed = dbMember ? observeMember(dbMember, updatedMember, live) : {};
			const memberIsOnline = updatedMember.online === true;
			const updateData: Partial<network_members> = {
				id: updatedMember.id,
				address: updatedMember.address,
				authorized: updatedMember.authorized,
				...observed,
			};

			// update physicalAddress if the member is connected
			if (memberIsOnline && updatedMember?.physicalAddress) {
				updateData.physicalAddress = updatedMember.physicalAddress;
			}

			// ISSUE #719: Persist resolved name to database to ensure consistency
			if (updatedMember.name !== dbMember?.name) {
				updateData.name = updatedMember.name;
			}

			// Update the member in the database
			const updateResult = await prisma.network_members.updateMany({
				where: { nwid: updatedMember.nwid, id: updatedMember.id },
				data: updateData,
			});

			// If the member was not found in the database, add it
			if (updateResult.count === 0) {
				await addNetworkMember(ctx, updatedMember).catch(console.error);
			}

			// Return null if the member is deleted.
			if (!dbMember) {
				return null;
			}

			// Return the updated member
			return updatedMember;
		}),
	);
	// console.log(updatedMembers);
	// console.log(updatedMembers[0].peers?.paths);
	return updatedMembers.filter(Boolean); // Filter out any null values
};

const findExistingMemberName = async (
	ctx: UserContext,
	memberId: string,
	currentNwid: string,
	isOrganization: boolean,
	organizationId?: string,
) => {
	try {
		// First check database for existing name
		const whereClause =
			isOrganization && organizationId
				? {
						id: memberId,
						name: { not: null },
						deleted: false,
						nwid: { not: currentNwid },
						nwid_ref: {
							organizationId: organizationId,
						},
					}
				: {
						id: memberId,
						name: { not: null },
						deleted: false,
						nwid: { not: currentNwid },
						nwid_ref: {
							authorId: ctx.session.user.id,
							organizationId: null,
						},
					};

		const existingMember = await prisma.network_members.findFirst({
			where: whereClause,
			select: { name: true },
			orderBy: {
				creationTime: "desc",
			},
		});

		if (existingMember?.name) {
			return existingMember.name;
		}

		// If no name found in database, check controller
		const networks = await ztController.get_controller_networks(ctx, false);

		const relevantNetworks = await prisma.network.findMany({
			where: {
				AND: [
					{ nwid: { in: networks as string[] } },
					{ nwid: { not: currentNwid } },
					isOrganization && organizationId
						? { organizationId: organizationId }
						: {
								authorId: ctx.session.user.id,
								organizationId: null,
							},
				],
			},
			select: { nwid: true },
		});

		// Search for member in each network using controller
		for (const network of relevantNetworks) {
			try {
				const memberDetails = await ztController.member_details(
					ctx,
					network.nwid,
					memberId,
					false,
				);

				if (memberDetails?.name) {
					return memberDetails.name;
				}
			} catch (_error) {
				// Skip if member not found in this network
			}
		}

		return null;
	} catch (error) {
		console.error("Error finding existing member name:", error);
		return null;
	}
};

/**
 * Adds a member to the database.
 *
 * @param ctx - The context object.
 * @param member - The member entity to be added.
 * @returns A promise that resolves to the created network member.
 */
const addNetworkMember = async (ctx, member: MemberEntity) => {
	// 1. get the user options
	// 2. check if the new member is joining a organization network
	const [user, memberOfOrganization] = await Promise.all([
		prisma.user.findUnique({
			where: { id: ctx.session.user.id },
			select: { options: true, network: { select: { nwid: true } } },
		}),
		prisma.network.findFirst({
			where: { nwid: member.nwid },
			select: { organizationId: true, organization: { select: { settings: true } } },
		}),
	]);

	let name = null;

	// send webhook if the new member is joining a organization network.
	// Guard on organizationId (not just the network row, which always exists): a
	// personal network has organizationId === null, and the org webhook / org-admin
	// notification below are meaningless there (and previously logged a warning on
	// every join).
	if (memberOfOrganization?.organizationId) {
		// check if global organization member naming is enabled, and if so find the first available name
		if (memberOfOrganization.organization?.settings?.renameNodeGlobally) {
			name = await findExistingMemberName(
				ctx,
				member.id,
				member.nwid,
				true,
				memberOfOrganization.organizationId,
			);
		}
	}

	// Member is not joining an organization network
	if (!memberOfOrganization?.organizationId) {
		// check if addMemberIdAsName is enabled, and if so use the member id as the name
		if (user.options?.addMemberIdAsName) {
			name = member.id;
		}

		// check if global naming is enabled, and if so find the first available name
		// NOTE! this will take precedence over addMemberIdAsName above
		if (user.options?.renameNodeGlobally) {
			name = (await findExistingMemberName(ctx, member.id, member.nwid, false)) || name;
		}
	}

	const saved = await prisma.$transaction(async (tx) => {
		const existing = await tx.network_members.findUnique({
			where: { id_nwid: { id: member.id, nwid: member.nwid } },
		});
		const row = await tx.network_members.upsert({
			where: { id_nwid: { id: member.id, nwid: member.nwid } },
			create: {
				id: member.id,
				creationTime: new Date(),
				name,
				nwid_ref: { connect: { nwid: member.nwid } },
				deleted: false,
			},
			update: {},
		});
		if (!existing) {
			const network = await tx.network.findUnique({
				where: { nwid: member.nwid },
				select: { name: true },
			});
			await enqueueNotification(
				"node.added",
				`node.added:${member.nwid}:${member.id}:${row.nodeid}`,
				nodeEventContext(
					{ ...member, name: name || member.name },
					network?.name,
					"未加入",
					"已加入成员列表",
				),
				tx,
			);
		}
		return { row, created: !existing };
	});
	if (saved.created && memberOfOrganization?.organizationId) {
		try {
			await sendWebhook<MemberJoined>({
				hookType: HookType.NETWORK_JOIN,
				organizationId: memberOfOrganization.organizationId,
				memberId: member.id,
				networkId: member.nwid,
			});
		} catch (_error) {
			console.error("Member join webhook delivery failed");
		}
		try {
			const { sendOrganizationAdminNotification } = await import(
				"~/utils/organizationNotifications"
			);
			await sendOrganizationAdminNotification({
				organizationId: memberOfOrganization.organizationId,
				eventType: "NODE_ADDED",
				eventData: {
					networkId: member.nwid,
					networkName: member.nwid,
					nodeId: member.id,
					nodeName: name || member.id,
				},
			});
		} catch (_error) {
			console.error("Member join email delivery failed");
		}
	}
	return saved.row;
};

/**
 * Fetches zombie members from the database based on the provided network ID and enriched members.
 * A zombie member is a member that has been deleted.
 *
 * @param nwid - The network ID.
 * @param enrichedMembers - An array of enriched member entities.
 * @returns An array of zombie members.
 */
export const fetchZombieMembers = async (
	nwid: string,
	enrichedMembers: MemberEntity[],
) => {
	const getZombieMembersPromises = enrichedMembers.map((member) => {
		return prisma.network_members.findFirst({
			where: {
				nwid,
				id: member.id,
				deleted: true,
			},
		});
	});

	const zombieMembers = await Promise.all(getZombieMembersPromises);
	return zombieMembers.filter(Boolean).map(serializeMemberRow);
};

const MEMBER_DETAIL_BATCH_SIZE = 5;

/**
 * Fetches full member detail from the controller for the given ids, in small
 * batches (the controller has no bulk member endpoint). Failures are skipped.
 */
const fetchMemberDetailsBatched = async (
	ctx: UserContext,
	nwid: string,
	ids: string[],
): Promise<MemberEntity[]> => {
	const results: MemberEntity[] = [];
	for (let i = 0; i < ids.length; i += MEMBER_DETAIL_BATCH_SIZE) {
		const batch = ids.slice(i, i + MEMBER_DETAIL_BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((id) =>
				ztController.member_details(ctx, nwid, id, false).catch((err) => {
					console.error(`reconcileNetworkMembers: failed to fetch member ${id}:`, err);
					return null;
				}),
			),
		);
		for (const r of batchResults) if (r) results.push(r as MemberEntity);
	}
	return results;
};

/**
 * reconcileNetworkMembers
 *
 * Controller-truth, self-healing sync built to scale to large networks. The
 * ZeroTier controller has no bulk member endpoint, so fetching every member's
 * detail on every load is the bottleneck. Instead this:
 *   1. reads the cheap `{ memberId: revision }` map (the authoritative membership),
 *   2. fetches full detail ONLY for new or revision-changed members and caches
 *      their config (authorized, ipAssignments, flags, revision) in the DB,
 *   3. removes DB rows for members the controller no longer has (drift cleanup),
 *   4. computes live status from a single `peers` call (Map lookup, not O(n²)) and
 *      writes back only the members whose status actually changed.
 *
 * Pass `{ full: true }` to ignore cached revisions and refetch every member
 * (used by the periodic backstop resync).
 *
 * Returns the enriched, active members (DB-cached config + live status).
 */
export const reconcileNetworkMembers = async (
	ctx: UserContext,
	nwid: string,
	options: { full?: boolean } = {},
): Promise<MemberEntity[]> => {
	// 1. Authoritative membership + revisions from the controller (one cheap call).
	const revisionMap = (await ztController.network_members(ctx, nwid, false)) as Record<
		string,
		number
	>;
	const controllerIds = Object.keys(revisionMap);

	// 2. Current DB rows for this network.
	const dbMembers = await prisma.network_members.findMany({
		where: { nwid },
		include: { notations: { include: { label: true } } },
	});
	const dbMap = new Map(dbMembers.map((m) => [m.id, m]));

	// 3. Which members need a fresh detail fetch? New, revision-changed, or full
	//    resync. Stashed / permanently-deleted members stay hidden and are skipped.
	const idsToFetch = controllerIds.filter((id) => {
		const db = dbMap.get(id);
		if (db && (db.deleted || db.permanentlyDeleted)) return false;
		if (!db) return true;
		if (options.full) return true;
		// NULL vMajor/controllerConfig = row predates the version or controller
		// object cache (#984/#983); backfill it once. (The controller stores -1
		// for an unknown version, so this never re-triggers.)
		if (db.vMajor == null || db.controllerConfig == null) return true;
		return db.revision == null || db.revision !== revisionMap[id];
	});

	// 4. Fetch changed details (batched) and cache their config in the DB.
	const details = await fetchMemberDetailsBatched(ctx, nwid, idsToFetch);
	for (const detail of details) {
		const db = dbMap.get(detail.id);
		if (!db) {
			// New member: create the row (handles naming + join webhooks/notifications).
			await addNetworkMember(ctx, detail).catch(console.error);
		}
		await prisma.$transaction(async (tx) => {
			await tx.network_members.updateMany({
				where: { nwid, id: detail.id },
				data: {
					authorized: !!detail.authorized,
					ipAssignments: Array.isArray(detail.ipAssignments) ? detail.ipAssignments : [],
					noAutoAssignIps: !!detail.noAutoAssignIps,
					activeBridge: !!detail.activeBridge,
					address: detail.address ?? detail.id,
					revision: revisionMap[detail.id] ?? null,
					// Client version + raw controller object cache (#984/#983).
					...controllerCacheFields(detail),
					// Smart name preservation (#719): adopt the controller name only when the
					// DB has none — never clobber a user-set name.
					...(!db?.name?.trim() && detail.name?.trim() ? { name: detail.name } : {}),
				},
			});
			if (db?.controllerConfig) {
				const type =
					!!db.authorized !== !!detail.authorized
						? detail.authorized
							? "node.authorized"
							: "node.deauthorized"
						: JSON.stringify(db.ipAssignments) !==
									JSON.stringify(detail.ipAssignments || []) ||
								db.noAutoAssignIps !== !!detail.noAutoAssignIps ||
								db.activeBridge !== !!detail.activeBridge
							? "node.config.changed"
							: null;
				if (type) {
					const network = await tx.network.findUnique({
						where: { nwid },
						select: { name: true },
					});
					await enqueueNotification(
						type,
						`${type}:${nwid}:${detail.id}:${revisionMap[detail.id]}`,
						nodeEventContext(
							{ ...detail, name: db.name || detail.name },
							network?.name,
							memberConfigSummary(db),
							memberConfigSummary(detail),
						),
						tx,
					);
				}
			}
		});
	}

	// 5. Drift cleanup: active DB members the controller no longer knows about.
	const controllerIdSet = new Set(controllerIds);
	const orphanIds = dbMembers
		.filter((m) => !controllerIdSet.has(m.id) && !m.deleted && !m.permanentlyDeleted)
		.map((m) => m.id);
	if (orphanIds.length > 0) {
		await prisma.$transaction(async (tx) => {
			const network = await tx.network.findUnique({
				where: { nwid },
				select: { name: true },
			});
			for (const id of orphanIds) {
				const db = dbMap.get(id)!;
				await enqueueNotification(
					"node.removed",
					`node.removed:${nwid}:${id}:${db.nodeid}`,
					nodeEventContext(
						db as unknown as MemberEntity,
						network?.name,
						"网络成员",
						"已从 Controller 移除",
					),
					tx,
				);
			}
			await tx.network_members.deleteMany({ where: { nwid, id: { in: orphanIds } } });
		});
	}

	// Network presence and peer path data have different meanings.
	const live = await readLiveObservation(ctx, nwid);
	const peersByAddress = live.peers;

	// 7. Build the active member list from the reconciled DB rows + live status,
	//    writing back only members whose status actually changed.
	const activeDbMembers = await prisma.network_members.findMany({
		where: { nwid, id: { in: controllerIds }, deleted: false },
		include: { notations: { include: { label: true } } },
	});

	const statusWrites: Promise<unknown>[] = [];
	const enriched = activeDbMembers.map((db) => {
		const peers = peersByAddress.get(db.address || db.id) ?? ({} as Peers);
		const member = buildServedMember(db, peers, live);
		const data = observeMember(db, member, live);
		if (member.online && member.physicalAddress !== db.physicalAddress)
			data.physicalAddress = member.physicalAddress;
		if (
			member.online &&
			typeof peers.versionMajor === "number" &&
			peers.versionMajor >= 0
		) {
			if (db.vMajor !== peers.versionMajor) data.vMajor = peers.versionMajor;
			if (db.vMinor !== peers.versionMinor) data.vMinor = peers.versionMinor;
			if (db.vRev !== peers.versionRev) data.vRev = peers.versionRev;
		}
		if (Object.keys(data).length) {
			statusWrites.push(persistObservedMember(db, member, data));
		}

		return member;
	});

	await Promise.all(statusWrites);
	return enriched;
};

/**
 * attachLiveStatus
 *
 * Read-only enrichment: given DB member rows, attaches live peers + connection
 * status from a single controller `peers` call (no DB writes). Used by the
 * paginated read path so it can serve a page from the DB while still reflecting
 * up-to-the-moment online/Direct/Relayed status. Persisting that status is the
 * job of the background reconcile.
 */
export const attachLiveStatus = async (
	ctx: UserContext,
	members: network_members[],
): Promise<MemberEntity[]> => {
	const snapshots = new Map<string, LiveObservation>();
	for (const nwid of new Set(members.map((m) => m.nwid)))
		snapshots.set(nwid, await readLiveObservation(ctx, nwid));
	return members.map((db) => {
		const live = snapshots.get(db.nwid)!;
		return buildServedMember(
			db,
			live.peers.get(db.address || db.id) ?? ({} as Peers),
			live,
		);
	});
};

/**
 * Builds the member object served to API/page consumers: the cached raw
 * controller member (documented long-tail fields like objtype, identity, tags,
 * #983) overlaid with the DB row (the actively maintained truth — name,
 * authorized, status, version — so a stale cached object never wins) plus live
 * peer data and version semantics (#984).
 */
const buildServedMember = (
	db: network_members,
	peers: Peers,
	live: LiveObservation,
): MemberEntity => {
	const {
		controllerConfig,
		observationControllerStartedAt: _boot,
		sourceLastOnlineAt: _source,
		...dbFields
	} = db;
	const cached = (controllerConfig ?? {}) as Partial<MemberEntity>;
	const preferredPath = activePreferredPath(peers);
	const member = {
		...cached,
		...dbFields,
		name: preferredMemberName(dbFields.name, cached.name),
		lastSeen: db.statusObservedAt ? db.lastSeen : null,
		peers,
		physicalAddress: preferredPath?.address ?? db.physicalAddress,
	} as unknown as MemberEntity;
	observeMember(db, member, live);
	applyMemberVersion(member, peers);
	return member;
};

/**
 * Single source of truth for the DB columns produced from a freshly fetched
 * controller member object: the last known client version (#984) and the raw
 * object itself, which serves the documented long-tail REST fields that have
 * no dedicated column (#983). Used by the reconcile and by the REST update
 * write-through so the two can never diverge.
 */
export const controllerCacheFields = (
	detail: MemberEntity,
): Prisma.network_membersUpdateManyMutationInput => ({
	vMajor: detail.vMajor ?? -1,
	vMinor: detail.vMinor ?? -1,
	vRev: detail.vRev ?? -1,
	vProto: detail.vProto ?? -1,
	controllerConfig: detail as unknown as Prisma.InputJsonValue,
});

/**
 * Write-through cache update: persists a freshly fetched controller member
 * object so DB-first reads serve it immediately, without waiting for the next
 * reconcile. Call this from any mutation path that already holds the fresh
 * controller object (it costs one DB write and no controller calls).
 */
export const cacheControllerMember = async (
	nwid: string,
	detail: MemberEntity,
): Promise<void> => {
	if (!detail?.id) return;
	await prisma.network_members.updateMany({
		where: { nwid, id: detail.id },
		data: controllerCacheFields(detail),
	});
};

/**
 * Name preservation (#719): a user-set DB name always wins; the controller's
 * copy (possibly empty or stale) is only a fallback. The fallback covers
 * installs migrating from a setup where names were stored on the controller
 * by another UI, before the reconcile's name adoption has imported them.
 */
export const preferredMemberName = (
	dbName: string | null | undefined,
	controllerName: string | null | undefined,
): string | null => {
	if (dbName?.trim()) return dbName;
	if (controllerName?.trim()) return controllerName;
	return null;
};

/**
 * Strips internal-only columns from a member DB row before it is merged into
 * any client-facing response. `controllerConfig` is a server-side cache; its
 * contents are served field-by-field (buildServedMember), never as a blob.
 * Null-safe so callers can spread the result directly.
 */
export const serializeMemberRow = <T extends { controllerConfig?: unknown }>(
	row: T | null | undefined,
): Omit<T, "controllerConfig"> | Record<string, never> => {
	if (!row) return {};
	const { controllerConfig: _internal, ...rest } = row;
	return rest;
};

/**
 * Version semantics for a served member (#984): a DB NULL (row not yet
 * backfilled) surfaces as the controller's -1 "unknown", and while the member
 * is online the live peer version wins over the cached one. In-memory only —
 * persisting the version is the reconcile's job.
 */
const applyMemberVersion = (member: MemberEntity, peers: Peers): void => {
	member.vMajor ??= -1;
	member.vMinor ??= -1;
	member.vRev ??= -1;
	member.vProto ??= -1;
	if (typeof peers.versionMajor === "number" && peers.versionMajor !== -1) {
		member.vMajor = peers.versionMajor;
		member.vMinor = peers.versionMinor;
		member.vRev = peers.versionRev;
	}
};

// In-flight guard: keyed by network id, dedupes concurrent reconciles (the 10s
// poll, several open tabs, or getNetworkById + getNetworkMembers on the same
// page load) so they share a single controller sync instead of stacking.
const inFlightReconciles = new Map<string, Promise<MemberEntity[]>>();

/**
 * Reconcile a network's members, but only ONE reconcile per network runs at a
 * time — concurrent callers share the in-flight promise. Awaitable; used by the
 * cold-start (empty cache) read paths that must block until populated.
 */
export const reconcileNetworkMembersOnce = (
	ctx: UserContext,
	nwid: string,
	options: { full?: boolean } = {},
): Promise<MemberEntity[]> => {
	const existing = inFlightReconciles.get(nwid);
	if (existing) return existing;
	const run = reconcileNetworkMembers(ctx, nwid, options).finally(() => {
		inFlightReconciles.delete(nwid);
	});
	inFlightReconciles.set(nwid, run);
	return run;
};

/**
 * Fire-and-forget reconcile (deduped via reconcileNetworkMembersOnce). Returns
 * immediately; never throws into the caller. Used by warm read paths.
 */
export const triggerBackgroundReconcile = (
	ctx: UserContext,
	nwid: string,
	options: { full?: boolean } = {},
): void => {
	void reconcileNetworkMembersOnce(ctx, nwid, options).catch((err) => {
		console.error(`Background reconcile failed for network ${nwid}:`, err);
	});
};
