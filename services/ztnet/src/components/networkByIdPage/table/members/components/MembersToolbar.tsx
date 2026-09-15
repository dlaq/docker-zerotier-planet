import { useTranslations } from "next-intl";
import { DebouncedInput } from "~/components/elements/debouncedInput";
import { isMemberFilter, type MemberFilter } from "~/utils/memberFilter";

interface Props {
	globalFilter: string;
	onGlobalFilterChange: (value: string) => void;
	memberFilter: MemberFilter;
	onMemberFilterChange: (value: MemberFilter) => void;
	showExtendedView: boolean;
	onToggleExtendedView: () => void;
	relayWindow: "1h" | "24h" | "7d" | "30d" | "all";
	onRelayWindowChange: (value: Props["relayWindow"]) => void;
}

/**
 * Members table toolbar: global search, activity/status filters, and the
 * compact/extended view toggle (extended view reveals the description column).
 */
export const MembersToolbar = ({
	globalFilter,
	onGlobalFilterChange,
	memberFilter,
	onMemberFilterChange,
	showExtendedView,
	onToggleExtendedView,
	relayWindow,
	onRelayWindowChange,
}: Props) => {
	const t = useTranslations("networkById");
	const toggleLabel = showExtendedView
		? t("networkMembersTable.toggles.hideExtendedView")
		: t("networkMembersTable.toggles.showExtendedView");

	return (
		<div className="flex flex-wrap items-center gap-2 py-2">
			<DebouncedInput
				value={globalFilter ?? ""}
				onChange={(value) => onGlobalFilterChange(String(value))}
				className="font-lg border-block min-w-[12rem] flex-1 border p-2 shadow"
				placeholder={t("networkMembersTable.search.placeholder")}
			/>
			<select
				value={memberFilter}
				onChange={(event) => {
					const value = event.target.value;
					if (isMemberFilter(value)) onMemberFilterChange(value);
				}}
				className="select select-sm min-w-[12rem] border-base-content/30"
				aria-label={t("networkMembersTable.filters.label")}
				title={t("networkMembersTable.filters.label")}
			>
				<option value="all">{t("networkMembersTable.filters.options.all")}</option>
				<optgroup label={t("networkMembersTable.filters.groups.current")}>
					<option value="online">
						{t("networkMembersTable.filters.options.online")}
					</option>
					<option value="offline">
						{t("networkMembersTable.filters.options.offline")}
					</option>
				</optgroup>
				<optgroup label={t("networkMembersTable.filters.groups.online")}>
					<option value="online_15m">
						{t("networkMembersTable.filters.options.online_15m")}
					</option>
					<option value="online_1h">
						{t("networkMembersTable.filters.options.online_1h")}
					</option>
					<option value="online_6h">
						{t("networkMembersTable.filters.options.online_6h")}
					</option>
					<option value="online_24h">
						{t("networkMembersTable.filters.options.online_24h")}
					</option>
					<option value="online_3d">
						{t("networkMembersTable.filters.options.online_3d")}
					</option>
					<option value="online_7d">
						{t("networkMembersTable.filters.options.online_7d")}
					</option>
					<option value="online_30d">
						{t("networkMembersTable.filters.options.online_30d")}
					</option>
					<option value="online_90d">
						{t("networkMembersTable.filters.options.online_90d")}
					</option>
					<option value="online_180d">
						{t("networkMembersTable.filters.options.online_180d")}
					</option>
					<option value="online_365d">
						{t("networkMembersTable.filters.options.online_365d")}
					</option>
					<option value="never_online">
						{t("networkMembersTable.filters.options.never_online")}
					</option>
				</optgroup>
				<optgroup label={t("networkMembersTable.filters.groups.seen")}>
					<option value="seen_15m">
						{t("networkMembersTable.filters.options.seen_15m")}
					</option>
					<option value="seen_1h">
						{t("networkMembersTable.filters.options.seen_1h")}
					</option>
					<option value="seen_6h">
						{t("networkMembersTable.filters.options.seen_6h")}
					</option>
					<option value="seen_24h">
						{t("networkMembersTable.filters.options.seen_24h")}
					</option>
					<option value="seen_7d">
						{t("networkMembersTable.filters.options.seen_7d")}
					</option>
					<option value="seen_30d">
						{t("networkMembersTable.filters.options.seen_30d")}
					</option>
					<option value="never_seen">
						{t("networkMembersTable.filters.options.never_seen")}
					</option>
				</optgroup>
				<optgroup label={t("networkMembersTable.filters.groups.authorization")}>
					<option value="authorized">
						{t("networkMembersTable.filters.options.authorized")}
					</option>
					<option value="unauthorized">
						{t("networkMembersTable.filters.options.unauthorized")}
					</option>
				</optgroup>
				<optgroup label={t("networkMembersTable.filters.groups.connection")}>
					<option value="direct_lan">
						{t("networkMembersTable.filters.options.direct_lan")}
					</option>
					<option value="direct_wan">
						{t("networkMembersTable.filters.options.direct_wan")}
					</option>
					<option value="relayed">
						{t("networkMembersTable.filters.options.relayed")}
					</option>
					<option value="controller">
						{t("networkMembersTable.filters.options.controller")}
					</option>
					<option value="unknown_connection">
						{t("networkMembersTable.filters.options.unknown_connection")}
					</option>
				</optgroup>
			</select>
			<select
				value={relayWindow}
				onChange={(event) => {
					const value = event.target.value;
					if (["1h", "24h", "7d", "30d", "all"].includes(value))
						onRelayWindowChange(value as Props["relayWindow"]);
				}}
				className="select select-sm min-w-[8rem] border-base-content/30"
				aria-label={t("networkMembersTable.relayWindow.label")}
				title={t("networkMembersTable.relayWindow.help")}
			>
				<option value="1h">{t("networkMembersTable.relayWindow.options.1h")}</option>
				<option value="24h">{t("networkMembersTable.relayWindow.options.24h")}</option>
				<option value="7d">{t("networkMembersTable.relayWindow.options.7d")}</option>
				<option value="30d">{t("networkMembersTable.relayWindow.options.30d")}</option>
				<option value="all">{t("networkMembersTable.relayWindow.options.all")}</option>
			</select>
			<button
				onClick={onToggleExtendedView}
				className={`btn btn-sm ${showExtendedView ? "btn-primary" : "btn-outline"}`}
				title={toggleLabel}
				aria-label={toggleLabel}
			>
				{showExtendedView ? (
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						strokeWidth={1.5}
						stroke="currentColor"
						className="w-4 h-4"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25"
						/>
					</svg>
				) : (
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						strokeWidth={1.5}
						stroke="currentColor"
						className="w-4 h-4"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
						/>
					</svg>
				)}
			</button>
		</div>
	);
};
