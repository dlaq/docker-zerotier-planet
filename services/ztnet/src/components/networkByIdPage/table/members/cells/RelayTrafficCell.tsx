import { useTranslations } from "next-intl";
import type { MemberEntity } from "~/types/local/member";

const asBytes = (value: unknown): bigint => {
	if (typeof value === "bigint") return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		return BigInt(value);
	return BigInt(0);
};

const formatBytes = (value: bigint): string => {
	if (value < BigInt(1024)) return `${value} B`;
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let amount = Number(value);
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit += 1;
	}
	return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
};

export const RelayTrafficCell = ({ original }: { original: MemberEntity }) => {
	const t = useTranslations("nodeObservation");
	const total = asBytes(original.relayBytesTotal);
	const incoming = asBytes(original.relayBytesIn);
	const outgoing = asBytes(original.relayBytesOut);
	const hasTraffic = total > BigInt(0);
	const last = original.relayLastRelayedAt;
	const lastText =
		typeof last === "number" && last > 0 ? new Date(last).toLocaleString() : "";
	const title = hasTraffic
		? `${t("relayTrafficHelp")} ${t("relayIn")}: ${formatBytes(incoming)}, ${t("relayOut")}: ${formatBytes(outgoing)}${lastText ? `; ${t("lastRelayed")}: ${lastText}` : ""}`
		: t("relayTrafficUnavailable");
	return (
		<span className="whitespace-nowrap text-sm" title={title}>
			{hasTraffic ? formatBytes(total) : "—"}
		</span>
	);
};
