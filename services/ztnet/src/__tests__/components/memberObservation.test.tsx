import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "~/locales/en/common.json";
import { MemberTimeCell } from "~/components/networkByIdPage/table/members/cells/MemberTimeCell";
import { ConnectionStatusCell } from "~/components/networkByIdPage/table/members/cells/ConnectionStatusCell";
import type { MemberEntity } from "~/types/local/member";
const wrap = (child: React.ReactNode) =>
	render(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			{child}
		</NextIntlClientProvider>,
	);
test("missing timestamps display a dash instead of Invalid Date or a fabricated relative time", () => {
	wrap(<MemberTimeCell original={{} as MemberEntity} field="lastOnlineAt" />);
	expect(screen.getByText("—")).toBeInTheDocument();
});
test("known online timestamp is rendered with an ISO machine-readable value", () => {
	const { container } = wrap(
		<MemberTimeCell
			original={{ lastOnlineAt: "2026-09-12T12:00:00Z" } as MemberEntity}
			field="lastOnlineAt"
		/>,
	);
	expect(container.querySelector("time")).toHaveAttribute(
		"datetime",
		"2026-09-12T12:00:00.000Z",
	);
});
test("unknown collection state is explicit and does not display offline", () => {
	wrap(
		<ConnectionStatusCell original={{ conStatus: 5 } as MemberEntity} central={false} />,
	);
	expect(screen.getByText("Unknown")).toBeInTheDocument();
	expect(screen.queryByText("Offline")).toBeNull();
});
