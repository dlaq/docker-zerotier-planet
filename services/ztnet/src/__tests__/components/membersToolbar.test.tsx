import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NextIntlClientProvider } from "next-intl";
import enTranslation from "~/locales/en/common.json";
import { MembersToolbar } from "~/components/networkByIdPage/table/members/components/MembersToolbar";

describe("MembersToolbar", () => {
	test("exposes the member activity and connection filters", () => {
		const onMemberFilterChange = jest.fn();
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<MembersToolbar
					globalFilter=""
					onGlobalFilterChange={jest.fn()}
					memberFilter="all"
					onMemberFilterChange={onMemberFilterChange}
					showExtendedView={false}
					onToggleExtendedView={jest.fn()}
				/>
			</NextIntlClientProvider>,
		);

		const select = screen.getByRole("combobox", { name: "Filter members" });
		expect(select.querySelectorAll("option")).toHaveLength(28);
		fireEvent.change(select, { target: { value: "online_7d" } });
		expect(onMemberFilterChange).toHaveBeenCalledWith("online_7d");
	});
});
