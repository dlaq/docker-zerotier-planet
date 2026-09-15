import { useTranslations } from "next-intl";
import type { MemberEntity } from "~/types/local/member";
import { normalizePeerLatency } from "~/utils/memberConnection";

export const LatencyCell = ({ original }: { original: MemberEntity }) => {
	const t = useTranslations("nodeObservation");
	const fromPeer =
		original.peers && "latency" in original.peers
			? normalizePeerLatency(original.peers.latency)
			: null;
	const latency =
		typeof original.latencyMs === "number" && original.latencyMs >= 0
			? original.latencyMs
			: fromPeer;

	if (latency === null || latency === undefined) {
		return (
			<span className="text-sm opacity-60" title={t("latencyUnavailable")}>
				—
			</span>
		);
	}

	return (
		<span className="whitespace-nowrap text-sm" title={t("latencyHelp")}>
			{Math.round(latency)} ms
		</span>
	);
};
