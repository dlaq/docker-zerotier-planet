import { getActiveSession } from "~/lib/activeSession";
import { auth } from "~/lib/auth";
import { prisma } from "~/server/db";

jest.mock("~/lib/auth", () => ({ auth: { api: { getSession: jest.fn() } } }));
jest.mock("~/server/db", () => ({
	prisma: { user: { findUnique: jest.fn() } },
}));

const user = { isActive: true, role: "USER", expiresAt: null, userGroup: null };
const headers = new Headers();
beforeEach(() => {
	jest.resetAllMocks();
	(auth.api.getSession as jest.Mock).mockResolvedValue({
		user: { id: "u1", role: "ADMIN" },
		session: { id: "s1" },
	});
	(prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
});

it.each([
	null,
	{ ...user, isActive: false },
	{ ...user, expiresAt: new Date(0) },
	{ ...user, userGroup: { expiresAt: new Date(0) } },
])(
	"rejects a still-valid cookie after account removal, disabling or expiry",
	async (record) => {
		(prisma.user.findUnique as jest.Mock).mockResolvedValue(record);
		expect(await getActiveSession({ headers })).toBeNull();
	},
);

it("uses the current role for an existing session", async () => {
	expect((await getActiveSession({ headers }))?.user.role).toBe("USER");
});

it("retains the administrator exemption from group expiry", async () => {
	(prisma.user.findUnique as jest.Mock).mockResolvedValue({
		...user,
		role: "ADMIN",
		userGroup: { expiresAt: new Date(0) },
	});
	expect(await getActiveSession({ headers })).not.toBeNull();
});

it("does not query account data for an anonymous request", async () => {
	(auth.api.getSession as jest.Mock).mockResolvedValue(null);
	expect(await getActiveSession({ headers })).toBeNull();
	expect(prisma.user.findUnique).not.toHaveBeenCalled();
});
