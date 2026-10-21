import { ThemeProvider } from "@cueplusplus/ui/system";
import type { OrganizationProject, RoutingRule } from "@requestport/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { RoutingActionState } from "../app/(app)/settings/routing/routing-action-state.js";

/**
 * The routing forms are bound to real server actions, and the action module
 * reads the server environment at import time. The forms are what this suite is
 * about, so the actions are replaced by controllable ones.
 */
const actions = vi.hoisted(() => ({
  create: vi.fn(),
  disable: vi.fn(),
  test: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../app/(app)/settings/routing/actions.js", () => ({
  createRoutingRuleAction: actions.create,
  disableRoutingRuleAction: actions.disable,
  testRoutingRuleAction: actions.test,
  updateRoutingRuleAction: actions.update,
}));

import {
  CreateRoutingRuleForm,
  DisableRoutingRuleForm,
  RoutingTester,
  UpdateRoutingRuleForm,
} from "./routing-policy.js";

/**
 * Routing policy, driven the way an owner drives it.
 *
 * Each constraint axis is one named `CheckboxGroup` — a screen-reader user
 * hears "Request types" once rather than five unrelated toggles — and the
 * tester reports its answer as text plus a tone, never as colour alone.
 */

const idle: RoutingActionState = { status: "idle" };
const key = "web:fixture:00000000-0000-4000-8000-000000000001";

const projects: OrganizationProject[] = [
  {
    canRepresent: true,
    defaultRepository: null,
    id: "00000000-0000-4000-8000-0000000000c1",
    keyPrefix: "PLT",
    name: "Platform",
    slug: "platform",
    status: "active",
  },
  {
    canRepresent: true,
    defaultRepository: null,
    id: "00000000-0000-4000-8000-0000000000c2",
    keyPrefix: "DOC",
    name: "Docs",
    slug: "docs",
    status: "active",
  },
];

const lanes = [{ id: "00000000-0000-4000-8000-0000000000e1", name: "release" }];
const agents = [
  { displayName: "Claude Code", id: "00000000-0000-4000-8000-0000000000a1" },
];

const rule: RoutingRule = {
  agentPrincipalIds: [],
  decision: "allow",
  enabled: true,
  humanRoles: ["owner"],
  id: "00000000-0000-4000-8000-000000000301",
  laneIds: [],
  organizationId: "00000000-0000-4000-8000-0000000000d1",
  priorities: [],
  requestTypes: ["bug"],
  sourceKind: "project",
  sourceProjectId: projects[0].id,
  specificity: 2,
  targetProjectId: projects[1].id,
  version: 3,
};

function mount(node: ReactNode) {
  return render(
    <ThemeProvider
      density="ultra-compact"
      mode="system"
      persistPreferences={false}
      theme="requestport"
    >
      {node}
    </ThemeProvider>,
  );
}

function submitted(action: { mock: { calls: unknown[][] } }) {
  const data = action.mock.calls.at(-1)?.[1] as FormData | undefined;
  if (!data) throw new Error("the action was never invoked");

  return data;
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: string,
  option: RegExp | string,
) {
  await user.click(screen.getByRole("combobox", { name: control }));
  await user.click(
    within(await screen.findByRole("listbox")).getByRole("option", {
      name: option,
    }),
  );
}

beforeEach(() => {
  for (const action of Object.values(actions)) {
    action.mockReset();
    action.mockResolvedValue(idle);
  }
});

describe("adding a rule", () => {
  test("names every axis as one group rather than a pile of toggles", () => {
    mount(
      <CreateRoutingRuleForm
        agents={agents}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    for (const group of [
      "Request types",
      "Priorities",
      "Human roles",
      "Lanes",
      "Agent principals",
    ]) {
      expect(screen.getByRole("group", { name: group })).toBeInTheDocument();
    }
    for (const control of ["Source", "Target", "Decision"]) {
      expect(
        screen.getByRole("combobox", { name: control }),
      ).toBeInTheDocument();
    }
  });

  test("submits the chosen route, decision, and constraints", async () => {
    const user = userEvent.setup();
    mount(
      <CreateRoutingRuleForm
        agents={agents}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    await choose(user, "Source", "Platform");
    await choose(user, "Target", "Docs");
    await choose(user, "Decision", "Deny");
    await user.click(
      within(screen.getByRole("group", { name: "Request types" })).getByRole(
        "checkbox",
        { name: "bug" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(actions.create).toHaveBeenCalled());
    const data = submitted(actions.create);
    expect(data.get("sourceProjectId")).toBe(projects[0].id);
    expect(data.get("targetProjectId")).toBe(projects[1].id);
    expect(data.get("decision")).toBe("deny");
    expect(data.get("idempotencyKey")).toBe(key);
    expect(data.getAll("requestTypes")).toEqual(["bug"]);
  });

  test("reports a rejected rule as text beside the controls", async () => {
    const user = userEvent.setup();
    actions.create.mockResolvedValue({
      message: "The most specific matching rule already denies this route.",
      status: "error",
    } satisfies RoutingActionState);
    mount(
      <CreateRoutingRuleForm
        agents={agents}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
      />,
    );

    await choose(user, "Target", "Docs");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The most specific matching rule already denies this route.",
    );
  });
});

describe("editing and disabling a rule", () => {
  test("keeps the editor folded away until it is asked for", async () => {
    const user = userEvent.setup();
    mount(
      <UpdateRoutingRuleForm
        agents={agents}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
        rule={rule}
      />,
    );

    expect(screen.queryByRole("button", { name: "Save rule" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("button", { name: "Save rule" }),
    ).toBeInTheDocument();
  });

  test("opens the editor already holding the rule's own constraints", async () => {
    const user = userEvent.setup();
    mount(
      <UpdateRoutingRuleForm
        agents={agents}
        idempotencyKey={key}
        lanes={lanes}
        projects={projects}
        rule={rule}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      within(screen.getByRole("group", { name: "Request types" })).getByRole(
        "checkbox",
        { name: "bug" },
      ),
    ).toBeChecked();
    expect(
      within(screen.getByRole("group", { name: "Human roles" })).getByRole(
        "checkbox",
        { name: "owner" },
      ),
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(actions.update).toHaveBeenCalled());
    const data = submitted(actions.update);
    expect(data.get("ruleId")).toBe(rule.id);
    expect(data.get("expectedVersion")).toBe("3");
  });

  test("arms before it disables a rule, and says so once one is disabled", async () => {
    const user = userEvent.setup();
    const enabled = mount(
      <DisableRoutingRuleForm idempotencyKey={key} rule={rule} />,
    );

    await user.click(screen.getByRole("button", { name: "Disable rule" }));
    expect(actions.disable).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(actions.disable).toHaveBeenCalled());
    expect(submitted(actions.disable).get("expectedVersion")).toBe("3");

    enabled.unmount();
    mount(
      <DisableRoutingRuleForm
        idempotencyKey={key}
        rule={{ ...rule, enabled: false }}
      />,
    );
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("testing a route", () => {
  test("names each toolbar control without a visible field of its own", () => {
    mount(<RoutingTester agents={agents} lanes={lanes} projects={projects} />);

    for (const control of [
      "Source",
      "Target",
      "Request type",
      "Priority",
      "Lane",
      "Principal",
    ]) {
      expect(
        screen.getByRole("combobox", { name: control }),
      ).toBeInTheDocument();
    }
  });

  test("reports an allowed decision as text, not colour alone", async () => {
    const user = userEvent.setup();
    actions.test.mockResolvedValue({
      allowed: true,
      message: "Allowed by rule specificity 2.",
      status: "decision",
    } satisfies RoutingActionState);
    mount(<RoutingTester agents={agents} lanes={lanes} projects={projects} />);

    await choose(user, "Target", "Docs");
    await user.click(screen.getByRole("button", { name: "Test route" }));

    const answer = await screen.findByRole("status");
    expect(answer).toHaveTextContent("Allowed");
    expect(answer).toHaveTextContent("Allowed by rule specificity 2.");
  });

  test("reports a denied decision as a failure a reader can read", async () => {
    const user = userEvent.setup();
    actions.test.mockResolvedValue({
      allowed: false,
      message: "Denied: no rule allows this route.",
      status: "decision",
    } satisfies RoutingActionState);
    mount(<RoutingTester agents={agents} lanes={lanes} projects={projects} />);

    await choose(user, "Target", "Docs");
    await user.click(screen.getByRole("button", { name: "Test route" }));

    const answer = await screen.findByRole("alert");
    expect(answer).toHaveTextContent("Denied");
    expect(answer).toHaveTextContent("Denied: no rule allows this route.");
  });
});
