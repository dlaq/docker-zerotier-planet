import { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";
import { ZT_FOLDER } from "~/utils/ztApi";
import { getActiveSession } from "~/lib/activeSession";
import { fromNodeHeaders } from "better-auth/node";

export const config = {
	api: {
		bodyParser: false,
	},
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
			// A migration can preserve the active Planet without preserving the
			// generated-world workspace. Prefer the generated artifact, then fall
			// back to the active/legacy copy so downloads do not fail with a false
			// 404 after a valid Controller import.
			const candidates = [
				path.join(folderPath, "planet.custom"),
				path.resolve(`${ZT_FOLDER}/planet`),
				path.resolve(`${ZT_FOLDER}/legacy-dist/planet`),
			];
			const filePath = candidates.find((candidate) => {
				try {
					const stat = fs.statSync(candidate);
					return stat.isFile() && stat.size > 0;
				} catch {
					return false;
				}
			});

			if (!filePath) {
				return res.status(404).send("Folder or file not found.");
			}

			// Read the file and stream it to the response
			const fileStream = fs.createReadStream(filePath);

			// Set the headers
			res.setHeader("Content-Disposition", "attachment; filename=planet.custom");
			res.setHeader("Content-Type", "application/octet-stream");

			// Pipe the read stream to the response
			fileStream.pipe(res);
		} catch (error) {
			console.error(error);
			res.status(500).send("Internal Server Error.");
		}
	} else {
		res.status(405).send("Method Not Allowed"); // Handle unsupported HTTP methods
	}
};
