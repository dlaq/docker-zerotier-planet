import { z } from "zod";

export const eventLabels = {
	"node.added": "节点新增",
	"node.online": "节点上线",
	"node.offline": "节点离线",
	"node.connection.changed": "连接状态改变",
	"node.authorized": "节点已授权",
	"node.deauthorized": "节点取消授权",
	"node.config.changed": "节点配置改变",
	"node.removed": "节点移除",
	"user.login.succeeded": "用户登录",
	"user.password.changed": "用户修改密码",
	"user.password.reset_completed": "密码重置完成",
} as const;
export type NotificationEventType = keyof typeof eventLabels;
export const eventTypes = Object.keys(eventLabels) as [
	NotificationEventType,
	...NotificationEventType[],
];
export const notificationVariables = [
	"event.id",
	"event.type",
	"event.time",
	"network.id",
	"network.name",
	"node.id",
	"node.name",
	"node.ips",
	"node.physicalAddress",
	"node.version",
	"node.authorized",
	"node.lastOnline",
	"node.lastSeen",
	"node.duration",
	"change.before",
	"change.after",
	"user.name",
	"user.email",
	"user.ip",
	"user.device",
	"actor.name",
	"action.suggestion",
	"action.url",
] as const;
export type NotificationContext = Partial<
	Record<(typeof notificationVariables)[number], string>
>;
const allowed = new Set<string>(notificationVariables);
export function validateNotificationText(value: string) {
	if (/<%|%>/.test(value)) throw new Error("模板只支持 {{变量}}，不支持可执行代码");
	const remainder = value.replace(
		/\{\{\s*([a-zA-Z][a-zA-Z0-9.]*)\s*\}\}/g,
		(_match, key: string) => {
			if (!allowed.has(key)) throw new Error(`不支持的模板变量：${key}`);
			return "";
		},
	);
	if (remainder.includes("{{") || remainder.includes("}}"))
		throw new Error("模板变量格式错误");
}
const safeText = (limit: number) =>
	z
		.string()
		.min(1)
		.max(limit)
		.superRefine((value, ctx) => {
			try {
				validateNotificationText(value);
			} catch (error) {
				ctx.addIssue({ code: "custom", message: (error as Error).message });
			}
		});
export const notificationTemplateSchema = z.object({
	eventType: z.enum(eventTypes),
	title: safeText(200),
	body: safeText(8000),
	enabled: z.boolean(),
});
export function renderNotificationText(
	template: string,
	context: NotificationContext,
): string {
	validateNotificationText(template);
	// A callback replacement is intentional: dollar signs in user names are text.
	return template.replace(
		/\{\{\s*([a-zA-Z][a-zA-Z0-9.]*)\s*\}\}/g,
		(_match, key: keyof NotificationContext) =>
			(context[key] || "未知 / 未采集")
				.replace(/[\u0000-\u001f\u007f]/g, "")
				.slice(0, 512),
	);
}
export function defaultNotificationTemplate(eventType: NotificationEventType) {
	const node = eventType.startsWith("node.");
	return {
		eventType,
		enabled: true,
		version: 1,
		title: `【${eventLabels[eventType]}】${node ? "{{node.name}}｜{{network.name}}" : "{{user.name}}"}`,
		body: node
			? "网络：{{network.name}} / {{network.id}}\n节点：{{node.name}} / {{node.id}}\n分配 IP：{{node.ips}}\n物理地址：{{node.physicalAddress}}\n客户端版本：{{node.version}}\n授权状态：{{node.authorized}}\n变化：{{change.before}} → {{change.after}}\n最近上线：{{node.lastOnline}}\n最后通信：{{node.lastSeen}}\n上一状态持续：{{node.duration}}\n操作 / 来源：{{actor.name}}\n建议：{{action.suggestion}}\n时间：{{event.time}}\n详情：{{action.url}}\n事件编号：{{event.id}}"
			: "账号：{{user.name}}（{{user.email}}）\n操作：{{event.type}}\n来源 IP：{{user.ip}}\n设备 / 浏览器：{{user.device}}\n操作人：{{actor.name}}\n结果：{{change.after}}\n建议：{{action.suggestion}}\n时间：{{event.time}}\n账号管理：{{action.url}}\n事件编号：{{event.id}}",
	};
}
export const previewContext: NotificationContext = {
	"event.id": "preview-only",
	"event.type": "模板预览",
	"event.time": "2026-09-12 20:00:00 Asia/Shanghai",
	"network.id": "a1b2c3d4e5000001",
	"network.name": "演示网络",
	"node.id": "1234567890",
	"node.name": "家庭 NAS",
	"node.ips": "10.20.0.5",
	"node.physicalAddress": "203.0.113.20/9993",
	"node.version": "1.16.2",
	"node.authorized": "已授权",
	"node.lastOnline": "2026-09-12 18:00:00 Asia/Shanghai",
	"node.lastSeen": "2026-09-12 19:59:00 Asia/Shanghai",
	"node.duration": "2 小时",
	"change.before": "直联（公网）",
	"change.after": "中转",
	"user.name": "演示用户",
	"user.email": "demo@example.test",
	"user.ip": "192.0.2.10",
	"user.device": "演示浏览器",
	"actor.name": "后台观测",
	"action.suggestion": "检查客户端 UDP、防火墙及 NAT 状态。",
	"action.url": "https://example.test/network/demo",
};
