import {
	MEMBER_FILTER_VALUES,
	memberIsOnline,
	matchesMemberFilter,
} from "~/utils/memberFilter";
import { ConnectionStatus } from "~/utils/memberConnection";

const now = Date.parse("2026-09-14T00:00:00.000Z");
const minute = 60 * 1000;
const hour = 60 * 60 * 1000;
const day = 24 * hour;

const member = (overrides: Record<string, unknown> = {}) => ({
	online: false,
	lastSeen: null,
	lastOnlineAt: null,
	lastOfflineAt: null,
	authorized: true,
	conStatus: ConnectionStatus.Unknown,
	...overrides,
});

describe("member filters", () => {
	test("exposes current status, activity windows, authorization and connection filters", () => {
		expect(MEMBER_FILTER_VALUES).toEqual(
			expect.arrayContaining([
				"online",
				"online_24h",
				"online_7d",
				"seen_24h",
				"authorized",
				"direct_lan",
			]),
		);
	});

	test("includes an online member in every recent-online window", () => {
		const online = member({
			online: true,
			lastOnlineAt: new Date(now - 30 * day),
		});
		expect(memberIsOnline(online, now)).toBe(true);
		expect(matchesMemberFilter(online, "online", now)).toBe(true);
		expect(matchesMemberFilter(online, "online_24h", now)).toBe(true);
	});

	test("matches an offline member by the start of its last online period", () => {
		const recentlyOffline = member({
			lastOnlineAt: new Date(now - 6 * hour),
			lastSeen: new Date(now - 6 * hour),
		});
		expect(matchesMemberFilter(recentlyOffline, "online_24h", now)).toBe(true);
		expect(matchesMemberFilter(recentlyOffline, "online_1h", now)).toBe(false);
		expect(matchesMemberFilter(recentlyOffline, "seen_24h", now)).toBe(true);
	});

	test("matches a long online period that ended inside the selected window", () => {
		const endedRecently = member({
			lastOnlineAt: new Date(now - 3 * day),
			lastOfflineAt: new Date(now - 2 * hour),
		});
		expect(matchesMemberFilter(endedRecently, "online_24h", now)).toBe(true);
	});

	test("distinguishes never observed members and connection modes", () => {
		const neverObserved = member();
		expect(matchesMemberFilter(neverObserved, "never_online", now)).toBe(true);
		expect(matchesMemberFilter(neverObserved, "never_seen", now)).toBe(true);
		expect(matchesMemberFilter(neverObserved, "offline", now)).toBe(true);
		expect(
			matchesMemberFilter(
				member({ conStatus: ConnectionStatus.DirectLAN }),
				"direct_lan",
				now,
			),
		).toBe(true);
		expect(
			matchesMemberFilter(
				member({ conStatus: ConnectionStatus.Relayed }),
				"direct_lan",
				now,
			),
		).toBe(false);
	});

	test("uses a recent lastSeen heartbeat for hosted members without online", () => {
		const hostedOnline = member({
			online: undefined,
			lastSeen: new Date(now - 2 * minute),
		});
		expect(memberIsOnline(hostedOnline, now)).toBe(true);
		expect(matchesMemberFilter(hostedOnline, "online", now)).toBe(true);
		expect(matchesMemberFilter(hostedOnline, "seen_15m", now)).toBe(true);
	});
});
