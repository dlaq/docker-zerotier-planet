import { useTranslations } from "next-intl";
import type { MemberEntity } from "~/types/local/member";
import { ConnectionStatus } from "../constants";
import { CONNECTION_TYPES } from "~/utils/memberConnection";

export const ConnectionStatusCell = ({
	original,
	central,
}: { original: MemberEntity; central: boolean }) => {
	const t = useTranslations("nodeObservation");
	const status = original.conStatus ?? ConnectionStatus.Unknown;
	if (central) {
		const seen = original.lastSeen ? new Date(original.lastSeen).getTime() : NaN;
		if (!Number.isFinite(seen))
			return <span className="text-sm opacity-60">{t("unknown")}</span>;
		return (
			<span
				className={
					seen >= Date.now() - 300000 ? "text-success text-sm" : "text-error text-sm"
				}
			>
				{t(seen >= Date.now() - 300000 ? "online" : "offline")}
			</span>
		);
	}
	const legacyType = {
		[ConnectionStatus.Offline]: CONNECTION_TYPES.Offline,
		[ConnectionStatus.Relayed]:
			original.peers && "tunneled" in original.peers
				? original.peers.tunneled
					? CONNECTION_TYPES.TcpRelay
					: CONNECTION_TYPES.Relay
				: CONNECTION_TYPES.Relay,
		[ConnectionStatus.DirectLAN]: CONNECTION_TYPES.DirectLAN,
		[ConnectionStatus.DirectWAN]: CONNECTION_TYPES.DirectWAN,
		[ConnectionStatus.Controller]: CONNECTION_TYPES.Controller,
		[ConnectionStatus.Unknown]: CONNECTION_TYPES.Unknown,
	} as const;
	const type =
		original.connectionType ??
		legacyType[status as ConnectionStatus] ??
		CONNECTION_TYPES.Unknown;
	const labels = {
		[CONNECTION_TYPES.Offline]: "offline",
		[CONNECTION_TYPES.Relay]: "relayed",
		[CONNECTION_TYPES.UdpRelay]: "udpRelay",
		[CONNECTION_TYPES.TcpRelay]: "tcpRelay",
		[CONNECTION_TYPES.DirectLAN]: "directLan",
		[CONNECTION_TYPES.DirectWAN]: "directWan",
		[CONNECTION_TYPES.Controller]: "controller",
		[CONNECTION_TYPES.Unknown]: "unknown",
	} as const;
	const label = labels[type] ?? labels[CONNECTION_TYPES.Unknown];
	const isRelay =
		type === CONNECTION_TYPES.Relay ||
		type === CONNECTION_TYPES.UdpRelay ||
		type === CONNECTION_TYPES.TcpRelay;
	return (
		<span
			className={`text-sm ${type === CONNECTION_TYPES.Offline ? "text-error" : type === CONNECTION_TYPES.Unknown ? "opacity-60" : isRelay ? "text-warning" : "text-success"}`}
			title={t(type === CONNECTION_TYPES.Unknown ? "unknownHelp" : "pathHelp")}
		>
			{t(label)}
			{(type === CONNECTION_TYPES.DirectLAN || type === CONNECTION_TYPES.DirectWAN) &&
			original.peers?.version &&
			original.peers.version !== "-1.-1.-1" ? (
				<small className="ml-1">v{original.peers.version}</small>
			) : null}
		</span>
	);
};
