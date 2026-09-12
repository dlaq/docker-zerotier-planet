jest.mock("~/utils/encryption", () => ({
	decrypt: jest.fn(() => "test-token"),
	generateInstanceSecret: jest.fn(() => "test-key"),
	MESSAGE_PUSHER_SECRET: "pusher",
	SMTP_SECRET: "smtp",
}));
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
const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});
test.each([
	JSON.stringify({ success: false }),
	JSON.stringify({ success: "true" }),
	"not-json",
	"x".repeat(65537),
])("HTTP 200 is insufficient when gateway result is invalid: %#", async (body) => {
	global.fetch = jest.fn().mockResolvedValue(new Response(body)) as never;
	await expect(
		sendMessagePusher(options, { title: "test", content: "body" }),
	).rejects.toThrow();
});
test("requires explicit success and sends synchronously without secret-bearing links", async () => {
	global.fetch = jest
		.fn()
		.mockResolvedValue(
			new Response(JSON.stringify({ success: true, uuid: "test" })),
		) as never;
	await expect(
		sendMessagePusher(options, { title: "test", content: "body" }),
	).resolves.toBeUndefined();
	const [url, request] = (global.fetch as jest.Mock).mock.calls[0];
	expect(String(url)).toBe("http://message-pusher:3000/push/ops");
	expect(JSON.parse(request.body)).toMatchObject({
		async: false,
		description: "body",
		render_mode: "raw",
		channel: "ops-channel",
	});
	expect(request.redirect).toBe("error");
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
