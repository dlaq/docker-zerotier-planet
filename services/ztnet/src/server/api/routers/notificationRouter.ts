import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminRoleProtectedRoute, createTRPCRouter } from "../trpc";
import {
	defaultNotificationTemplate,
	eventTypes,
	notificationTemplateSchema,
	notificationVariables,
	previewContext,
	renderNotificationText,
} from "~/utils/notificationTemplates";
import {
	destinationFingerprint,
	enqueueNotification,
} from "~/server/notifications/service";

export const notificationRouter = createTRPCRouter({
	templates: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const stored = await ctx.prisma.notificationTemplate.findMany();
		return {
			variables: notificationVariables,
			templates: eventTypes.map(
				(type) =>
					stored.find((t) => t.eventType === type) ?? defaultNotificationTemplate(type),
			),
		};
	}),
	saveTemplate: adminRoleProtectedRoute
		.input(notificationTemplateSchema)
		.mutation(async ({ ctx, input }) =>
			ctx.prisma.notificationTemplate.upsert({
				where: { eventType: input.eventType },
				create: input,
				update: {
					title: input.title,
					body: input.body,
					enabled: input.enabled,
					version: { increment: 1 },
				},
			}),
		),
	preview: adminRoleProtectedRoute
		.input(notificationTemplateSchema)
		.mutation(({ input }) => ({
			title: renderNotificationText(input.title, previewContext),
			body: renderNotificationText(input.body, previewContext),
		})),
	deliveries: adminRoleProtectedRoute.query(({ ctx }) =>
		ctx.prisma.notificationDelivery.findMany({
			take: 100,
			orderBy: { createdAt: "desc" },
			select: {
				id: true,
				eventType: true,
				title: true,
				body: true,
				status: true,
				attempts: true,
				lastError: true,
				createdAt: true,
				deliveredAt: true,
				templateVersion: true,
			},
		}),
	),
	test: adminRoleProtectedRoute.mutation(async ({ ctx }) => {
		const options = await ctx.prisma.globalOptions.findFirst({ where: { id: 1 } });
		if (!options?.messagePusherEnabled)
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "请先保存并启用 Message Pusher 渠道。",
			});
		await enqueueNotification("node.connection.changed", `test:${randomUUID()}`, {
			...previewContext,
			"actor.name": "管理员发送的测试通知",
		});
		return { queued: true };
	}),
	retry: adminRoleProtectedRoute
		.input(z.object({ id: z.string(), acknowledgePossibleDuplicate: z.literal(true) }))
		.mutation(async ({ ctx, input }) => {
			const options = await ctx.prisma.globalOptions.findFirst({ where: { id: 1 } });
			if (!options?.messagePusherEnabled)
				throw new TRPCError({ code: "BAD_REQUEST", message: "推送渠道尚未启用。" });
			const result = await ctx.prisma.notificationDelivery.updateMany({
				where: {
					id: input.id,
					status: { in: ["unknown", "failed"] },
					destinationFingerprint: destinationFingerprint(options),
				},
				data: { status: "pending", lastError: null },
			});
			if (!result.count)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "记录状态或目的地已经变化，无法重试。",
				});
			return { queued: true };
		}),
});
