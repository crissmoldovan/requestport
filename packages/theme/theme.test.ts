import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { assertManifest, COLOR_CONTRACT } from "@cueplusplus/theme-base";
import { contrastRatio, WCAG_AA_TEXT } from "@cueplusplus/theme-base/contrast";
import { describe, expect, test } from "vitest";

import manifest from "./manifest.json" with { type: "json" };

const stylesheet = readFileSync(
  new URL("./theme.css", import.meta.url),
  "utf8",
);

describe("the RequestPort theme", () => {
  test("is a manifest the CUE++ runtime accepts", () => {
    // The same assertion `ThemeProvider` runs on every registered manifest
    // outside production. A theme this repository generates has to clear the
    // contract the design system publishes, exactly as a package from the
    // registry did.
    expect(() => {
      assertManifest(manifest);
    }).not.toThrow();
    expect(manifest.name).toBe("requestport");
    expect(manifest.package).toBe("@requestport/theme");
  });

  test("declares every contract colour in both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      const block = manifest.colors[mode] as Record<string, string>;
      expect(Object.keys(block).sort()).toEqual([...COLOR_CONTRACT].sort());
    }
  });

  test("clears the contrast contract with nothing waived", () => {
    // `waived > 0` would mean a pair below its ratio that somebody excused.
    // The palette passes outright, and the digest is what the generator
    // measured; `is generated from its own sources` below re-derives it.
    expect(manifest.contrast.passes).toBe(true);
    expect(manifest.contrast.waived).toBe(0);
    expect(manifest.contrast.digest).toMatch(/^sha256-[0-9a-f]{64}$/u);
  });

  test("keeps fg-subtle above AA, which the design system never checked", () => {
    // The gate that generated this theme cannot see this defect. CUE++'s
    // CONTRAST_REQUIREMENTS is twenty pairs — eleven required, nine advisory —
    // and not one of them names `fg-subtle`. That is how the colour shipped at
    // 4.11 in light and 4.475 in dark, passing every check upstream, until
    // cue-ui#117 measured it by hand. So this measures it here, every run.
    for (const mode of ["dark", "light"] as const) {
      const block = manifest.colors[mode] as Record<string, string>;
      const ratio = contrastRatio(
        block["fg-subtle"] ?? "",
        block["surface-3"] ?? "",
      );

      expect(
        { mode, passes: ratio >= WCAG_AA_TEXT },
        `fg-subtle on surface-3 in ${mode} is ${ratio.toFixed(2)}:1`,
      ).toEqual({ mode, passes: true });
    }
  });

  test("carries the corrected values that cue-ui#117 measured", () => {
    // The two colours that were below WCAG AA, and the accent's ring and wash
    // that had to move with it. Pinned by value because this palette left the
    // design system before the fix could be published: nothing upstream will
    // fail if they regress.
    for (const corrected of [
      "--cue-fg-subtle: #5b6165",
      "--cue-accent: #a14026",
      "--cue-focus: #a14026",
      "--cue-selection: rgba(161,64,38,0.18)",
      "--cue-fg-subtle: #83888c",
    ]) {
      expect(stylesheet).toContain(corrected);
    }
    for (const belowAa of ["#62696d", "#b8492b", "#81868a"]) {
      expect(stylesheet).not.toContain(belowAa);
    }
  });

  test("is generated from its own sources, and is up to date", () => {
    // `cue-theme check` rebuilds all five artefacts in memory from the two
    // DTCG files and byte-compares them against what is committed, re-running
    // the contrast measurement on the way. An edited stylesheet, a stale
    // manifest or a palette that drifts below AA all fail here, offline.
    const checked = spawnSync("cue-theme", ["check"], {
      cwd: new URL(".", import.meta.url).pathname,
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        PATH: `${new URL("./node_modules/.bin", import.meta.url).pathname}:${process.env.PATH ?? ""}`,
      },
    });

    expect(
      { status: checked.status, output: `${checked.stdout}${checked.stderr}` },
      "run `pnpm --filter @requestport/theme run theme:generate`",
    ).toEqual({
      status: 0,
      output: `${checked.stdout}${checked.stderr}`,
    });
    expect(`${checked.stdout}${checked.stderr}`).toContain("up to date");
    // 30s, not Vitest's default 5s: this spawns a process that rebuilds five
    // artefacts, and on a loaded host (load average 18 rising to 86) it took
    // 6,374ms and failed the gate on the timeout, not on the theme. 30s is the
    // budget the database suites and apps/web already use.
  }, 30_000);
});
