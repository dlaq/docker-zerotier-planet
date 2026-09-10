import { TRPCError } from "@trpc/server";
import { compare } from "bcryptjs";
import { z } from "zod";
import net from "node:net";
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
	mode?: "agent" | "compose-read-only";
	agentAvailable?: boolean;
	message?: string;
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

function envString(name: string, fallback: string): string {
	const value = process.env[name]?.trim();
	return value || fallback;
}

function envInt(
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const value = Number.parseInt(process.env[name] || "", 10);
	return Number.isInteger(value) && value >= minimum && value <= maximum
		? value
		: fallback;
}

function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === "true" || value === "1" || value === "yes") return true;
	if (value === "false" || value === "0" || value === "no") return false;
	return fallback;
}

function envCidrs(name: string): string[] {
	return (process.env[name] || "")
		.split(/[\s,]+/)
		.map((value) => value.trim())
		.filter((value) => value.length >= 3 && value.length <= 64)
		.slice(0, 64);
}

/**
 * 1Panel's paste-only Compose deployment intentionally has no host agent
 * socket. Keep the page useful in that mode by reporting the effective
 * Compose environment as read-only instead of returning a blank spinner.
 */
function composeReadOnlyStatus(reason: string): AgentEnvelope {
	const managementAddress = net.isIP(envString("MANAGEMENT_BIND_ADDRESS", "127.0.0.1"))
		? envString("MANAGEMENT_BIND_ADDRESS", "127.0.0.1")
		: "127.0.0.1";
	const managementPort = envInt("MANAGEMENT_PORT", 3443, 1, 65535);
	const publicUrl = (() => {
		const candidate = envString("NEXTAUTH_URL", `https://localhost:${managementPort}`);
		try {
			const parsed = new URL(candidate);
			return parsed.protocol === "http:" || parsed.protocol === "https:"
				? parsed.toString().replace(/\/$/, "")
				: `https://localhost:${managementPort}`;
		} catch {
			return `https://localhost:${managementPort}`;
		}
	})();
	const relayEnabled = (process.env.COMPOSE_PROFILES || "")
		.split(/[\s,]+/)
		.includes("relay");
	const relayBind = envString("RELAY_BIND_ADDRESS", "127.0.0.1");
	const relayPort = envInt("RELAY_PUBLIC_PORT", 4443, 1, 65535);
	const allowZeroTier = envBool("ZT_ALLOW_MANAGEMENT_UI", false);
	const zeroTierAddress = envString("ZT_MANAGEMENT_ADDRESS", "");
	const listeners: SystemConfig["management"]["listeners"] = [
		{
			address: managementAddress,
			port: managementPort,
			tlsMode: envBool("MANAGEMENT_TLS_OFF", false) ? "off" : "self-signed",
			allowedCidrs: envCidrs("MANAGEMENT_ALLOWED_CIDRS"),
		},
	];
	if (allowZeroTier && net.isIP(zeroTierAddress)) {
		listeners.push({
			...listeners[0],
			address: zeroTierAddress,
		});
	}
	const config: SystemConfig = {
		management: {
			publicUrl,
			listeners,
			allowZeroTier,
			zeroTierInterface: envString("ZT_MANAGEMENT_INTERFACE", ""),
			zeroTierAddress,
			sessionMaxAgeSeconds: envInt("NEXTAUTH_SESSION_MAX_AGE", 28800, 900, 28800),
			loginAttempts: envInt("ZTPLANET_LOGIN_ATTEMPTS", 5, 1, 20),
			loginLockoutSeconds: envInt("ZTPLANET_LOGIN_LOCKOUT_SECONDS", 900, 60, 86400),
		},
		zerotier: {
			enabled: envBool("ZT_ENABLED", true),
			bindAddress: net.isIP(envString("ZT_BIND_ADDRESS", "0.0.0.0"))
				? envString("ZT_BIND_ADDRESS", "0.0.0.0")
				: "0.0.0.0",
			publicPort: envInt("ZT_PUBLIC_PORT", 9993, 1, 65535),
			secondaryPort: envInt("ZT_SECONDARY_PORT", 0, 0, 65535),
			tertiaryPort: envInt("ZT_TERTIARY_PORT", 0, 0, 65535),
			allowSecondaryPort: envBool("ZT_ALLOW_SECONDARY_PORT", true),
			portMappingEnabled: envBool("ZT_PORT_MAPPING_ENABLED", true),
		},
		controller: {
			exposure: ((): SystemConfig["controller"]["exposure"] => {
				const value = envString("CONTROLLER_EXPOSURE", "internal");
				return value === "direct" || value === "https" ? value : "internal";
			})(),
			bindAddress: net.isIP(envString("CONTROLLER_BIND_ADDRESS", "127.0.0.1"))
				? envString("CONTROLLER_BIND_ADDRESS", "127.0.0.1")
				: "127.0.0.1",
			port: envInt("CONTROLLER_PORT", 9993, 1, 65535),
		},
		relayServer: {
			enabled: relayEnabled,
			bindAddress: net.isIP(relayBind) ? relayBind : "127.0.0.1",
			port: relayPort,
			allowedSourceCidrs: envCidrs("RELAY_ALLOWED_CIDRS"),
			maxConnections: envInt("RELAY_MAX_CONNECTIONS", 128, 1, 4096),
			maxConnectionsPerIp: envInt("RELAY_MAX_CONNECTIONS_PER_IP", 4, 1, 256),
			packetsPerSecond: envInt("RELAY_PACKETS_PER_SECOND", 200, 1, 100000),
			bytesPerSecond: envInt("RELAY_BYTES_PER_SECOND", 2097152, 1024, 1073741824),
			globalPacketsPerSecond: envInt("RELAY_GLOBAL_PACKETS_PER_SECOND", 2000, 1, 1000000),
			globalBytesPerSecond: envInt(
				"RELAY_GLOBAL_BYTES_PER_SECOND",
				20971520,
				1024,
				10737418240,
			),
			handshakeTimeoutSeconds: envInt("RELAY_HANDSHAKE_TIMEOUT_SECONDS", 10, 1, 60),
			idleTimeoutSeconds: envInt("RELAY_IDLE_TIMEOUT_SECONDS", 300, 30, 3600),
			maxDestinations: envInt("RELAY_MAX_DESTINATIONS", 64, 1, 1024),
			minDestinationPort: envInt("RELAY_MIN_DESTINATION_PORT", 1025, 1, 65535),
		},
		relayClient: {
			mode: "off",
			host: "",
			port: 443,
		},
	};
	const exposures: NonNullable<AgentEnvelope["exposures"]> = [
		{
			purpose: "Management UI",
			protocol: "tcp",
			address: managementAddress,
			port: managementPort,
			tls: config.management.listeners[0]?.tlsMode || "self-signed",
			authentication: "session + administrator role",
			allowedSources: config.management.listeners[0]?.allowedCidrs || ["any"],
			health: "not-observed (1Panel Compose)",
			risk: managementAddress === "127.0.0.1" ? "low" : "review binding",
		},
	];
	if (config.zerotier.enabled) {
		exposures.push({
			purpose: "ZeroTier root/data plane",
			protocol: "udp",
			address: config.zerotier.bindAddress,
			port: config.zerotier.publicPort,
			tls: "ZeroTier wire encryption",
			authentication: "ZeroTier identity",
			allowedSources: ["any"],
			health: "not-observed (1Panel Compose)",
			risk: "intended-public-service",
		});
	}
	if (relayEnabled) {
		exposures.push({
			purpose: "TCP fallback relay",
			protocol: "tcp",
			address: relayBind,
			port: relayPort,
			tls: "fake TLS framing (not TLS)",
			authentication: "none in protocol",
			allowedSources: config.relayServer.allowedSourceCidrs.length
				? config.relayServer.allowedSourceCidrs
				: ["any"],
			health: "not-observed (1Panel Compose)",
			risk: config.relayServer.allowedSourceCidrs.length ? "restricted-source" : "high",
		});
	}
	return {
		revision: 0,
		updatedAt: new Date().toISOString(),
		config,
		mode: "compose-read-only",
		agentAvailable: false,
		message: `宿主机配置代理不可用，当前显示的是 Compose 环境（${reason}）。在 1Panel 粘贴模式下请修改 .env/环境变量后重建；原子应用、证书和回滚按钮需要安装宿主机代理。`,
		drift: [],
		zeroTierInterfaces: [],
		effectiveManagementListeners: listeners,
		actualListeners: [],
		relayMetrics: {},
		exposures,
	};
}

function isAgentUnavailable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /ENOENT|EACCES|ECONNREFUSED|ENOTFOUND|agent\.sock|agent\.secret|socket hang up/i.test(
		message,
	);
}

async function verifyReauthentication(ctx, password: string | undefined): Promise<void> {
	if (!password) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Administrator password confirmation is required",
		});
	}
	const user = await ctx.prisma.user.findUnique({
		where: { id: ctx.session.user.id },
		select: { hash: true },
	});
	if (!user?.hash || !(await compare(password, user.hash))) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Administrator password confirmation failed",
		});
	}
}

export const systemRouter = createTRPCRouter({
	status: adminRoleProtectedRoute.query(async ({ ctx }) => {
		try {
			return await callAgent<AgentEnvelope>("GET", "/v1/status", undefined, actor(ctx));
		} catch (error) {
			if (!isAgentUnavailable(error)) throw error;
			return composeReadOnlyStatus(
				error instanceof Error ? error.message : "socket unavailable",
			);
		}
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
			const current = await callAgent<AgentEnvelope>(
				"GET",
				"/v1/config",
				undefined,
				actor(ctx),
			);
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
		.input(
			z.object({
				names: z.array(z.string().min(1).max(253)).min(1).max(16),
				password: z.string().max(128),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await verifyReauthentication(ctx, input.password);
			return await callAgent<{
				generated: boolean;
				certificate: string;
				names: string[];
			}>("POST", "/v1/certificates/self-signed", { names: input.names }, actor(ctx));
		}),
	installCustomCertificate: adminRoleProtectedRoute
		.input(
			z.object({
				certificate: z.string().min(256).max(262144),
				privateKey: z.string().min(256).max(262144),
				password: z.string().max(128),
			}),
		)
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
		try {
			return await callAgent<{ settings: Record<string, unknown> }>(
				"GET",
				"/v1/client-config",
				undefined,
				actor(ctx),
			);
		} catch (error) {
			if (!isAgentUnavailable(error)) throw error;
			return {
				settings: {
					allowTcpFallbackRelay: false,
					forceTcpRelay: false,
					mode: "compose-read-only",
				},
			};
		}
	}),
	audit: adminRoleProtectedRoute.query(async ({ ctx }) => {
		try {
			return await callAgent<{ events: Array<Record<string, unknown>> }>(
				"GET",
				"/v1/audit",
				undefined,
				actor(ctx),
			);
		} catch (error) {
			if (!isAgentUnavailable(error)) throw error;
			return { events: [] };
		}
	}),
});
