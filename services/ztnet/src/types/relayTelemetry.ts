import { z } from "zod";

const nodeId = z.string().regex(/^[0-9a-f]{10}$/i);
const counter = z
	.union([
		z.string().regex(/^\d+$/),
		z
			.number()
			.int()
			.nonnegative()
			.transform((value) => String(value)),
	])
	.transform((value) => BigInt(value));
const timestamp = z.number().int().nonnegative().max(8640000000000000);

export const relayFlowSchema = z.object({
	sourceNodeId: nodeId,
	destinationNodeId: nodeId,
	transport: z.string().min(1).max(32),
	packets: counter,
	bytes: counter,
	firstSeen: timestamp,
	lastSeen: timestamp,
	active: z.boolean(),
});

export const relayClientSchema = z.object({
	nodeId,
	packetsIn: counter,
	packetsOut: counter,
	bytesIn: counter,
	bytesOut: counter,
	bytesTotal: counter,
	lastRelayedAt: timestamp,
});

export const relaySessionSchema = z.object({
	sessionId: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
	remoteAddress: z.string().max(128),
	startedAt: timestamp,
	lastSeen: timestamp,
	closedAt: timestamp.nullable(),
	active: z.boolean(),
	packetsToUdp: counter,
	packetsToTcp: counter,
	bytesToUdp: counter,
	bytesToTcp: counter,
	flowCount: z.number().int().nonnegative(),
});

export const relayTelemetrySchema = z.object({
	version: z.number().int().positive(),
	observerId: nodeId.nullable(),
	bootId: z.string().min(1).max(128),
	clock: timestamp,
	confidence: z.literal("wire_observed"),
	networkId: z
		.string()
		.regex(/^[0-9a-f]{16}$/i)
		.nullable(),
	transport: z.string().min(1).max(32),
	flows: z.array(relayFlowSchema).max(8192),
	clients: z.array(relayClientSchema).max(8192),
	sessions: z.array(relaySessionSchema).max(4096),
	unattributed: z.object({ packets: counter, bytes: counter }),
	droppedFlows: counter,
});

export type RelayTelemetry = z.infer<typeof relayTelemetrySchema>;
export type RelayFlow = z.infer<typeof relayFlowSchema>;
export type RelaySession = z.infer<typeof relaySessionSchema>;

export const parseRelayTelemetry = (value: unknown): RelayTelemetry =>
	relayTelemetrySchema.parse(value);

export const counterToString = (value: bigint): string => value.toString(10);
