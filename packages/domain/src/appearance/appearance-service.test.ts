import { describe, expect, test } from "vitest";
import { resolveAppearanceSnapshot } from "./appearance-service.js";
import {
  type AppearanceDensity,
  type AppearanceMode,
  type AppearanceSource,
  type AppearanceTheme,
  appearanceFallback,
} from "./appearance-types.js";

const organizationTriple = {
  theme: "cue" as AppearanceTheme,
  density: "normal" as AppearanceDensity,
  mode: "dark" as AppearanceMode,
};
const userTriple = {
  theme: "venu" as AppearanceTheme,
  density: "large" as AppearanceDensity,
  mode: "light" as AppearanceMode,
};

type AxisState = "user" | "organization" | "fallback";
const axisStates: AxisState[] = ["user", "organization", "fallback"];

describe("appearance resolution", () => {
  test("resolves all 27 per-axis inheritance combinations independently", () => {
    let combinations = 0;

    for (const themeState of axisStates) {
      for (const densityState of axisStates) {
        for (const modeState of axisStates) {
          const states = {
            theme: themeState,
            density: densityState,
            mode: modeState,
          } as const;
          // "fallback" for one axis means neither the personal override nor the
          // organization default supplies it. Because the organization row is
          // required once an owner exists, the only way a single axis falls back
          // while another inherits the organization is an absent organization
          // row — so the fallback cases are modelled with no organization row at
          // all and are asserted per axis rather than per document.
          const organizationPresent = Object.values(states).some(
            (state) => state === "organization",
          );
          const snapshot = resolveAppearanceSnapshot({
            user: {
              version: 3,
              theme: themeState === "user" ? userTriple.theme : null,
              density: densityState === "user" ? userTriple.density : null,
              mode: modeState === "user" ? userTriple.mode : null,
            },
            organization: organizationPresent
              ? { ...organizationTriple, version: 5 }
              : null,
          });

          for (const axis of ["theme", "density", "mode"] as const) {
            const state = states[axis];
            const expectedSource: AppearanceSource =
              state === "user"
                ? "user"
                : organizationPresent
                  ? "organization"
                  : "fallback";
            const expectedValue =
              state === "user"
                ? userTriple[axis]
                : organizationPresent
                  ? organizationTriple[axis]
                  : appearanceFallback[axis];

            expect(
              snapshot.effective.source[axis],
              `${axis}:${state}:${organizationPresent}`,
            ).toBe(expectedSource);
            expect(
              snapshot.effective[axis],
              `${axis}:${state}:${organizationPresent}`,
            ).toBe(expectedValue);
          }
          combinations += 1;
        }
      }
    }

    expect(combinations).toBe(27);
  });

  test("reports version zero and full inheritance for an absent personal row", () => {
    const snapshot = resolveAppearanceSnapshot({
      user: null,
      organization: { ...organizationTriple, version: 9 },
    });

    expect(snapshot.user).toEqual({
      theme: null,
      density: null,
      mode: null,
      version: 0,
    });
    expect(snapshot.organization).toEqual({
      ...organizationTriple,
      version: 9,
    });
    expect(snapshot.effective).toEqual({
      ...organizationTriple,
      source: {
        theme: "organization",
        density: "organization",
        mode: "organization",
      },
    });
  });

  test("reports the fixed fallback at version zero without an organization row", () => {
    const snapshot = resolveAppearanceSnapshot({
      user: null,
      organization: null,
    });

    expect(snapshot.organization).toEqual({
      ...appearanceFallback,
      version: 0,
    });
    expect(snapshot.effective).toEqual({
      ...appearanceFallback,
      source: { theme: "fallback", density: "fallback", mode: "fallback" },
    });
  });

  test("drops malformed stored values per axis instead of the whole document", () => {
    const snapshot = resolveAppearanceSnapshot({
      user: {
        version: 2,
        theme: "midnight",
        density: "large",
        mode: "auto",
      } as never,
      organization: {
        version: 4,
        theme: "signal",
        density: "cosy",
        mode: "light",
      } as never,
    });

    expect(snapshot.user).toEqual({
      theme: null,
      density: "large",
      mode: null,
      version: 2,
    });
    expect(snapshot.organization).toEqual({
      theme: "signal",
      density: appearanceFallback.density,
      mode: "light",
      version: 4,
    });
    expect(snapshot.effective).toEqual({
      theme: "signal",
      density: "large",
      mode: "light",
      source: {
        theme: "organization",
        density: "user",
        mode: "organization",
      },
    });
  });

  test("rejects a negative or non-integer stored version by clamping to zero", () => {
    const snapshot = resolveAppearanceSnapshot({
      user: { version: -3, theme: null, density: null, mode: null },
      organization: { ...organizationTriple, version: 1.5 },
    });

    expect(snapshot.user.version).toBe(0);
    expect(snapshot.organization.version).toBe(0);
  });
});
