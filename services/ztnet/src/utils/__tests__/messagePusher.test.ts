import { describe, expect, it } from "@jest/globals";
import { validateMessagePusherUrl } from "~/utils/mail";

describe("Message Pusher configuration", () => {
	it("normalizes a self-hosted origin without changing its path", () => {
		expect(validateMessagePusherUrl("https://push.example.test/base///")).toBe(
			"https://push.example.test/base",
		);
		expect(validateMessagePusherUrl("http://message-pusher:3000")).toBe(
			"http://message-pusher:3000",
		);
	});

	it("rejects URLs that could hide credentials or a token in the URL", () => {
		expect(() => validateMessagePusherUrl("https://user:pass@push.example.test")).toThrow(
			"must not contain credentials",
		);
		expect(() => validateMessagePusherUrl("https://push.example.test/?token=secret")).toThrow(
			"must not contain credentials",
		);
		expect(() => validateMessagePusherUrl("ftp://push.example.test")).toThrow(
			"must use http or https",
		);
	});
});
