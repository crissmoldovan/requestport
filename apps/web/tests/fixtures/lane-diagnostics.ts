import type { Page } from "@playwright/test";

import { isContentSecurityRefusal } from "./console-refusals.js";

/**
 * What a lane records about the document while it drives it.
 *
 * The lanes run against `next dev`, and the development server can reload the
 * document out from under a case: it compiles a route on demand, announces the
 * new compilation to every open document, and a document that cannot apply the
 * announcement reloads itself. Run 33428794819 lost two different steps of one
 * case that way and said so only obliquely — six "Fast Refresh had to perform a
 * full reload" lines in the server's own output, with nothing tying any of them
 * to the step that failed.
 *
 * Tying those together is all this module does. It adds no behaviour and
 * changes no timing: every listener here is an observer, and the document runs
 * exactly as it would with none of them attached. That matters more than usual
 * here, because the previous attempt to *prevent* the reload — mocking the
 * development server's socket — perturbed the document badly enough to fail
 * sixteen appearance cases that pass without it.
 *
 * It is off unless asked for. A lane that printed every console line of every
 * case would bury the run it was meant to explain.
 */
export function laneDiagnosticsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.REQUESTPORT_E2E_DIAGNOSTICS === "1";
}

/** One line, stamped so it can be read against the server's own output. */
export function diagnosticLine(kind: string, detail: string): string {
  return `[lane-diagnostic ${new Date().toISOString()}] ${kind}: ${detail}`;
}

/**
 * Watch one document, and say what happened to it.
 *
 * The load of the main frame is the signal worth having: the lane navigates
 * deliberately and knows when it does, so a load it did not ask for is the
 * development server reloading the document, and its timestamp is what places
 * that reload against the step that failed.
 */
export function attachLaneDiagnostics(
  page: Page,
  write: (line: string) => void = console.log,
  enabled: boolean = laneDiagnosticsEnabled(),
): void {
  if (!enabled) return;

  // The nonce policy refuses the styles the development server injects, and it
  // does so thousands of times in a lane — 5,607 in one local run. They are
  // already kept apart from errors by `collectConsole`, so they are counted
  // here rather than repeated: a total says the same thing in one line, and
  // dropping them silently would be the one thing a diagnostic must not do.
  let refusals = 0;

  page.on("load", () => {
    write(diagnosticLine("load", page.url()));
  });
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const text = message.text();
    if (isContentSecurityRefusal(text)) {
      refusals += 1;
      return;
    }
    write(diagnosticLine(`console:${type}`, text));
  });
  page.on("pageerror", (error) => {
    write(diagnosticLine("pageerror", error.message));
  });
  // The console says a request failed and refuses to say which: WebKit writes
  // `Failed to load resource: the server responded with a status of 400 (Bad
  // Request)` and names no address. CI run 33501577109 lost its whole WebKit
  // lane behind two of those — the tenant its first case builds was never
  // created, and nothing said which request had been turned down. The response
  // carries what the console drops, so it is read from there instead.
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    write(
      diagnosticLine(
        `response:${status}`,
        `${response.request().method()} ${response.url()}`,
      ),
    );
  });
  page.on("close", () => {
    if (refusals > 0) {
      write(diagnosticLine("content-security-refusals", String(refusals)));
    }
  });
}
