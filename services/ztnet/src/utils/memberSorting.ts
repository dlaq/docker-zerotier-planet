import type { MemberEntity } from "~/types/local/member";
import { sortIP } from "~/utils/sorting";

/** Sort keys shared by the members table, API validation, and central sorting. */
export const MEMBER_SORT_VALUES = [
	"id",
	"name",
	"description",
	"authorized",
	"online",
	"ipAssignments",
	"physicalAddress",
	"connectionType",
	"latencyMs",
	"relayBytesTotal",
	"lastSeen",
	"lastOnlineAt",
	"lastOfflineAt",
	"creationTime",
	"notations",
	// Kept as an input alias for clients that persisted the former column id.
	"conStatus",
] as const;

export type MemberSortKey = (typeof MEMBER_SORT_VALUES)[number];
export type MemberSortDirection = "asc" | "desc";

const connectionOrder: Record<string, number> = {
	offline: 0,
	tcp_relay: 1,
	udp_relay: 2,
	relay: 3,
	direct_lan: 4,
	direct_wan: 5,
	controller: 6,
	unknown: 7,
};

const asMillis = (value: unknown): number | null => {
	if (value instanceof Date) {
		const result = value.getTime();
		return Number.isFinite(result) ? result : null;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const result = new Date(value).getTime();
		return Number.isFinite(result) ? result : null;
	}
	return null;
};

const firstIp = (value: unknown): bigint | null => {
	const raw = Array.isArray(value) ? value[0] : value;
	if (typeof raw !== "string" || raw.length === 0) return null;
	const address = raw.split("/")[0];
	try {
		return sortIP(address);
	} catch (_error) {
		return null;
	}
};

const text = (value: unknown): string | null => {
	if (typeof value !== "string" || value.length === 0) return null;
	return value.toLocaleLowerCase();
};

const connectionType = (member: MemberEntity): string | null => {
	if (typeof member.connectionType === "string") return member.connectionType;
	if (typeof member.conStatus === "number") {
		// Legacy rows can be sorted before their first metric reconcile.
		return (
			["offline", "relay", "direct_lan", "direct_wan", "controller", "unknown"][
				member.conStatus
			] ?? "unknown"
		);
	}
	return null;
};

const valueFor = (
	member: MemberEntity,
	key: MemberSortKey,
): string | number | bigint | null => {
	switch (key) {
		case "id":
			return text(member.id);
		case "name":
			return text(member.name);
		case "description":
			return text(member.description);
		case "authorized":
			return member.authorized == null ? null : member.authorized ? 1 : 0;
		case "online":
			return member.online == null ? null : member.online ? 1 : 0;
		case "ipAssignments":
			return firstIp(member.ipAssignments);
		case "physicalAddress":
			return firstIp(member.physicalAddress);
		case "connectionType":
		case "conStatus": {
			const type = connectionType(member);
			return type === null ? null : (connectionOrder[type] ?? 99);
		}
		case "latencyMs": {
			if (typeof member.latencyMs === "number" && Number.isFinite(member.latencyMs))
				return member.latencyMs >= 0 ? member.latencyMs : null;
			const peerLatency =
				member.peers && "latency" in member.peers ? member.peers.latency : null;
			return typeof peerLatency === "number" && peerLatency >= 0 ? peerLatency : null;
		}
		case "relayBytesTotal":
			try {
				return member.relayBytesTotal ? BigInt(member.relayBytesTotal) : null;
			} catch (_error) {
				return null;
			}
		case "lastSeen":
			return asMillis(member.lastSeen);
		case "lastOnlineAt":
			return asMillis(member.lastOnlineAt);
		case "lastOfflineAt":
			return asMillis(member.lastOfflineAt);
		case "creationTime":
			return asMillis(member.creationTime);
		case "notations":
			return text(
				(member.notations ?? [])
					.map((notation) => notation.label?.name ?? "")
					.filter(Boolean)
					.join(","),
			);
	}
};

const compareValues = (
	a: string | number | bigint | null,
	b: string | number | bigint | null,
	direction: MemberSortDirection,
): number => {
	// Keep unknown values together at the end in either direction. This is more
	// useful for latency/timestamps than database-specific NULLS FIRST defaults.
	if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
	if (b === null || b === undefined) return -1;
	let result = 0;
	if (typeof a === "string" && typeof b === "string") result = a < b ? -1 : a > b ? 1 : 0;
	else if (typeof a === "bigint" && typeof b === "bigint")
		result = a < b ? -1 : a > b ? 1 : 0;
	else {
		const na = Number(a);
		const nb = Number(b);
		result = na < nb ? -1 : na > nb ? 1 : 0;
	}
	return direction === "desc" ? -result : result;
};

export const compareMembers = (
	a: MemberEntity,
	b: MemberEntity,
	key: MemberSortKey,
	direction: MemberSortDirection,
): number => {
	const result = compareValues(valueFor(a, key), valueFor(b, key), direction);
	if (result !== 0) return result;
	// Stable deterministic tie-breaker keeps pagination from jumping when many
	// members have no latency or no history.
	return compareValues(text(a.id), text(b.id), "asc");
};

export const sortMembers = <T extends MemberEntity>(
	members: T[],
	key: MemberSortKey,
	direction: MemberSortDirection,
): T[] => [...members].sort((a, b) => compareMembers(a, b, key, direction));
