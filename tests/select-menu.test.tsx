import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import SelectMenu from "../src/components/SelectMenu";

it("filters a searchable model list without rendering unrelated options", async () => {
  const user = userEvent.setup();
  const options = Array.from({ length: 193 }, (_, index) => ({
    value: `model-${index}`,
    label: index === 87 ? "Claude Opus 5" : `Cursor model ${index}`,
  }));
  const onChange = vi.fn()
  render(
    <SelectMenu
      ariaLabel="Model for Cursor Agent"
      value="model-0"
      options={options}
      searchable
      onChange={onChange}
    />,
  );

  await user.click(screen.getByRole("button", { name: /model for cursor agent/i }));
  const search = screen.getByRole("combobox", { name: /search models/i });
  await user.type(search, "opus");

  expect(screen.getByRole("option", { name: "Claude Opus 5" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Cursor model 0" })).not.toBeInTheDocument();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith("model-87");
});
