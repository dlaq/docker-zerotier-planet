export interface MemberObservation {
	observed: boolean;
	online: boolean;
	lastSeen: number;
	lastOnline: number;
}
export interface MemberStatusSnapshot {
	clock: number;
	controllerStartedAt: number;
	onlineWindowMs: number;
	members: Record<string, MemberObservation>;
}
