import { createHash } from "node:crypto";
import axios from "axios";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "~/server/db";
import type { UserContext } from "~/types/ctx";
import {
	counterToString,
	parseRelayTelemetry,
	type RelayTelemetry,
} from "~/types/relayTelemetry";
import * as ztController from "~/utils/ztApi";

const BUCKET_MS = 5 * 60 * 1000;
const FLOW_RETENTION_MS = 24 * 60 * 60 * 1000;
const BUCKET_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const RELAY_TRAFFIC_WINDOWS = {
	"1h": 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
	all: null,
} as const;

export type RelayTrafficWindow = keyof typeof RELAY_TRAFFIC_WINDOWS;

type RelayTelemetryDb = Pick<
	PrismaClient,
	"relayTrafficBucket" | "relayFlowObservation" | "relaySessionObservation"
>;

export interface RelayTrafficSummary {
	bytesIn: string;
	bytesOut: string;
	bytesTotal: string;
	packetsIn: string;
	packetsOut: string;
	lastRelayedAt: number | null;
	confidence: "wire_observed" | null;
	byTransport: Record<
		string,
		{
			bytesIn: string;
			bytesOut: string;
			bytesTotal: string;
			packetsIn: string;
			packetsOut: string;
		}
	>;
}

const emptySummary = (): RelayTrafficSummary => ({
	bytesIn: "0",
	bytesOut: "0",
	bytesTotal: "0",
	packetsIn: "0",
	packetsOut: "0",
	lastRelayedAt: null,
	confidence: null,
	byTransport: {},
});

const add = (left: bigint, right: bigint): bigint => left + right;

const asBigInt = (value: unknown): bigint => {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
	if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
	return BigInt(0);
};

const dateFromMillis = (value: number): Date => {
	const now = Date.now();
	const safe =
		Number.isFinite(value) && value >= 0
			? Math.min(value, now + 24 * 60 * 60 * 1000)
			: now;
	return new Date(safe);
};

const bucketStart = (value: number): Date =>
	new Date(Math.floor(value / BUCKET_MS) * BUCKET_MS);

const externalObserverId = (url: string): string =>
	`relay-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;

const configuredRelayUrls = (): string[] => {
	const raw =
		process.env.ZT_RELAY_TELEMETRY_URLS || process.env.ZT_RELAY_TELEMETRY_URL || "";
	return raw
		.split(/[\s,]+/)
		.map((value) => value.trim())
		.filter((value) => {
			if (!value || value.length > 512) return false;
			try {
				const parsed = new URL(value);
				return parsed.protocol === "http:" || parsed.protocol === "https:";
			} catch {
				return false;
			}
		})
		.slice(0, 8);
};

const relayTelemetryHeaders = (): Record<string, string> => {
	const token = process.env.ZT_RELAY_TELEMETRY_TOKEN?.trim();
	return token
		? { Accept: "application/json", "X-Relay-Telemetry-Token": token }
		: { Accept: "application/json" };
};

const flowDelta = (current: bigint, previous: bigint | null): bigint =>
	previous === null || current < previous ? current : current - previous;

const persistSnapshot = async (
	snapshot: RelayTelemetry,
	fallbackObserverId: string,
): Promise<void> => {
	const observerId = snapshot.observerId || fallbackObserverId;
	const sampledAt = dateFromMillis(snapshot.clock);
	const now = new Date();
	await prisma.$transaction(async (db) => {
		await db.relayObserver.upsert({
			where: { observerId_bootId: { observerId, bootId: snapshot.bootId } },
			create: {
				observerId,
				bootId: snapshot.bootId,
				version: snapshot.version,
				confidence: snapshot.confidence,
				lastSeen: sampledAt,
			},
			update: {
				version: snapshot.version,
				confidence: snapshot.confidence,
				lastSeen: sampledAt,
			},
		});

		const currentBucket = bucketStart(snapshot.clock);
		for (const flow of snapshot.flows) {
			const sessionKey = "";
			const where = {
				observerId_bootId_sessionKey_sourceNodeId_destinationNodeId_transport: {
					observerId,
					bootId: snapshot.bootId,
					sessionKey,
					sourceNodeId: flow.sourceNodeId.toLowerCase(),
					destinationNodeId: flow.destinationNodeId.toLowerCase(),
					transport: flow.transport,
				},
			};
			const previous = await db.relayFlowObservation.findUnique({ where });
			const packets = asBigInt(flow.packets);
			const bytes = asBigInt(flow.bytes);
			const packetDelta = flowDelta(
				packets,
				previous ? asBigInt(previous.packets) : null,
			);
			const byteDelta = flowDelta(bytes, previous ? asBigInt(previous.bytes) : null);
			await db.relayFlowObservation.upsert({
				where,
				create: {
					observerId,
					bootId: snapshot.bootId,
					sessionKey,
					sourceNodeId: flow.sourceNodeId.toLowerCase(),
					destinationNodeId: flow.destinationNodeId.toLowerCase(),
					transport: flow.transport,
					firstSeen: dateFromMillis(flow.firstSeen),
					lastSeen: dateFromMillis(flow.lastSeen),
					active: flow.active,
					packets,
					bytes,
					sampledAt,
				},
				update: {
					firstSeen: dateFromMillis(flow.firstSeen),
					lastSeen: dateFromMillis(flow.lastSeen),
					active: flow.active,
					packets,
					bytes,
					sampledAt,
				},
			});
			if (packetDelta === BigInt(0) && byteDelta === BigInt(0)) continue;

			const sourceBucketWhere = {
				observerId_nodeId_transport_bucketStart: {
					observerId,
					nodeId: flow.sourceNodeId.toLowerCase(),
					transport: flow.transport,
					bucketStart: currentBucket,
				},
			};
			await db.relayTrafficBucket.upsert({
				where: sourceBucketWhere,
				create: {
					observerId,
					nodeId: flow.sourceNodeId.toLowerCase(),
					transport: flow.transport,
					bucketStart: currentBucket,
					bytesOut: byteDelta,
					packetsOut: packetDelta,
					sampledAt,
				},
				update: {
					bytesOut: { increment: byteDelta },
					packetsOut: { increment: packetDelta },
					sampledAt,
				},
			});
			const destinationBucketWhere = {
				observerId_nodeId_transport_bucketStart: {
					observerId,
					nodeId: flow.destinationNodeId.toLowerCase(),
					transport: flow.transport,
					bucketStart: currentBucket,
				},
			};
			await db.relayTrafficBucket.upsert({
				where: destinationBucketWhere,
				create: {
					observerId,
					nodeId: flow.destinationNodeId.toLowerCase(),
					transport: flow.transport,
					bucketStart: currentBucket,
					bytesIn: byteDelta,
					packetsIn: packetDelta,
					sampledAt,
				},
				update: {
					bytesIn: { increment: byteDelta },
					packetsIn: { increment: packetDelta },
					sampledAt,
				},
			});
		}

		for (const session of snapshot.sessions) {
			const sessionId = String(session.sessionId);
			const where = {
				observerId_bootId_sessionId: {
					observerId,
					bootId: snapshot.bootId,
					sessionId,
				},
			};
			await db.relaySessionObservation.upsert({
				where,
				create: {
					observerId,
					bootId: snapshot.bootId,
					sessionId,
					remoteAddress: session.remoteAddress,
					startedAt: dateFromMillis(session.startedAt),
					lastSeen: dateFromMillis(session.lastSeen),
					closedAt: session.closedAt === null ? null : dateFromMillis(session.closedAt),
					active: session.active,
					packetsToUdp: asBigInt(session.packetsToUdp),
					packetsToTcp: asBigInt(session.packetsToTcp),
					bytesToUdp: asBigInt(session.bytesToUdp),
					bytesToTcp: asBigInt(session.bytesToTcp),
					flowCount: session.flowCount,
					sampledAt,
				},
				update: {
					remoteAddress: session.remoteAddress,
					startedAt: dateFromMillis(session.startedAt),
					lastSeen: dateFromMillis(session.lastSeen),
					closedAt: session.closedAt === null ? null : dateFromMillis(session.closedAt),
					active: session.active,
					packetsToUdp: asBigInt(session.packetsToUdp),
					packetsToTcp: asBigInt(session.packetsToTcp),
					bytesToUdp: asBigInt(session.bytesToUdp),
					bytesToTcp: asBigInt(session.bytesToTcp),
					flowCount: session.flowCount,
					sampledAt,
				},
			});
		}
	});

	// Keep current flow/session detail bounded while retaining longer traffic
	// buckets for reporting. This runs after the atomic snapshot transaction.
	await Promise.all([
		prisma.relayFlowObservation.deleteMany({
			where: { sampledAt: { lt: new Date(now.getTime() - FLOW_RETENTION_MS) } },
		}),
		prisma.relaySessionObservation.deleteMany({
			where: { sampledAt: { lt: new Date(now.getTime() - FLOW_RETENTION_MS) } },
		}),
		prisma.relayTrafficBucket.deleteMany({
			where: { bucketStart: { lt: new Date(now.getTime() - BUCKET_RETENTION_MS) } },
		}),
	]);
};

let collectionInFlight: Promise<void> | null = null;

/** Collect all configured observers once per tick; concurrent UI/cron calls share it. */
export const collectRelayTelemetry = (ctx?: UserContext): Promise<void> => {
	if (collectionInFlight) return collectionInFlight;
	collectionInFlight = (async () => {
		const sources: Array<{ snapshot: RelayTelemetry; observerId: string }> = [];
		if (ctx) {
			try {
				const value = parseRelayTelemetry(await ztController.relay_telemetry(ctx));
				sources.push({
					snapshot: value,
					observerId: `controller-${value.observerId || "local"}`,
				});
			} catch (_error) {
				// Older Controller builds simply do not expose this endpoint.
			}
		}
		for (const url of configuredRelayUrls()) {
			try {
				const response = await axios.get(url, {
					timeout: 3000,
					responseType: "json",
					headers: relayTelemetryHeaders(),
				});
				const snapshot = parseRelayTelemetry(response.data);
				sources.push({ snapshot, observerId: externalObserverId(url) });
			} catch (_error) {
				// A down standby/relay must not make the member list unavailable.
			}
		}
		for (const source of sources)
			await persistSnapshot(source.snapshot, source.observerId);
	})().finally(() => {
		collectionInFlight = null;
	});
	return collectionInFlight;
};

const windowStart = (window: RelayTrafficWindow, now = Date.now()): Date | undefined => {
	const duration = RELAY_TRAFFIC_WINDOWS[window];
	return duration === null ? undefined : new Date(now - duration);
};

export const getRelayTrafficForMembers = async (
	_nwid: string,
	memberIds: string[],
	window: RelayTrafficWindow = "24h",
	db: RelayTelemetryDb = prisma,
): Promise<Map<string, RelayTrafficSummary>> => {
	const result = new Map(memberIds.map((id) => [id.toLowerCase(), emptySummary()]));
	if (memberIds.length === 0) return result;
	if (!db.relayTrafficBucket || !db.relayFlowObservation) return result;
	const start = windowStart(window);
	const where: Prisma.RelayTrafficBucketWhereInput = {
		nodeId: { in: memberIds.map((id) => id.toLowerCase()) },
		...(start ? { bucketStart: { gte: start } } : {}),
	};
	let rows: Awaited<ReturnType<typeof db.relayTrafficBucket.findMany>>;
	let latestFlows: Array<{
		sourceNodeId: string;
		destinationNodeId: string;
		lastSeen: Date;
	}>;
	try {
		[rows, latestFlows] = await Promise.all([
			db.relayTrafficBucket.findMany({ where }),
			db.relayFlowObservation.findMany({
				where: {
					OR: [
						{ sourceNodeId: { in: memberIds.map((id) => id.toLowerCase()) } },
						{ destinationNodeId: { in: memberIds.map((id) => id.toLowerCase()) } },
					],
					...(start ? { lastSeen: { gte: start } } : {}),
				},
				select: { sourceNodeId: true, destinationNodeId: true, lastSeen: true },
			}),
		]);
	} catch (_error) {
		// Relay telemetry is an optional observation plane. A missing migration,
		// unavailable database, or a down observer must not break the member list.
		return result;
	}
	for (const row of rows) {
		const summary = result.get(row.nodeId);
		if (!summary) continue;
		const transport = summary.byTransport[row.transport] || {
			bytesIn: "0",
			bytesOut: "0",
			bytesTotal: "0",
			packetsIn: "0",
			packetsOut: "0",
		};
		const bytesIn = add(BigInt(transport.bytesIn), asBigInt(row.bytesIn));
		const bytesOut = add(BigInt(transport.bytesOut), asBigInt(row.bytesOut));
		const packetsIn = add(BigInt(transport.packetsIn), asBigInt(row.packetsIn));
		const packetsOut = add(BigInt(transport.packetsOut), asBigInt(row.packetsOut));
		transport.bytesIn = counterToString(bytesIn);
		transport.bytesOut = counterToString(bytesOut);
		transport.bytesTotal = counterToString(bytesIn + bytesOut);
		transport.packetsIn = counterToString(packetsIn);
		transport.packetsOut = counterToString(packetsOut);
		summary.byTransport[row.transport] = transport;
		summary.bytesIn = counterToString(BigInt(summary.bytesIn) + asBigInt(row.bytesIn));
		summary.bytesOut = counterToString(BigInt(summary.bytesOut) + asBigInt(row.bytesOut));
		summary.bytesTotal = counterToString(
			BigInt(summary.bytesIn) + BigInt(summary.bytesOut),
		);
		summary.packetsIn = counterToString(
			BigInt(summary.packetsIn) + asBigInt(row.packetsIn),
		);
		summary.packetsOut = counterToString(
			BigInt(summary.packetsOut) + asBigInt(row.packetsOut),
		);
		summary.confidence = "wire_observed";
	}
	for (const flow of latestFlows) {
		for (const id of [flow.sourceNodeId, flow.destinationNodeId]) {
			const summary = result.get(id);
			if (!summary) continue;
			const timestamp = flow.lastSeen.getTime();
			if (summary.lastRelayedAt === null || timestamp > summary.lastRelayedAt)
				summary.lastRelayedAt = timestamp;
			summary.confidence = "wire_observed";
		}
	}
	return result;
};

export const getRelaySessions = async (
	memberIds: string[],
	window: RelayTrafficWindow = "24h",
	active?: boolean,
	db: RelayTelemetryDb = prisma,
) => {
	if (!db.relayFlowObservation || !db.relaySessionObservation) return [];
	try {
		const start = windowStart(window);
		const normalizedMemberIds = memberIds.map((id) => id.toLowerCase());
		const observers =
			normalizedMemberIds.length === 0
				? []
				: await db.relayFlowObservation.findMany({
						where: {
							OR: [
								{ sourceNodeId: { in: normalizedMemberIds } },
								{ destinationNodeId: { in: normalizedMemberIds } },
							],
						},
						select: { observerId: true },
						distinct: ["observerId"],
					});
		const observerIds = observers.map((observer) => observer.observerId);
		if (observerIds.length === 0) return [];
		const rows = await db.relaySessionObservation.findMany({
			where: {
				observerId: { in: observerIds },
				...(start ? { lastSeen: { gte: start } } : {}),
				...(active === undefined ? {} : { active }),
			},
			orderBy: { lastSeen: "desc" },
			take: 4096,
		});
		return rows.map((row) => ({
			...row,
			packetsToUdp: asBigInt(row.packetsToUdp).toString(),
			packetsToTcp: asBigInt(row.packetsToTcp).toString(),
			bytesToUdp: asBigInt(row.bytesToUdp).toString(),
			bytesToTcp: asBigInt(row.bytesToTcp).toString(),
			confidence: "wire_observed" as const,
		}));
	} catch (_error) {
		// Keep the optional sessions view available while the telemetry schema is
		// being migrated or when the database is temporarily unavailable.
		return [];
	}
};
