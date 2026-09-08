import { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import archiver from "archiver";
import formidable from "formidable";
import { promises as fsPromises } from "fs";
import { prisma } from "~/server/db";
import unzipper from "unzipper";
import { execFileSync } from "child_process";
import { extractEndpointPorts, updateLocalConf } from "~/utils/planet";
import { ZT_FOLDER } from "~/utils/ztApi";
import { WorldConfig } from "~/types/worldConfig";
import { getActiveSession } from "~/lib/activeSession";
import { fromNodeHeaders } from "better-auth/node";

export const config = {
	api: {
		bodyParser: false,
	},
};

const MAX_ARCHIVE_ENTRY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_GENERATED_PLANET_BYTES = 16 * 1024 * 1024;
const MAX_ROOT_NODES = 32;
const MAX_ENDPOINT_LENGTH = 512;
const ALLOWED_WORLD_FILES = new Set([
	"mkworld.config.json",
	"current.c25519",
	"previous.c25519",
	"planet.custom",
]);

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Parse and constrain an uploaded world definition before it reaches
 * ztmkworld. In particular, this makes an empty/malformed rootNodes array a
 * normal 400 response instead of an asynchronous TypeError/500.
 */
export const parseWorldConfig = (
	value: unknown,
): {
	config: WorldConfig;
	portNumbers: number[];
} => {
	if (!isRecord(value) || !Array.isArray(value.rootNodes)) {
		throw new Error("mkworld.config.json must contain rootNodes");
	}
	if (value.rootNodes.length === 0 || value.rootNodes.length > MAX_ROOT_NODES) {
		throw new Error("mkworld.config.json must contain 1-32 root nodes");
	}

	const rootNodes = value.rootNodes.map((node, index) => {
		if (!isRecord(node) || typeof node.identity !== "string") {
			throw new Error(`Invalid identity for root node ${index + 1}`);
		}
		if (!node.identity.trim() || node.identity.length > 16 * 1024) {
			throw new Error(`Invalid identity for root node ${index + 1}`);
		}
		if (
			!Array.isArray(node.endpoints) ||
			node.endpoints.length === 0 ||
			node.endpoints.length > 32 ||
			!node.endpoints.every(
				(endpoint): endpoint is string =>
					typeof endpoint === "string" &&
					endpoint.trim().length > 0 &&
					endpoint.length <= MAX_ENDPOINT_LENGTH,
			)
		) {
			throw new Error(`Invalid endpoints for root node ${index + 1}`);
		}
		return {
			comments:
				typeof node.comments === "string" && node.comments.length <= 1024
					? node.comments
					: "ztnet.network",
			identity: node.identity.trim(),
			endpoints: node.endpoints.map((endpoint) => endpoint.trim()),
		};
	});

	// Every root node participates in the generated world.  Looking only at the
	// first node can silently omit a second listener port used by another root,
	// leaving local.conf out of sync with the planet clients receive.
	const portNumbers = extractEndpointPorts(rootNodes.flatMap((node) => node.endpoints));
	const plID = value.plID === undefined ? 0 : value.plID;
	if (
		typeof plID !== "number" ||
		!Number.isSafeInteger(plID) ||
		plID < 0 ||
		plID > 2 ** 32 - 1
	) {
		throw new Error("plID must be an integer from 0 to 4294967295");
	}
	const plBirth = value.plBirth === undefined ? 0 : value.plBirth;
	if (
		typeof plBirth !== "number" ||
		!Number.isSafeInteger(plBirth) ||
		plBirth < 0 ||
		plBirth > Number.MAX_SAFE_INTEGER
	) {
		throw new Error("plBirth must be a non-negative safe integer");
	}
	const plRecommend = value.plRecommend === undefined ? true : value.plRecommend;
	if (typeof plRecommend !== "boolean") {
		throw new Error("plRecommend must be a boolean");
	}
	if (!plRecommend && (value.plID === undefined || value.plBirth === undefined)) {
		throw new Error("plID and plBirth are required when plRecommend is false");
	}

	return {
		config: {
			rootNodes,
			signing: ["previous.c25519", "current.c25519"],
			output: "planet.custom",
			plID,
			plBirth,
			plRecommend,
		},
		portNumbers,
	};
};

const copyFileAtomically = async (source: string, destination: string) => {
	const temporaryPath = `${destination}.tmp-${randomUUID()}`;
	try {
		await fsPromises.copyFile(source, temporaryPath);
		await fsPromises.rename(temporaryPath, destination);
	} finally {
		await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

export default async (req: NextApiRequest, res: NextApiResponse) => {
	const session = await getActiveSession({
		headers: fromNodeHeaders(req.headers),
	});
	if (!session?.user || session.user.role !== "ADMIN") {
		res.status(401).json({ message: "Administrator authentication required" });
		return;
	}

	if (req.method === "GET") {
		try {
			const folderPath = path.resolve(`${ZT_FOLDER}/zt-mkworld`);
			if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
				return res.status(404).send("Folder not found.");
			}

			const archive = archiver("zip", { zlib: { level: 9 } });
			archive.on("warning", (err) => {
				if (err.code === "ENOENT") console.warn(err);
				else console.error("mkworld archive warning:", err);
			});
			archive.on("error", (err) => {
				console.error("mkworld archive error:", err);
				if (!res.writableEnded) res.end();
			});
			res.setHeader("Content-Disposition", "attachment; filename=zt-mkworld.zip");
			res.setHeader("Content-Type", "application/zip");
			archive.pipe(res);
			archive.directory(folderPath, false);
			await archive.finalize();
			return;
		} catch (error) {
			console.error(error);
			if (!res.writableEnded) res.status(500).send("Internal Server Error.");
			return;
		}
	}

	if (req.method !== "POST") {
		res.status(405).json({ error: "Method Not Allowed" });
		return;
	}

	const mkworldDir = `${ZT_FOLDER}/zt-mkworld`;
	const ztmkworldBinPath = "/usr/local/bin/ztmkworld";
	const planetPath = `${ZT_FOLDER}/planet`;
	const backupDir = `${ZT_FOLDER}/planet_backup`;
	const uploadDir = "/tmp";
	const form = formidable({
		uploadDir,
		keepExtensions: true,
		maxFiles: 1,
		maxFileSize: MAX_ARCHIVE_TOTAL_BYTES,
		maxTotalFileSize: MAX_ARCHIVE_TOTAL_BYTES,
	});

	let uploadedFilePath: string | undefined;
	let stagingDir: string | undefined;
	try {
		const { files } = await new Promise<{ files: formidable.Files }>(
			(resolve, reject) => {
				form.parse(req, (err, _fields, parsedFiles) => {
					if (err) reject(err);
					else resolve({ files: parsedFiles });
				});
			},
		);

		const uploaded = files.file;
		const uploadedFile = Array.isArray(uploaded) ? uploaded[0] : uploaded;
		uploadedFilePath = uploadedFile?.filepath;
		if (!uploadedFilePath) {
			res.status(400).json({ error: "No file uploaded." });
			return;
		}

		// formidable stores the upload inside uploadDir; ensure the resolved path
		// stays within it before reading, so a manipulated filepath cannot make
		// this endpoint read an arbitrary local file.
		const resolvedUploadPath = path.resolve(uploadedFilePath);
		if (!resolvedUploadPath.startsWith(path.resolve(uploadDir) + path.sep)) {
			res.status(400).json({ error: "Invalid upload path." });
			return;
		}

		const archive = await unzipper.Open.file(resolvedUploadPath);
		if (archive.files.length > 64) {
			throw new Error("Archive contains too many entries");
		}
		const extractedFiles = new Map<string, Buffer>();
		let totalUncompressedBytes = 0;
		for (const entry of archive.files) {
			if (entry.type === "Directory") continue;

			const declaredSize = Number(
				(entry as unknown as { uncompressedSize?: number }).uncompressedSize,
			);
			if (
				Number.isFinite(declaredSize) &&
				(declaredSize < 0 || declaredSize > MAX_ARCHIVE_ENTRY_BYTES)
			) {
				throw new Error("Archive entry is too large");
			}

			const chunks: Buffer[] = [];
			let entryBytes = 0;
			for await (const chunk of entry.stream()) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				entryBytes += buffer.length;
				totalUncompressedBytes += buffer.length;
				if (
					entryBytes > MAX_ARCHIVE_ENTRY_BYTES ||
					totalUncompressedBytes > MAX_ARCHIVE_TOTAL_BYTES
				) {
					throw new Error("Archive is too large");
				}
				chunks.push(buffer);
			}

			if (!ALLOWED_WORLD_FILES.has(entry.path)) continue;
			if (extractedFiles.has(entry.path)) {
				throw new Error(`Duplicate archive entry: ${entry.path}`);
			}
			extractedFiles.set(entry.path, Buffer.concat(chunks, entryBytes));
		}

		const configFile = extractedFiles.get("mkworld.config.json");
		if (!configFile) {
			res.status(400).json({
				error: "Missing required files in the zip.",
				files: ["mkworld.config.json"],
			});
			return;
		}

		let parsedContent: unknown;
		try {
			parsedContent = JSON.parse(configFile.toString("utf8"));
		} catch {
			res.status(400).json({ error: "Invalid mkworld.config.json." });
			return;
		}
		const { config: worldConfig, portNumbers } = parseWorldConfig(parsedContent);

		// Work in a private temporary directory. The persistent controller files
		// are changed only after the archive and ztmkworld output are validated.
		stagingDir = await fsPromises.mkdtemp(path.join(uploadDir, "ztnet-mkworld-"));
		for (const [fileName, content] of extractedFiles) {
			await fsPromises.writeFile(path.join(stagingDir, fileName), content, {
				mode: 0o600,
			});
		}
		await fsPromises.writeFile(
			path.join(stagingDir, "mkworld.config.json"),
			JSON.stringify(worldConfig),
			{ mode: 0o600 },
		);

		try {
			execFileSync(
				ztmkworldBinPath,
				["-c", path.join(stagingDir, "mkworld.config.json")],
				{ cwd: stagingDir, timeout: 30_000, stdio: "ignore" },
			);
		} catch (error) {
			console.error("Error running ztmkworld:", error);
			res.status(400).json({ error: "Error running ztmkworld." });
			return;
		}

		const generatedPlanetPath = path.join(stagingDir, "planet.custom");
		const generatedPlanetStat = await fsPromises.stat(generatedPlanetPath);
		if (
			!generatedPlanetStat.isFile() ||
			generatedPlanetStat.size === 0 ||
			generatedPlanetStat.size > MAX_GENERATED_PLANET_BYTES
		) {
			throw new Error("ztmkworld did not produce a valid planet file");
		}

		// Update local.conf only after the archive and generated planet have been
		// validated. updateLocalConf performs an atomic replacement.
		await updateLocalConf(portNumbers);
		await fsPromises.mkdir(mkworldDir, { recursive: true, mode: 0o700 });
		if (fs.existsSync(planetPath) && !fs.existsSync(backupDir)) {
			await fsPromises.mkdir(backupDir, { recursive: true, mode: 0o700 });
			const timestamp = new Date().toISOString().replace(/[^a-zA-Z0-9]/g, "_");
			await fsPromises.copyFile(
				planetPath,
				path.join(backupDir, `planet.bak.${timestamp}`),
			);
		}

		for (const fileName of extractedFiles.keys()) {
			await copyFileAtomically(
				path.join(stagingDir, fileName),
				path.join(mkworldDir, fileName),
			);
		}
		await copyFileAtomically(generatedPlanetPath, planetPath);

		await prisma.planet.upsert({
			where: { id: 1 },
			update: {
				globalOptions: { connect: { id: 1 } },
				plBirth: worldConfig.plBirth,
				plID: worldConfig.plID,
				rootNodes: {
					deleteMany: {},
					create: worldConfig.rootNodes,
				},
			},
			create: {
				globalOptions: { connect: { id: 1 } },
				plBirth: worldConfig.plBirth,
				plID: worldConfig.plID,
				rootNodes: { create: worldConfig.rootNodes },
			},
		});

		res.status(200).json({
			message: "File uploaded and extracted successfully.",
		});
	} catch (error) {
		console.error("Error processing the uploaded file:", error);
		if (!res.writableEnded) {
			res.status(400).json({ error: "Invalid world archive or configuration." });
		}
	} finally {
		if (stagingDir) {
			await fsPromises.rm(stagingDir, { recursive: true, force: true });
		}
		if (uploadedFilePath) {
			await fsPromises.unlink(uploadedFilePath).catch(() => undefined);
		}
	}
};
