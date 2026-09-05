import { TRPCError } from "@trpc/server";
import { compare } from "bcryptjs";
import { z } from "zod";
import { createTRPCRouter, adminRoleProtectedRoute } from "~/server/api/trpc";
import { callAgent } from "~/server/system/agentClient";

const listenerSchema = z
	.object({
		address: z.string().min(2).max(64),
		port: z.number().int().min(1).max(65535),
		tlsMode: z.enum(["off", "self-signed", "files"]),
		allowedCidrs: z.array(z.string().min(3).max(64)).max(64),
	})
	.strict();

const systemConfigSchema = z
	.object({
		management: z
			.object({
				publicUrl: z.string().url().max(512),
				listeners: z.array(listenerSchema).min(1).max(16),
				allowZeroTier: z.boolean(),
				zeroTierInterface: z.string().max(32),
				zeroTierAddress: z.string().max(64),
				sessionMaxAgeSeconds: z.number().int().min(900).max(28800),
				loginAttempts: z.number().int().min(1).max(20),
				loginLockoutSeconds: z.number().int().min(60).max(86400),
			})
			.strict(),
		zerotier: z
			.object({
				enabled: z.boolean(),
				bindAddress: z.string().min(2).max(64),
				publicPort: z.number().int().min(1).max(65535),
				secondaryPort: z.number().int().min(0).max(65535),
				tertiaryPort: z.number().int().min(0).max(65535),
				allowSecondaryPort: z.boolean(),
				portMappingEnabled: z.boolean(),
			})
			.strict(),
		controller: z
			.object({
				exposure: z.enum(["internal", "direct", "https"]),
				bindAddress: z.string().min(2).max(64),
				port: z.number().int().min(1).max(65535),
			})
			.strict(),
		relayServer: z
			.object({
				enabled: z.boolean(),
				bindAddress: z.string().min(2).max(64),
				port: z.number().int().min(1).max(65535),
				allowedSourceCidrs: z.array(z.string().min(3).max(64)).max(64),
				maxConnections: z.number().int().min(1).max(4096),
				maxConnectionsPerIp: z.number().int().min(1).max(256),
				packetsPerSecond: z.number().int().min(1).max(100000),
				bytesPerSecond: z.number().int().min(1024).max(1073741824),
				globalPacketsPerSecond: z.number().int().min(1).max(1000000),
				globalBytesPerSecond: z.number().int().min(1024).max(10737418240),
				handshakeTimeoutSeconds: z.number().int().min(1).max(60),
				idleTimeoutSeconds: z.number().int().min(30).max(3600),
				maxDestinations: z.number().int().min(1).max(1024),
				minDestinationPort: z.number().int().min(1).max(65535),
			})
			.strict(),
		relayClient: z
			.object({
				mode: z.enum(["off", "official-auto", "custom-auto", "custom-force"]),
				host: z.string().max(253),
				port: z.number().int().min(1).max(65535),
			})
			.strict(),
	})
	.strict();

export type SystemConfig = z.infer<typeof systemConfigSchema>;

type AgentEnvelope = {
	revision: number;
	updatedAt: string;
	config: SystemConfig;
	drift?: string[];
	zeroTierInterfaces?: Array<{ name: string; addresses: string[] }>;
	effectiveManagementListeners?: Array<z.infer<typeof listenerSchema>>;
	actualListeners?: Array<{ protocol: string; endpoint: string }>;
	relayMetrics?: Record<string, number>;
	exposures?: Array<{
		purpose: string;
		protocol: string;
		address: string;
		port: number;
		tls: string;
		authentication: string;
		allowedSources: string[];
		health: string;
		risk: string;
	}>;
};

type ValidationResult = {
	valid: boolean;
	config: SystemConfig;
	warnings: string[];
	risky: boolean;
};

function actor(ctx): string {
	return `${ctx.session.user.id}:${ctx.session.user.email || "admin"}`;
}

async function verifyReauthentication(ctx, password: string | undefined): Promise<void> {
	if (!password) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Administrator password confirmation is required" });
	}
	const user = await ctx.prisma.user.findUnique({
		where: { id: ctx.session.user.id },
		select: { hash: true },
	});
	if (!user?.hash || !(await compare(password, user.hash))) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Administrator password confirmation failed" });
	}
}

export const systemRouter = createTRPCRouter({
	status: adminRoleProtectedRoute.query(async ({ ctx }) => {
		return await callAgent<AgentEnvelope>("GET", "/v1/status", undefined, actor(ctx));
	}),
	validate: adminRoleProtectedRoute
		.input(z.object({ config: systemConfigSchema }))
		.mutation(async ({ ctx, input }) => {
			return await callAgent<ValidationResult>("POST", "/v1/validate", input, actor(ctx));
		}),
	apply: adminRoleProtectedRoute
		.input(
			z.object({
				config: systemConfigSchema,
				expectedRevision: z.number().int().positive(),
				idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
				password: z.string().max(128).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const validation = await callAgent<ValidationResult>(
				"POST",
				"/v1/validate",
				{ config: input.config },
				actor(ctx),
			);
			const current = await callAgent<AgentEnvelope>("GET", "/v1/config", undefined, actor(ctx));
			const controllerExposureChanged =
				current.config.controller.exposure !== input.config.controller.exposure;
			if (validation.risky || controllerExposureChanged) {
				await verifyReauthentication(ctx, input.password);
			}
			const { password: _password, ...agentInput } = input;
			return await callAgent<AgentEnvelope & { applied: boolean; warnings: string[] }>(
				"POST",
				"/v1/apply",
				agentInput,
				actor(ctx),
			);
		}),
	rollback: adminRoleProtectedRoute
		.input(z.object({ password: z.string().max(128) }))
		.mutation(async ({ ctx, input }) => {
			await verifyReauthentication(ctx, input.password);
			return await callAgent<AgentEnvelope & { rolledBack: boolean }>(
				"POST",
				"/v1/rollback",
				{},
				actor(ctx),
			);
		}),
	generateCertificate: adminRoleProtectedRoute
		.input(z.object({ names: z.array(z.string().min(1).max(253)).min(1).max(16), password: z.string().max(128) }))
		.mutation(async ({ ctx, input }) => {
			await verifyReauthentication(ctx, input.password);
			return await callAgent<{ generated: boolean; certificate: string; names: string[] }>(
				"POST",
				"/v1/certificates/self-signed",
				{ names: input.names },
				actor(ctx),
			);
		}),
	installCustomCertificate: adminRoleProtectedRoute
		.input(z.object({
			certificate: z.string().min(256).max(262144),
			privateKey: z.string().min(256).max(262144),
			password: z.string().max(128),
		}))
		.mutation(async ({ ctx, input }) => {
			await verifyReauthentication(ctx, input.password);
			return await callAgent<{ installed: boolean }>(
				"POST",
				"/v1/certificates/custom",
				{ certificate: input.certificate, privateKey: input.privateKey },
				actor(ctx),
			);
		}),
	rotateControllerToken: adminRoleProtectedRoute
		.input(z.object({ password: z.string().max(128) }))
		.mutation(async ({ ctx, input }) => {
			await verifyReauthentication(ctx, input.password);
			return await callAgent<{ rotated: boolean }>(
				"POST",
				"/v1/controller/token/rotate",
				{},
				actor(ctx),
			);
		}),
	clientConfig: adminRoleProtectedRoute.query(async ({ ctx }) => {
		return await callAgent<{ settings: Record<string, unknown> }>(
			"GET",
			"/v1/client-config",
			undefined,
			actor(ctx),
		);
	}),
	audit: adminRoleProtectedRoute.query(async ({ ctx }) => {
		return await callAgent<{ events: Array<Record<string, unknown>> }>(
			"GET",
			"/v1/audit",
			undefined,
			actor(ctx),
		);
	}),
});
