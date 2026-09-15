import { sortMembers } from "~/utils/memberSorting";
import type { MemberEntity } from "~/types/local/member";

const member = (extra: Partial<MemberEntity>): MemberEntity =>
	({
		id: "0000000000",
		name: "",
		authorized: true,
		ipAssignments: [],
		peers: {},
		...extra,
	}) as MemberEntity;

test("sorts latency numerically and keeps unavailable values last", () => {
	const rows = [
		member({ id: "0000000003", latencyMs: null }),
		member({ id: "0000000001", latencyMs: 8 }),
		member({ id: "0000000002", latencyMs: 120 }),
	];
	expect(sortMembers(rows, "latencyMs", "asc").map((row) => row.id)).toEqual([
		"0000000001",
		"0000000002",
		"0000000003",
	]);
});

test("uses a deterministic connection path order", () => {
	const rows = [
		member({ id: "0000000003", connectionType: "direct_wan" }),
		member({ id: "0000000001", connectionType: "tcp_relay" }),
		member({ id: "0000000002", connectionType: "udp_relay" }),
	];
	expect(sortMembers(rows, "connectionType", "asc").map((row) => row.id)).toEqual([
		"0000000001",
		"0000000002",
		"0000000003",
	]);
});
