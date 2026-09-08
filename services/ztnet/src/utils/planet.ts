import fs from "fs";
import { randomUUID } from "crypto";
import { ZT_FOLDER } from "./ztApi";

interface LocalConf {
	settings?: {
		primaryPort?: number;
		secondaryPort?: number;
		allowSecondaryPort?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const validatePorts = (portNumbers: unknown): number[] => {
	if (
		!Array.isArray(portNumbers) ||
		portNumbers.length === 0 ||
		portNumbers.length > 2 ||
		!portNumbers.every(
			(port): port is number =>
				typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535,
		)
	) {
		throw new Error("ZeroTier listener ports must be 1-65535 (at most two)");
	}
	return [...new Set(portNumbers)];
};

/**
 * Extract the one or two ZeroTier listener ports from a root endpoint list.
 * Endpoint strings may contain comma-separated IPv4/IPv6 addresses; only the
 * port suffix is used for local.conf, and invalid values are rejected before
 * any file is written.
 */
export const extractEndpointPorts = (endpoints: string[]): number[] => {
	if (!Array.isArray(endpoints) || endpoints.length === 0) {
		throw new Error("At least one root endpoint is required");
	}

	const ports: number[] = [];
	for (const endpointList of endpoints) {
		for (const rawEndpoint of endpointList.split(",")) {
			const endpoint = rawEndpoint.trim();
			const separator = endpoint.lastIndexOf("/");
			if (separator <= 0 || separator === endpoint.length - 1) {
				throw new Error(`Invalid root endpoint: ${endpoint}`);
			}
			const address = endpoint.slice(0, separator).trim();
			const port = Number(endpoint.slice(separator + 1).trim());
			if (!address || !Number.isInteger(port) || port < 1 || port > 65535) {
				throw new Error(`Invalid root endpoint: ${endpoint}`);
			}
			if (!ports.includes(port)) ports.push(port);
		}
	}

	if (ports.length === 0 || ports.length > 2) {
		throw new Error("ZeroTier supports at most two listener ports");
	}
	return ports;
};

const writeJsonAtomically = async (filePath: string, value: unknown) => {
	const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
	try {
		await fs.promises.writeFile(temporaryPath, JSON.stringify(value, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.promises.rename(temporaryPath, filePath);
	} finally {
		await fs.promises.unlink(temporaryPath).catch(() => undefined);
	}
};

/** Update ZeroTier's local.conf with validated primary/secondary ports. */
export const updateLocalConf = async (portNumbers: number[]): Promise<boolean> => {
	const validatedPorts = validatePorts(portNumbers);
	if (validatedPorts.length === 0) {
		throw new Error("At least one unique ZeroTier listener port is required");
	}
	const localConfPath = `${ZT_FOLDER}/local.conf`;
	let localConf: LocalConf;

	try {
		const localConfContent = await fs.promises.readFile(localConfPath, "utf8");
		const parsed: unknown = localConfContent ? JSON.parse(localConfContent) : {};
		if (!isRecord(parsed)) throw new Error("local.conf must contain a JSON object");
		localConf = parsed as LocalConf;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			localConf = {};
		} else if (error instanceof SyntaxError) {
			throw new Error("Error parsing zerotier-one/local.conf");
		} else {
			throw new Error(
				`Error reading zerotier-one/local.conf: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	if (localConf.settings !== undefined && !isRecord(localConf.settings)) {
		throw new Error("zerotier-one/local.conf settings must be an object");
	}
	if (!localConf.settings) localConf.settings = {};
	localConf.settings.primaryPort = validatedPorts[0];
	if (validatedPorts.length > 1) {
		localConf.settings.secondaryPort = validatedPorts[1];
		localConf.settings.allowSecondaryPort = true;
	} else {
		localConf.settings.secondaryPort = undefined;
		localConf.settings.allowSecondaryPort = undefined;
	}

	await writeJsonAtomically(localConfPath, localConf);
	return true;
};
