import { Button } from "@cueplusplus/ui/primitives";
import { ThemeProvider } from "@cueplusplus/ui/system";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { RequestWorkbenchShell } from "./request-workbench-shell.js";

/**
 * `react-resizable-panels` sizes the seam from the panes' laid-out boxes, and
 * jsdom lays nothing out: every offset is `0`, so the group never commits a
 * first layout and the arrow keys land on an empty one. These two properties
 * are the whole measurement it needs, and stubbing them is what lets the
 * keyboard contract be exercised here rather than only in the browser matrix.
 */
const laidOut = ["offsetWidth", "offsetHeight"] as const;
const original = laidOut.map(
  (property) =>
    [
      property,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, property),
    ] as const,
);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 1000,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => {
  for (const [property, descriptor] of original) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, property, descriptor);
    }
  }
});

function renderWorkbench(hasDetail = true) {
  return render(
    <ThemeProvider persistPreferences={false} theme="requestport">
      <RequestWorkbenchShell
        detail={<p>Selected request</p>}
        hasDetail={hasDetail}
        list={<Button type="button">RP-1</Button>}
      />
    </ThemeProvider>,
  );
}

describe("workbench seam", () => {
  test("exposes one keyboard-operable separator between the two regions", async () => {
    const user = userEvent.setup();
    renderWorkbench();

    const seam = screen.getByRole("separator");

    expect(seam).toHaveAttribute("aria-orientation", "vertical");

    seam.focus();

    expect(seam).toHaveFocus();

    await user.keyboard("{ArrowLeft}{ArrowRight}{Home}{End}");

    expect(screen.getByRole("separator")).toHaveFocus();
    expect(
      screen.getByRole("region", { name: "Request list" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Selected request" }),
    ).toBeInTheDocument();
  });

  test("keeps the list reachable when nothing is selected", () => {
    renderWorkbench(false);

    expect(screen.getByRole("button", { name: "RP-1" })).toBeInTheDocument();
    expect(screen.getByText("No request selected")).toBeInTheDocument();
  });
});
