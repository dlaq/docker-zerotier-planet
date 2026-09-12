import {
	defaultNotificationTemplate,
	eventTypes,
	notificationTemplateSchema,
	renderNotificationText,
	previewContext,
} from "~/utils/notificationTemplates";

test("all event defaults render useful text with no unresolved variables", () => {
	for (const type of eventTypes) {
		const template = defaultNotificationTemplate(type);
		expect(notificationTemplateSchema.safeParse(template).success).toBe(true);
		const body = renderNotificationText(template.body, previewContext);
		expect(body).not.toContain("{{");
		expect(body).toContain("preview-only");
	}
});
test("templates cannot access secrets, prototype properties or execute EJS", () => {
	for (const text of [
		"{{user.password}}",
		"{{constructor.constructor}}",
		"{{__proto__.x}}",
		"{{user.name",
		"<% process.exit() %>",
	])
		expect(() => renderNotificationText(text, {})).toThrow();
});
test("untrusted names are literal strings and cannot inject variables or body lines", () => {
	expect(
		renderNotificationText("节点：{{node.name}}", {
			"node.name": "$& {{user.email}}\n伪造：成功",
		}),
	).toBe("节点：$& {{user.email}}伪造：成功");
});
