import { useTranslations } from "next-intl";
import type { MemberEntity } from "~/types/local/member";
import { ConnectionStatus } from "../constants";

export const ConnectionStatusCell = ({
	original,
	central,
}: { original: MemberEntity; central: boolean }) => {
	const t = useTranslations("nodeObservation");
	let status = original.conStatus ?? ConnectionStatus.Unknown;
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
	const labels = {
		[ConnectionStatus.Offline]: "offline",
		[ConnectionStatus.Relayed]: "relayed",
		[ConnectionStatus.DirectLAN]: "directLan",
		[ConnectionStatus.DirectWAN]: "directWan",
		[ConnectionStatus.Controller]: "controller",
		[ConnectionStatus.Unknown]: "unknown",
	} as const;
	if (!(status in labels)) status = ConnectionStatus.Unknown;
	const label = labels[status as ConnectionStatus];
	return (
		<span
			className={`text-sm ${status === ConnectionStatus.Offline ? "text-error" : status === ConnectionStatus.Unknown ? "opacity-60" : status === ConnectionStatus.Relayed ? "text-warning" : "text-success"}`}
			title={t(status === ConnectionStatus.Unknown ? "unknownHelp" : "pathHelp")}
		>
			{t(label)}
			{(status === ConnectionStatus.DirectLAN || status === ConnectionStatus.DirectWAN) &&
			original.peers?.version &&
			original.peers.version !== "-1.-1.-1" ? (
				<small className="ml-1">v{original.peers.version}</small>
			) : null}
		</span>
	);
};
