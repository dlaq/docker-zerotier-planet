import type { MemberEntity, Peers } from "~/types/local/member";
import type { NetworkEntity } from "~/types/local/network";
import { Address4, Address6 } from "ip-address";

export enum ConnectionStatus {
	Offline = 0,
	Relayed = 1,
	DirectLAN = 2,
	DirectWAN = 3,
	Controller = 4,
	Unknown = 5,
}

export function activePreferredPath(peers: Partial<Peers> | null | undefined) {
	return peers?.paths?.find(
		(path) => path.active === true && path.preferred === true && path.expired !== true,
	);
}

function privateAddress(address: string): boolean {
	const ip = address.split("/")[0].replace(/^\[|\]$/g, "");
	if (Address4.isValid(ip)) {
		const [a, b] = ip.split(".").map(Number);
		return (
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a === 127 ||
			(a === 169 && b === 254)
		);
	}
	if (Address6.isValid(ip))
		return (
			new Address6(ip).isInSubnet(new Address6("fc00::/7")) ||
			new Address6(ip).isInSubnet(new Address6("fe80::/10")) ||
			ip === "::1"
		);
	return false;
}

/** The path is from this controller to the node, not between arbitrary clients. */
export function determineConnectionStatus(
	member: Pick<MemberEntity, "id" | "nwid" | "peers">,
	online?: boolean,
	peersAvailable = true,
): ConnectionStatus {
	if (!peersAvailable) return ConnectionStatus.Unknown;
	if (online === false) return ConnectionStatus.Offline;
	if (
		/^[0-9a-f]{10}$/i.test(member.id) &&
		member.nwid?.slice(0, 10).toLowerCase() === member.id.toLowerCase()
	)
		return ConnectionStatus.Controller;
	const path = activePreferredPath(member.peers);
	if (path)
		return privateAddress(path.address)
			? ConnectionStatus.DirectLAN
			: ConnectionStatus.DirectWAN;
	// Unknown latency/version is not evidence of a relay; an observed config
	// request with no live direct path is. Unobserved/legacy peers stay unknown.
	return online === true ? ConnectionStatus.Relayed : ConnectionStatus.Unknown;
}

export function memberIpState(
	member: Pick<MemberEntity, "authorized" | "ipAssignments" | "noAutoAssignIps">,
	network?: Partial<NetworkEntity>,
) {
	if (!member.authorized) return "waitingAuthorization";
	if (
		member.ipAssignments?.length ||
		network?.v6AssignMode?.rfc4193 ||
		network?.v6AssignMode?.["6plane"]
	)
		return "assigned";
	if (member.noAutoAssignIps) return "manualAssignment";
	if (!network) return "notAssigned";
	if (network.v4AssignMode?.zt || network.v6AssignMode?.zt) return "waitingAssignment";
	return "autoAssignmentDisabled";
}
