import { createHash, randomUUID } from "node:crypto";
import { prisma } from "~/server/db";
import type { GlobalOptions, Prisma, network_members } from "@prisma/client";
import type { MemberEntity } from "~/types/local/member";
import {
	defaultNotificationTemplate,
	eventLabels,
	renderNotificationText,
	type NotificationContext,
	type NotificationEventType,
} from "~/utils/notificationTemplates";
import { sendMessagePusher } from "~/utils/mail";
import { ConnectionStatus } from "~/utils/memberConnection";

type DB = Pick<
	Prisma.TransactionClient,
	"globalOptions" | "notificationTemplate" | "notificationDelivery"
>;
export function destinationFingerprint(options: GlobalOptions) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				options.messagePusherUrl,
				options.messagePusherUsername,
				options.messagePusherChannel,
			]),
		)
		.digest("hex");
}
const dateText = (value?: Date | number | string | null) =>
	value && Number.isFinite(new Date(value).getTime())
		? new Date(value).toISOString()
		: "尚无可靠记录";
export async function enqueueNotification(
	eventType: NotificationEventType,
	eventKey: string,
	context: NotificationContext,
	db: DB = prisma,
) {
	const options = await db.globalOptions.findFirst({ where: { id: 1 } });
	if (!options?.messagePusherEnabled) return;
	const template =
		(await db.notificationTemplate.findUnique({ where: { eventType } })) ??
		defaultNotificationTemplate(eventType);
	if (!template.enabled) return;
	const id = randomUUID();
	const safe = {
		...context,
		"event.id": id,
		"event.type": eventLabels[eventType],
		"event.time": dateText(new Date()),
	};
	await db.notificationDelivery.createMany({
		skipDuplicates: true,
		data: [
			{
				id,
				eventKey,
				eventType,
				title: renderNotificationText(template.title, safe).slice(0, 512),
				body: renderNotificationText(template.body, safe).slice(0, 32768),
				templateVersion: template.version,
				destinationFingerprint: destinationFingerprint(options),
			},
		],
	});
}

const states: Record<number, string> = {
	0: "离线",
	1: "中转",
	2: "直联（内网）",
	3: "直联（公网）",
	4: "控制器",
	5: "未知",
};
export function memberConfigSummary(
	member: Partial<MemberEntity> | network_members,
): string {
	return `名称=${member.name || member.id}，描述=${member.description || "空"}，授权=${!!member.authorized}，IP=${member.ipAssignments?.join(", ") || "未分配"}，自动分配=${!member.noAutoAssignIps}，网桥=${!!member.activeBridge}`;
}

export function nodeEventContext(
	member: MemberEntity,
	networkName: string | null,
	before?: string,
	after?: string,
): NotificationContext {
	const start = member.online ? member.lastOfflineAt : member.lastOnlineAt;
	const elapsed = start ? Math.max(0, Date.now() - new Date(start).getTime()) : NaN;
	return {
		"network.id": member.nwid,
		"network.name": networkName || member.nwid,
		"node.id": member.id,
		"node.name": member.name || member.id,
		"node.ips": member.ipAssignments?.join(", ") || "未分配",
		"node.authorized": member.authorized ? "已授权" : "等待授权",
		"node.physicalAddress": member.physicalAddress || "未采集",
		"node.version":
			member.vMajor >= 0 ? `${member.vMajor}.${member.vMinor}.${member.vRev}` : "未知",
		"node.lastOnline": dateText(member.lastOnlineAt),
		"node.lastSeen": dateText(member.lastSeen),
		"node.duration": Number.isFinite(elapsed)
			? `${Math.floor(elapsed / 1000)} 秒（按观测时间）`
			: "尚无可靠记录",
		"change.before": before || "未知",
		"change.after": after || states[member.conStatus] || "未知",
		"actor.name": "后台观测（Controller → 节点）",
		"action.suggestion": !member.authorized
			? "确认设备归属后授权。"
			: member.conStatus === ConnectionStatus.Offline
				? "检查设备供电、ZeroTier 服务和外网连接。"
				: member.conStatus === ConnectionStatus.Relayed
					? "检查 UDP、防火墙和 NAT；中转可能增加延迟。"
					: "如不符合预期，请核对节点配置。",
		"action.url": `${process.env.NEXTAUTH_URL || ""}/network/${member.nwid}`,
	};
}

export function statusEventTypes(
	db: network_members,
	member: MemberEntity,
	data: Partial<network_members>,
): NotificationEventType[] {
	if (member.online === undefined) return [];
	if (!db.statusObservedAt)
		return db.notifyOnFirstOnline && member.online ? ["node.online"] : [];
	if (db.online !== member.online)
		return [member.online ? "node.online" : "node.offline"];
	if (
		member.online &&
		data.connectionStatus != null &&
		db.connectionStatus != null &&
		data.connectionStatus !== db.connectionStatus &&
		data.connectionStatus !== ConnectionStatus.Unknown
	)
		return ["node.connection.changed"];
	return [];
}

export async function persistObservedMember(
	db: network_members,
	member: MemberEntity,
	data: Partial<network_members>,
) {
	const events = statusEventTypes(db, member, data);
	if (!events.length)
		return prisma.network_members.updateMany({
			where: { nwid: db.nwid, id: db.id },
			data,
		});
	return prisma.$transaction(async (tx) => {
		// Compare the observed revision so simultaneous pollers cannot emit the same
		// transition twice. The next cycle reconciles a losing writer.
		const changed = await tx.network_members.updateMany({
			where: { nwid: db.nwid, id: db.id, statusObservedAt: db.statusObservedAt },
			data,
		});
		if (!changed.count) return;
		const network = await tx.network.findUnique({
			where: { nwid: db.nwid },
			select: { name: true },
		});
		for (const type of events)
			await enqueueNotification(
				type,
				`${type}:${db.nwid}:${db.id}:${dateText(data.statusObservedAt)}`,
				nodeEventContext(member, network?.name, states[db.connectionStatus] || "未知"),
				tx,
			);
	});
}

export async function accountNotification(
	type: NotificationEventType,
	user: { id: string; name?: string | null; email?: string | null },
	details: {
		key?: string;
		ip?: string;
		device?: string;
		actor?: string;
		result?: string;
	} = {},
	db: DB = prisma,
) {
	return enqueueNotification(
		type,
		`${type}:${details.key || randomUUID()}`,
		{
			"user.name": user.name || user.id,
			"user.email": user.email || "未设置",
			"user.ip": details.ip || "未采集",
			"user.device": details.device || "未采集",
			"actor.name": details.actor || user.name || user.id,
			"change.after": details.result || "操作成功",
			"action.suggestion":
				type === "user.login.succeeded"
					? "若非本人登录，请修改密码并检查登录设备。"
					: "若非本人操作，请立即检查账号和登录会话。",
			"action.url": `${process.env.NEXTAUTH_URL || ""}/user-settings/?tab=account`,
		},
		db,
	);
}

/** One dispatch attempt. Upstream has no idempotency guarantee: interrupted
 * attempts become unknown and require explicit manual retry, not blind resend. */
export async function recordLoginSession(id: string) {
	return prisma.$transaction(async (tx) => {
		const session = await tx.session.findFirst({
			where: { id, notificationRecordedAt: null },
			include: { user: { select: { id: true, name: true, email: true } } },
		});
		if (!session) return;
		await accountNotification(
			"user.login.succeeded",
			session.user,
			{
				key: session.id,
				ip: session.ipAddress || undefined,
				device: session.userAgent || undefined,
			},
			tx,
		);
		await tx.session.updateMany({
			where: { id, notificationRecordedAt: null },
			data: { notificationRecordedAt: new Date() },
		});
	});
}

export async function drainNotifications() {
	// A committed Session is the durable login event source. Recover an after-hook
	// interruption after restart without replaying pre-migration sessions.
	const sessions = await prisma.session.findMany({
		where: { notificationRecordedAt: null },
		orderBy: { createdAt: "asc" },
		take: 100,
		select: { id: true },
	});
	for (const session of sessions) await recordLoginSession(session.id);
	await prisma.notificationDelivery.updateMany({
		where: { status: "pending", createdAt: { lt: new Date(Date.now() - 86400000) } },
		data: { status: "cancelled", lastError: "事件已超过 24 小时，停止发送过期提醒。" },
	});
	const options = await prisma.globalOptions.findFirst({ where: { id: 1 } });
	await prisma.notificationDelivery.updateMany({
		where: { status: "sending", updatedAt: { lt: new Date(Date.now() - 120000) } },
		data: {
			status: "unknown",
			lastError: "发送进程中断，投递结果未知；请先检查目标渠道。",
		},
	});
	if (!options?.messagePusherEnabled) return;
	const jobs = await prisma.notificationDelivery.findMany({
		where: { status: "pending" },
		orderBy: { createdAt: "asc" },
		take: 10,
	});
	for (const job of jobs) {
		const claim = await prisma.notificationDelivery.updateMany({
			where: { id: job.id, status: "pending" },
			data: { status: "sending", attempts: { increment: 1 } },
		});
		if (!claim.count) continue;
		if (job.destinationFingerprint !== destinationFingerprint(options)) {
			await prisma.notificationDelivery.update({
				where: { id: job.id },
				data: { status: "cancelled", lastError: "推送目的地已改变，请重新生成事件。" },
			});
			continue;
		}
		try {
			await sendMessagePusher(options, { title: job.title, content: job.body });
			await prisma.notificationDelivery.update({
				where: { id: job.id },
				data: { status: "sent", deliveredAt: new Date(), lastError: null },
			});
		} catch (_error) {
			// Never persist arbitrary upstream response text, URLs or credential echoes.
			await prisma.notificationDelivery.update({
				where: { id: job.id },
				data: {
					status: "unknown",
					lastError: "网关未确认投递成功。请检查目标渠道和网关，再决定是否重试。",
				},
			});
		}
	}
	await prisma.notificationDelivery.deleteMany({
		where: {
			createdAt: { lt: new Date(Date.now() - 30 * 86400000) },
			status: { notIn: ["pending", "sending"] },
		},
	});
}
let started = false;
export function startNotificationWorker() {
	if (started) return;
	started = true;
	const tick = async () => {
		try {
			await drainNotifications();
		} catch (_error) {
			console.error("Notification outbox temporarily unavailable");
		}
		setTimeout(tick, 5000).unref();
	};
	setTimeout(tick, 5000).unref();
}

export async function recordMemberAction(
	db: Prisma.TransactionClient,
	eventType: NotificationEventType,
	member: MemberEntity,
	eventKey: string,
	actor: string,
	before: string,
	after: string,
) {
	const network = await db.network.findUnique({
		where: { nwid: member.nwid },
		select: { name: true },
	});
	await enqueueNotification(
		eventType,
		eventKey,
		{ ...nodeEventContext(member, network?.name, before, after), "actor.name": actor },
		db,
	);
}
