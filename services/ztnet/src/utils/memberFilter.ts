import type { MemberEntity } from "~/types/local/member";
import { ConnectionStatus } from "~/utils/memberConnection";

/**
 * Filters supported by the network members table. Keep this list shared by the
 * API and the UI so a URL/client cannot request a filter the table cannot
 * render (or vice versa).
 */
export const MEMBER_FILTER_VALUES = [
	"all",
	"online",
	"offline",
	"online_15m",
	"online_1h",
	"online_6h",
	"online_24h",
	"online_3d",
	"online_7d",
	"online_30d",
	"online_90d",
	"online_180d",
	"online_365d",
	"never_online",
	"seen_15m",
	"seen_1h",
	"seen_6h",
	"seen_24h",
	"seen_7d",
	"seen_30d",
	"never_seen",
	"authorized",
	"unauthorized",
	"direct_lan",
	"direct_wan",
	"relayed",
	"controller",
	"unknown_connection",
] as const;

export type MemberFilter = (typeof MEMBER_FILTER_VALUES)[number];

const MEMBER_FILTER_SET = new Set<string>(MEMBER_FILTER_VALUES);

export const isMemberFilter = (value: string): value is MemberFilter =>
	MEMBER_FILTER_SET.has(value);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ONLINE_FILTER_WINDOWS: Partial<Record<MemberFilter, number>> = {
	online_15m: 15 * MINUTE,
	online_1h: HOUR,
	online_6h: 6 * HOUR,
	online_24h: DAY,
	online_3d: 3 * DAY,
	online_7d: 7 * DAY,
	online_30d: 30 * DAY,
	online_90d: 90 * DAY,
	online_180d: 180 * DAY,
	online_365d: 365 * DAY,
};

export const SEEN_FILTER_WINDOWS: Partial<Record<MemberFilter, number>> = {
	seen_15m: 15 * MINUTE,
	seen_1h: HOUR,
	seen_6h: 6 * HOUR,
	seen_24h: DAY,
	seen_7d: 7 * DAY,
	seen_30d: 30 * DAY,
};

const toMillis = (value: MemberEntity["lastSeen"]): number | null => {
	if (value instanceof Date) {
		const millis = value.getTime();
		return Number.isFinite(millis) ? millis : null;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const millis = new Date(value).getTime();
		return Number.isFinite(millis) ? millis : null;
	}
	return null;
};

const lastSeenMillis = (member: Pick<MemberEntity, "lastSeen">): number | null =>
	toMillis(member.lastSeen);

/** The hosted ZeroTier API exposes a recent lastSeen heartbeat instead of the
 * local controller's explicit online flag. Match the table's cell semantics
 * (five minutes) for those members while respecting an explicit online value.
 */
export const memberIsOnline = (
	member: Pick<MemberEntity, "online" | "lastSeen">,
	now = Date.now(),
): boolean => {
	if (member.online !== undefined && member.online !== null) return member.online;
	const seen = lastSeenMillis(member);
	return seen !== null && seen <= now && now - seen <= 5 * MINUTE;
};

const memberLastOnlineMillis = (
	member: Pick<MemberEntity, "lastOnlineAt" | "lastOfflineAt" | "lastSeen">,
): number | null => toMillis(member.lastOnlineAt) ?? lastSeenMillis(member);

const memberWasOnlineRecently = (
	member: Pick<MemberEntity, "online" | "lastOnlineAt" | "lastOfflineAt" | "lastSeen">,
	windowMs: number,
	now: number,
): boolean => {
	if (memberIsOnline(member, now)) return true;
	const since = now - windowMs;
	return [toMillis(member.lastOnlineAt), toMillis(member.lastOfflineAt)].some(
		(value) => value !== null && value >= since && value <= now,
	);
};

/**
 * Client-side equivalent of the API filter. It is used for central networks,
 * whose members are supplied by the hosted API and therefore cannot be
 * filtered by Prisma.
 */
export const matchesMemberFilter = (
	member: Pick<
		MemberEntity,
		"online" | "lastSeen" | "lastOnlineAt" | "lastOfflineAt" | "authorized" | "conStatus"
	>,
	filter: MemberFilter,
	now = Date.now(),
): boolean => {
	if (filter === "all") return true;
	if (filter === "online") return memberIsOnline(member, now);
	if (filter === "offline") return !memberIsOnline(member, now);

	const lastOnline = memberLastOnlineMillis(member);
	const online = memberIsOnline(member, now);
	const onlineWindow = ONLINE_FILTER_WINDOWS[filter];
	if (onlineWindow !== undefined)
		return memberWasOnlineRecently(member, onlineWindow, now);
	if (filter === "never_online") return !online && lastOnline === null;

	const seenWindow = SEEN_FILTER_WINDOWS[filter];
	if (seenWindow !== undefined) {
		const seen = lastSeenMillis(member);
		return seen !== null && seen <= now && now - seen <= seenWindow;
	}
	if (filter === "never_seen") return lastSeenMillis(member) === null;

	if (filter === "authorized") return member.authorized === true;
	if (filter === "unauthorized") return member.authorized !== true;

	const status = member.conStatus ?? ConnectionStatus.Unknown;
	if (filter === "direct_lan") return status === ConnectionStatus.DirectLAN;
	if (filter === "direct_wan") return status === ConnectionStatus.DirectWAN;
	if (filter === "relayed") return status === ConnectionStatus.Relayed;
	if (filter === "controller") return status === ConnectionStatus.Controller;
	if (filter === "unknown_connection") return status === ConnectionStatus.Unknown;
	return true;
};
