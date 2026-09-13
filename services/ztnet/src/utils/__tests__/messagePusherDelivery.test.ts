jest.mock("~/utils/encryption", () => ({
	decrypt: jest.fn(() => "test-token"),
	generateInstanceSecret: jest.fn(() => "test-key"),
	MESSAGE_PUSHER_SECRET: "pusher",
	SMTP_SECRET: "smtp",
}));
import axios from "axios";
import { sendMessagePusher, sendMailWithTemplate } from "~/utils/mail";
import { MailTemplateKey } from "~/utils/enums";
import { prisma } from "~/server/db";
const options = {
	messagePusherEnabled: true,
	messagePusherUrl: "http://message-pusher:3000",
	messagePusherUsername: "ops",
	messagePusherToken: "encrypted",
	messagePusherChannel: "ops-channel",
} as never;
const originalPost = axios.post;
const originalProxy = process.env.ZTPLANET_MESSAGE_PUSHER_PROXY;
afterEach(() => {
	axios.post = originalPost;
	if (originalProxy === undefined)
		Reflect.deleteProperty(process.env, "ZTPLANET_MESSAGE_PUSHER_PROXY");
	else process.env.ZTPLANET_MESSAGE_PUSHER_PROXY = originalProxy;
});
test.each([
	{ status: 200, data: { success: false } },
	{ status: 200, data: { success: "true" } },
	{ status: 200, data: "not-json" },
	{ status: 200, data: "x".repeat(65537) },
])("HTTP 200 is insufficient when gateway result is invalid: %#", async (response) => {
	axios.post = jest.fn().mockResolvedValue(response) as never;
	await expect(
		sendMessagePusher(options, { title: "test", content: "body" }),
	).rejects.toThrow();
});
test("requires explicit success and sends synchronously without secret-bearing links", async () => {
	axios.post = jest.fn().mockResolvedValue({
		status: 200,
		data: { success: true, uuid: "test" },
	}) as never;
	await expect(
		sendMessagePusher(options, { title: "test", content: "body" }),
	).resolves.toBeUndefined();
	const [url, body, request] = (axios.post as jest.Mock).mock.calls[0];
	expect(String(url)).toBe("http://message-pusher:3000/push/ops");
	expect(body).toMatchObject({
		async: false,
		description: "body",
		content: "body",
		render_mode: "raw",
		channel: "ops-channel",
	});
	expect(request).toMatchObject({
		maxRedirects: 0,
		proxy: false,
	});
});
test("uses the explicitly configured egress proxy without exposing it in the URL", async () => {
	process.env.ZTPLANET_MESSAGE_PUSHER_PROXY = "http://proxy.example.test:8080";
	axios.post = jest
		.fn()
		.mockResolvedValue({ status: 200, data: { success: true } }) as never;
	await expect(
		sendMessagePusher(options, { title: "test", content: "body" }),
	).resolves.toBeUndefined();
	const request = (axios.post as jest.Mock).mock.calls[0][2];
	expect(request.proxy).toMatchObject({
		protocol: "http",
		host: "proxy.example.test",
		port: 8080,
	});
});
test("rejects a proxy URL with a path or query string", async () => {
	process.env.ZTPLANET_MESSAGE_PUSHER_PROXY =
		"http://proxy.example.test:8080/path?secret=1";
	await expect(
		sendMessagePusher(options, { title: "test", content: "body" }),
	).rejects.toThrow("proxy origin without a path");
});
test("password reset never falls through to the administrator's global push channel", async () => {
	prisma.globalOptions.findFirst = jest
		.fn()
		.mockResolvedValue({ ...(options as object), id: 1 });
	global.fetch = jest.fn() as never;
	await expect(
		sendMailWithTemplate(MailTemplateKey.ForgotPassword, {
			to: "user@example.test",
			templateData: {
				toEmail: "user@example.test",
				forgotLink: "https://example.test/reset?token=private",
			},
			sendInBackground: false,
		}),
	).rejects.toThrow("SMTP is required");
	expect(global.fetch).not.toHaveBeenCalled();
});
