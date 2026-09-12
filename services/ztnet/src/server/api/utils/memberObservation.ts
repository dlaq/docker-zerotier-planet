import { z } from "zod";
import type { network_members } from "@prisma/client";
import type { MemberStatusSnapshot } from "~/types/memberObservation";
import type { MemberEntity, Peers } from "~/types/local/member";
import type { UserContext } from "~/types/ctx";
import * as ztController from "~/utils/ztApi";
import { ConnectionStatus, determineConnectionStatus } from "~/utils/memberConnection";

const time = z.number().int().min(0).max(8640000000000000);
const schema = z
	.object({
		clock: time,
		controllerStartedAt: time,
		onlineWindowMs: z.number().int().positive().max(3600000),
		members: z.record(
			z.string().regex(/^[0-9a-f]{10}$/i),
			z.object({
				observed: z.boolean(),
				online: z.boolean(),
				lastSeen: time,
				lastOnline: time,
			}),
		),
	})
	.refine(
		(s) =>
			s.controllerStartedAt <= s.clock &&
			Object.values(s.members).every(
				(m) =>
					!m.observed ||
					(m.lastSeen > 0 &&
						m.lastOnline > 0 &&
						m.lastOnline <= m.lastSeen &&
						m.lastSeen <= s.clock),
			),
	);
export const parseMemberStatus = (value: unknown): MemberStatusSnapshot =>
	schema.parse(value);

export interface LiveObservation {
	snapshot: MemberStatusSnapshot | null;
	peers: Map<string, Peers>;
	peersAvailable: boolean;
	statusAvailable: boolean;
}
export async function readLiveObservation(
	ctx: UserContext,
	nwid: string,
): Promise<LiveObservation> {
	const [peers, status] = await Promise.allSettled([
		Promise.resolve().then(() => ztController.peers(ctx)),
		Promise.resolve().then(() => ztController.member_status(ctx, nwid)),
	]);
	return {
		peers: new Map(
			peers.status === "fulfilled" ? peers.value.map((p) => [p.address, p as Peers]) : [],
		),
		snapshot: status.status === "fulfilled" ? status.value : null,
		peersAvailable: peers.status === "fulfilled",
		statusAvailable: status.status === "fulfilled",
	};
}

/** Compute observed times without substituting page refresh time for lastSeen. */
export function observeMember(
	db: network_members,
	member: MemberEntity,
	live: LiveObservation,
): Partial<network_members> {
	const source = live.snapshot?.members[db.id];
	const snapshot = live.snapshot;
	const observedFullWindow =
		!!snapshot &&
		snapshot.clock -
			Math.max(snapshot.controllerStartedAt, db.creationTime?.getTime() || 0) >=
			snapshot.onlineWindowMs;
	const known =
		live.statusAvailable && !!source && (source.observed || observedFullWindow);
	member.statusSource = !live.statusAvailable
		? "unavailable"
		: live.snapshot
			? "controller"
			: "legacy";
	member.conStatus =
		known || (live.statusAvailable && !live.snapshot)
			? determineConnectionStatus(
					member,
					known ? source.online : undefined,
					live.peersAvailable,
				)
			: ConnectionStatus.Unknown;
	member.online = known ? source.online : undefined;
	const data: Partial<network_members> = {};
	if (
		member.conStatus === ConnectionStatus.Unknown &&
		db.connectionPendingStatus != null
	) {
		data.connectionPendingStatus = null;
		data.connectionPendingSince = null;
	}
	if (!known) return data;

	data.online = source.online;
	if (db.notifyOnFirstOnline) data.notifyOnFirstOnline = false;
	data.statusObservedAt = new Date(snapshot.clock);
	data.observationControllerStartedAt = new Date(snapshot.controllerStartedAt);
	if (source.observed) {
		data.lastSeen = new Date(source.lastSeen);
		data.sourceLastOnlineAt = new Date(source.lastOnline);
	}
	if (member.conStatus !== ConnectionStatus.Unknown) {
		if (
			db.online &&
			source.online &&
			db.connectionStatus != null &&
			db.connectionStatus !== member.conStatus
		) {
			const continuous =
				db.statusObservedAt && snapshot.clock - db.statusObservedAt.getTime() <= 45000;
			if (
				continuous &&
				db.connectionPendingStatus === member.conStatus &&
				db.connectionPendingSince &&
				snapshot.clock - db.connectionPendingSince.getTime() >= 30000
			) {
				data.connectionStatus = member.conStatus;
				data.connectionPendingStatus = null;
				data.connectionPendingSince = null;
			} else if (!continuous || db.connectionPendingStatus !== member.conStatus) {
				data.connectionPendingStatus = member.conStatus;
				data.connectionPendingSince = new Date(snapshot.clock);
			}
		} else {
			data.connectionStatus = member.conStatus;
			data.connectionPendingStatus = null;
			data.connectionPendingSince = null;
		}
	}
	if (source.online) {
		// A controller restart resets its in-memory observations. Preserve the last
		// observed online transition when there is no evidence the node went down.
		const differentBoot =
			db.observationControllerStartedAt?.getTime() !== snapshot.controllerStartedAt;
		const sameObservedTransition = db.sourceLastOnlineAt?.getTime() === source.lastOnline;
		const preserveOnlineSince =
			db.statusObservedAt &&
			db.online &&
			db.lastOnlineAt &&
			(differentBoot || sameObservedTransition);
		data.lastOnlineAt = preserveOnlineSince
			? db.lastOnlineAt
			: new Date(source.lastOnline);
	} else if (db.statusObservedAt && db.online) {
		data.lastOfflineAt = new Date(
			Math.min(
				snapshot.clock,
				(source.observed ? source.lastSeen : snapshot.controllerStartedAt) +
					snapshot.onlineWindowMs,
			),
		);
	}
	for (const [key, value] of Object.entries(data)) {
		const old = db[key as keyof network_members];
		if (
			(value instanceof Date &&
				old instanceof Date &&
				value.getTime() === old.getTime()) ||
			value === old
		)
			delete data[key as keyof network_members];
	}
	Object.assign(member, data);
	return data;
}
