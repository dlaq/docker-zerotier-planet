// Member Related Types
export interface MemberEntity {
	id: string;
	name: string;
	description?: string;
	hidden: boolean;
	activeBridge: boolean;
	address: string;
	nodeId?: string;
	authenticationExpiryTime: number;
	authorized: boolean;
	capabilities?: number[];
	creationTime: number;
	identity: string;
	ipAssignments: string[];
	lastAuthorizedCredential: null;
	lastAuthorizedCredentialType: string;
	lastAuthorizedTime: number;
	lastDeauthorizedTime: number;
	noAutoAssignIps: boolean;
	nwid: string;
	objtype: string;
	remoteTraceLevel: number;
	remoteTraceTarget: null;
	revision: number;
	ssoExempt: boolean;
	tags: NumberPairArray;
	peers: Peers | Record<string, never>;
	lastSeen?: number | string | Date | null;
	lastOnlineAt?: number | string | Date | null;
	lastOfflineAt?: number | string | Date | null;
	statusObservedAt?: number | string | Date | null;
	statusSource?: "controller" | "legacy" | "unavailable";
	online?: boolean;
	conStatus?: number;
	/** Connection path observed from the local Controller to this member. */
	connectionType?: ConnectionType;
	/** Last peer round-trip latency in milliseconds; null means unavailable. */
	latencyMs?: number | null;
	/** Bytes observed through a server relay during the selected report window. */
	relayBytesIn?: string;
	relayBytesOut?: string;
	relayBytesTotal?: string;
	relayPacketsIn?: string;
	relayPacketsOut?: string;
	relayLastRelayedAt?: number | null;
	relayConfidence?: "wire_observed" | null;
	relayByTransport?: Record<
		string,
		{
			bytesIn: string;
			bytesOut: string;
			bytesTotal: string;
			packetsIn: string;
			packetsOut: string;
		}
	>;
	vMajor: number;
	vMinor: number;
	vProto: number;
	vRev: number;
	action: null;
	notations?: NetworkMemberNotation[];
	physicalAddress?: string;
	accessorFn: () => void;
	config?: CentralMemberConfig;
	V6AssignMode?: V6AssignMode;
	stashed?: boolean;
}
type NumberPairArray = [number, number][];

interface CentralMemberConfig {
	activeBridge: boolean;
	address: string;
	authorized: boolean;
	capabilities: number[];
	creationTime: number;
	id: string;
	identity: string;
	ipAssignments: string[];
	lastAuthorizedTime: number;
	lastDeauthorizedTime: number;
	noAutoAssignIps: boolean;
	nwid: string;
	objtype: string;
	remoteTraceLevel: number;
	remoteTraceTarget: string;
	revision: number;
	tags: number[][];
	vMajor: number;
	vMinor: number;
	vRev: number;
	vProto: number;
	ssoExempt: boolean;
	description?: string;
}

export interface Peers {
	address: string;
	isBonded: boolean;
	latency: number;
	paths?: Paths[];
	role: string;
	version: string;
	physicalAddress?: string;
	versionMajor: number;
	versionMinor: number;
	versionRev: number;
	/** True when the Controller is currently using its TCP fallback tunnel. */
	tunneled?: boolean;
}

export type ConnectionType =
	| "offline"
	| "direct_lan"
	| "direct_wan"
	| "udp_relay"
	| "tcp_relay"
	| "relay"
	| "controller"
	| "unknown";

export interface Paths {
	active: boolean;
	address: string;
	expired: boolean;
	lastReceive: number;
	lastSend: number;
	localSocket?: number;
	preferred: boolean;
	trustedPathId: number;
}

export interface TagEnums {
	[key: string]: number;
}

export interface TagDetails {
	id: number;
	enums: TagEnums;
	flags: Record<number, number>;
	default: number | null;
}

export interface TagsByName {
	[tagName: string]: TagDetails;
}
export interface CapabilitiesByName {
	[key: string]: number;
}
export interface Tag {
	id: number;
	default: number;
	enums: TagEnums;
	flags: Record<string, number>;
}

// Notations
export interface NetworkMemberNotation {
	notationId: number;
	nodeid: number;
	label: Notation;
	member: MembersEntity;
}

export interface Notation {
	id: number;
	name: string;
	color?: string;
	description?: string;
	creationTime: Date;
	updatedTime: Date;
	isActive: boolean;
	nwid: string;
	network: NetworkEntity;
	networkMembers: NetworkMemberNotation[];
	icon?: string;
	orderIndex?: number;
	visibility?: string;
}

export interface MemberCounts {
	authorized: number;
	total: number;
	display: string;
}
