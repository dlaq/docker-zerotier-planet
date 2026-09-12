jest.mock("~/utils/ztApi", () => ({ peers: jest.fn(), member_status: jest.fn() }));
import {
	determineConnectionStatus,
	memberIpState,
	ConnectionStatus as S,
} from "~/utils/memberConnection";
import {
	observeMember,
	readLiveObservation,
	parseMemberStatus,
	type LiveObservation,
} from "~/server/api/utils/memberObservation";
import { statusEventTypes } from "~/server/notifications/service";
import * as zt from "~/utils/ztApi";
import type { MemberEntity } from "~/types/local/member";
import type { network_members } from "@prisma/client";
const id = "1234567890",
	nwid = "abcdef1234000001";
const row = (extra = {}) =>
	({
		id,
		nwid,
		address: id,
		creationTime: new Date(100),
		online: false,
		lastSeen: null,
		lastOnlineAt: null,
		lastOfflineAt: null,
		statusObservedAt: null,
		...extra,
	}) as network_members;
const member = (peers = {}) => ({ id, nwid, peers }) as MemberEntity;
const live = (extra = {}, observation = {}): LiveObservation => ({
	peers: new Map(),
	peersAvailable: true,
	statusAvailable: true,
	snapshot: {
		clock: 1000000,
		controllerStartedAt: 900000,
		onlineWindowMs: 120000,
		members: {
			[id]: {
				observed: true,
				online: true,
				lastSeen: 999000,
				lastOnline: 950000,
				...observation,
			},
		},
		...extra,
	},
});
const path = (address: string, extra = {}) => ({
	address,
	active: true,
	preferred: true,
	expired: false,
	...extra,
});

test("uses only the active preferred non-expired path and handles IPv6", () => {
	expect(
		determineConnectionStatus(
			member({
				paths: [path("192.168.1.8/9993", { expired: true }), path("203.0.113.8/9993")],
			}),
			true,
		),
	).toBe(S.DirectWAN);
	expect(determineConnectionStatus(member({ paths: [path("fd00::1/9993")] }), true)).toBe(
		S.DirectLAN,
	);
	expect(
		determineConnectionStatus(
			member({ latency: -1, versionMajor: -1, paths: [path("10.1.1.1/9993")] }),
			true,
		),
	).toBe(S.DirectLAN);
	expect(
		determineConnectionStatus(
			member({ paths: [path("10.1.1.1/9993", { active: false })] }),
			true,
		),
	).toBe(S.Relayed);
	expect(
		determineConnectionStatus(member({ paths: [path("10.1.1.1/9993")] }), false),
	).toBe(S.Offline);
	expect(determineConnectionStatus(member({ latency: -1 }))).toBe(S.Unknown);
});

test("IP assignment state is independent from direct/relay and includes generated IPv6", () => {
	const m = { authorized: false, ipAssignments: [], noAutoAssignIps: false };
	expect(memberIpState(m)).toBe("waitingAuthorization");
	m.authorized = true;
	expect(memberIpState(m, { v4AssignMode: { zt: true } })).toBe("waitingAssignment");
	expect(memberIpState(m, { v4AssignMode: { zt: false } })).toBe(
		"autoAssignmentDisabled",
	);
	m.noAutoAssignIps = true;
	expect(memberIpState(m, {})).toBe("manualAssignment");
	expect(memberIpState(m, { v6AssignMode: { rfc4193: true } } as never)).toBe("assigned");
});

test("page refresh never becomes last communication and initial import emits no online alert", () => {
	const db = row();
	const m = member();
	const data = observeMember(db, m, live());
	expect(data.lastSeen).toEqual(new Date(999000));
	expect(data.lastOnlineAt).toEqual(new Date(950000));
	expect(statusEventTypes(db, m, data)).toEqual([]);
	const persisted = { ...db, ...data };
	const next = observeMember(persisted, member(), live({ clock: 1010000 }));
	expect(next.lastSeen).toBeUndefined();
	expect(next.lastOnlineAt).toBeUndefined();
});

test("controller restart preserves online-since across multiple subsequent samples", () => {
	let db = row({
		online: true,
		lastSeen: new Date(800000),
		lastOnlineAt: new Date(700000),
		sourceLastOnlineAt: new Date(700000),
		observationControllerStartedAt: new Date(500000),
		statusObservedAt: new Date(810000),
	});
	let m = member();
	let data = observeMember(db, m, live());
	expect(m.lastOnlineAt ?? db.lastOnlineAt).toEqual(new Date(700000));
	db = { ...db, ...data };
	m = member();
	data = observeMember(db, m, live({ clock: 1010000 }, { lastSeen: 1005000 }));
	expect(data.lastOnlineAt).toBeUndefined();
	expect(statusEventTypes(db, m, data)).toEqual([]);
});

test("a source outage freezes persisted presence and produces unknown, never offline alerts", async () => {
	(zt.peers as jest.Mock).mockRejectedValue(new Error("unavailable"));
	(zt.member_status as jest.Mock).mockRejectedValue(new Error("unavailable"));
	const source = await readLiveObservation({} as never, nwid);
	const db = row({ online: true, statusObservedAt: new Date(800000) });
	const m = member();
	expect(observeMember(db, m, source)).toEqual({});
	expect(m.conStatus).toBe(S.Unknown);
	expect(statusEventTypes(db, m, {})).toEqual([]);
});

test("confirmed offline emits once; later online retains a distinct online transition", () => {
	const db = row({
		online: true,
		lastOnlineAt: new Date(700000),
		statusObservedAt: new Date(800000),
		connectionStatus: S.DirectWAN,
	});
	const m = member();
	const data = observeMember(
		db,
		m,
		live({ clock: 1200000 }, { online: false, lastSeen: 1000000 }),
	);
	expect(data.lastOfflineAt).toEqual(new Date(1120000));
	expect(statusEventTypes(db, m, data)).toEqual(["node.offline"]);
	const nextDb = { ...db, ...data };
	const next = member();
	const again = observeMember(
		nextDb,
		next,
		live({ clock: 1210000 }, { online: false, lastSeen: 1000000 }),
	);
	expect(statusEventTypes(nextDb, next, again)).toEqual([]);
});

test("relay changes must remain stable for 30 seconds before a notification", () => {
	let db = row({
		online: true,
		connectionStatus: S.DirectWAN,
		statusObservedAt: new Date(999000),
	});
	let m = member();
	let data = observeMember(db, m, live());
	expect(data.connectionStatus).toBeUndefined();
	expect(statusEventTypes(db, m, data)).toEqual([]);
	db = { ...db, ...data };
	m = member();
	data = observeMember(db, m, live({ clock: 1030000 }, { lastSeen: 1020000 }));
	expect(data.connectionStatus).toBe(S.Relayed);
	expect(statusEventTypes(db, m, data)).toEqual(["node.connection.changed"]);
});

test("unobserved nodes wait for a complete observation window; malformed clocks fail closed", () => {
	const m = member();
	expect(
		observeMember(
			row(),
			m,
			live({}, { observed: false, online: false, lastSeen: 0, lastOnline: 0 }),
		),
	).toEqual({});
	expect(m.conStatus).toBe(S.Unknown);
	expect(() => parseMemberStatus(live().snapshot)).not.toThrow();
	expect(() => parseMemberStatus(live({ clock: 1 }).snapshot)).toThrow();
});

test("newly added nodes notify their first online observation, upgraded rows only establish a baseline", () => {
	const db = row({ notifyOnFirstOnline: true });
	const m = member();
	const data = observeMember(db, m, live());
	expect(statusEventTypes(db, m, data)).toEqual(["node.online"]);
	expect(data.notifyOnFirstOnline).toBe(false);
});

test("a controller's own network member can be offline even while its API responds", () => {
	expect(
		determineConnectionStatus({ id: nwid.slice(0, 10), nwid, peers: {} }, false),
	).toBe(S.Offline);
});
