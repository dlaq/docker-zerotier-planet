import { notificationDeliveryError } from "~/server/notifications/service";

test("maps network failures to an actionable, credential-free message", () => {
	expect(notificationDeliveryError(new Error("Message Pusher request failed"))).toContain(
		"出站 TCP/443",
	);
});

test("maps gateway responses without storing upstream response text", () => {
	expect(notificationDeliveryError(new Error("Message Pusher returned HTTP 401"))).toBe(
		"Message Pusher 网关返回 HTTP 401，未确认投递。",
	);
});

test("keeps unknown errors generic", () => {
	expect(notificationDeliveryError(new Error("token=secret"))).toBe(
		"网关未确认投递成功。请检查目标渠道和网关，再决定是否重试。",
	);
});
