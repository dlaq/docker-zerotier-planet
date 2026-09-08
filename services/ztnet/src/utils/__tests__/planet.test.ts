import { extractEndpointPorts } from "~/utils/planet";
import { parseWorldConfig } from "~/pages/api/mkworld/config";

describe("extractEndpointPorts", () => {
	it("deduplicates IPv4/IPv6 addresses that use the same port", () => {
		expect(extractEndpointPorts(["198.51.100.10/9993", "2001:db8::10/9993"])).toEqual([
			9993,
		]);
	});

	it("accepts two listener ports from a comma-separated endpoint", () => {
		expect(extractEndpointPorts(["198.51.100.10/9993,198.51.100.10/19993"])).toEqual([
			9993, 19993,
		]);
	});

	it.each(["198.51.100.10", "198.51.100.10/0", "198.51.100.10/65536"])(
		"rejects an invalid endpoint %s",
		(endpoint) => {
			expect(() => extractEndpointPorts([endpoint])).toThrow();
		},
	);

	it("rejects more than two unique ports", () => {
		expect(() =>
			extractEndpointPorts(["198.51.100.10/1,198.51.100.10/2,198.51.100.10/3"]),
		).toThrow();
	});
});

describe("parseWorldConfig", () => {
	const valid = {
		rootNodes: [{ identity: "root", endpoints: ["198.51.100.10/9993"] }],
	};

	it("rejects a non-recommended world without explicit ID and birth", () => {
		expect(() => parseWorldConfig({ ...valid, plRecommend: false })).toThrow(
			/plID and plBirth are required/,
		);
	});

	it("rejects malformed explicit planet metadata instead of silently defaulting", () => {
		expect(() => parseWorldConfig({ ...valid, plID: "149604618" })).toThrow(
			/plID must be an integer/,
		);
	});

	it("uses all root nodes when extracting listener ports", () => {
		const parsed = parseWorldConfig({
			...valid,
			rootNodes: [
				{ identity: "root-a", endpoints: ["198.51.100.10/9993"] },
				{ identity: "root-b", endpoints: ["198.51.100.11/19993"] },
			],
		});
		expect(parsed.portNumbers).toEqual([9993, 19993]);
	});
});
