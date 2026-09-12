import { useLocale, useTranslations } from "next-intl";
import type { MemberEntity } from "~/types/local/member";

export const MemberTimeCell = ({
	original,
	field,
}: { original: MemberEntity; field: "lastSeen" | "lastOnlineAt" }) => {
	const locale = useLocale();
	const t = useTranslations("nodeObservation");
	const value = original[field];
	const date = value ? new Date(value) : null;
	if (!date || !Number.isFinite(date.getTime()))
		return (
			<span className="text-sm opacity-60" title={t("noHistory")}>
				—
			</span>
		);
	return (
		<time
			className="whitespace-nowrap text-xs"
			dateTime={date.toISOString()}
			title={t(field === "lastSeen" ? "lastSeenHelp" : "lastOnlineHelp")}
		>
			{new Intl.DateTimeFormat(locale, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			}).format(date)}
		</time>
	);
};
