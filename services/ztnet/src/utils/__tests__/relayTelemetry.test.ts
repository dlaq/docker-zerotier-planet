import { parseRelayTelemetry } from "~/types/relayTelemetry";

const validSnapshot = {
	version: 1,
	observerId: null,
	bootId: "42",
	clock: 1_700_000_000_000,
	confidence: "wire_observed",
	networkId: null,
	transport: "tcp_relay",
	flows: [
		{
			sourceNodeId: "0123456789",
			destinationNodeId: "abcdef0123",
			transport: "tcp_relay",
			packets: "18446744073709551615",
			bytes: "9007199254740993",
			firstSeen: 1_700_000_000_000,
			lastSeen: 1_700_000_000_001,
			active: true,
		},
	],
	clients: [],
	sessions: [],
	unattributed: { packets: "0", bytes: "0" },
	droppedFlows: "0",
};

describe("relay telemetry parser", () => {
	it("keeps counters as bigint so large values are lossless", () => {
		const parsed = parseRelayTelemetry(validSnapshot);
		expect(parsed.flows[0]?.bytes).toBe(BigInt("9007199254740993"));
		expect(parsed.flows[0]?.packets).toBe(BigInt("18446744073709551615"));
	});

	it("rejects unauthenticated or ambiguous wire data", () => {
		expect(() =>
			parseRelayTelemetry({ ...validSnapshot, confidence: "authenticated" }),
		).toThrow();
		expect(() =>
			parseRelayTelemetry({
				...validSnapshot,
				flows: [{ ...validSnapshot.flows[0], sourceNodeId: "not-a-node" }],
			}),
		).toThrow();
	});
});
