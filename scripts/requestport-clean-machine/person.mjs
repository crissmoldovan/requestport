#!/usr/bin/env node
/*
  H.8's person (manifest-h.md §5, Done when 14; ruling 198 item 6): the owner
  of a self-hosted instance, driven by Playwright in Chromium and in WebKit.
  It is run only in H.8's driver container, which shares the clean
  container's network namespace, so its 127.0.0.1 is the clean container's:
  the public URL `start` printed, and the callback `login` listens on. The
  unit file imports its functions on the host and gives `serve` stand-ins for
  the browsers; no browser starts there.

  Usage, in the driver container: node /harness/person.mjs

  It reads one JSON object per line on standard input and answers each, in
  order, with one JSON line on standard output: `{ id, ok: true, browser,
  browserVersion, result, serverErrors }`, or `{ id, ok: false, browser, step,
  error }`, whose `error` begins `<browser>: <step>:`. The step is the
  command's name, or `launch` when the browser does not start; a line that is
  not a command is answered with the step `protocol`, no browser, and an
  `error` that begins `person: protocol:`. Before the first answer it writes
  `{ ready: { node, playwrightCore } }`. It keeps one browser, one context and
  one page per browser for its whole life, made at that browser's first
  command, so a sign-in holds for every command after it.

  The commands (`id` on each; `browser`, "chromium" or "webkit", on each but
  `close`):
  - `signIn` { base, email, credential }: `/sign-in`, the labels Email and
    Credential, the button "Sign in with credential", then `/`; the session
    `/api/auth/get-session` answers must name the email.
  - `createProject` { base, name, key, slug }: `/settings/projects/new`, the
    labels "Project name", "Request key prefix" and "Project slug", the button
    "Create project", then the heading "Projects" and a link named for the
    project, whose address gives `projectId`.
  - `consent` { url, project, principal }: the authorization URL a `login`
    printed; the option `project` in "Organization and project"; then either
    `principal.new.slug` in "Stable slug" (a new agent principal, the form's
    default), or the option `principal.existing` in "Agent principal"; then
    "Allow connection", and the page the browser lands on, which must be the
    authorization URL's `redirect_uri` (`callbackOf`). It answers with that
    address's origin, path and query parameter names, never their values, and
    the page's text.
  - `seeRequest` { base, title, within }: `/requests`, its heading "Requests",
    then whether `title` is shown within `within` milliseconds (`shown`).
  - `close` {}: closes every browser; the process ends.

  `serverErrors`, on each answer, lists the responses with a status of 500 or
  more the page received during that command, as `<status> <method> <path>`.

  The credential arrives in a line on standard input, never in argv, and no
  answer repeats it: every error message passes through `redact` first.
*/

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const BROWSERS = Object.freeze(["chromium", "webkit"]);

/** Each command's fields, beside `id` and `browser`. */
export const COMMANDS = Object.freeze({
  signIn: ["base", "email", "credential"],
  createProject: ["base", "name", "key", "slug"],
  consent: ["url", "project", "principal"],
  seeRequest: ["base", "title", "within"],
  close: [],
});

/** The fields no answer, transcript or error may repeat. */
export const SECRET_FIELDS = Object.freeze(["credential"]);

const STRING_FIELDS = new Set([
  "base",
  "email",
  "credential",
  "name",
  "key",
  "slug",
  "url",
  "project",
  "title",
]);

/** One line of standard input, as a command, or a refusal saying why. */
export function parseCommand(line) {
  let command;

  try {
    command = JSON.parse(line);
  } catch {
    throw new Error("a line that is not JSON");
  }
  if (command === null || typeof command !== "object") {
    throw new Error("a line that is not a JSON object");
  }
  if (!Number.isInteger(command.id)) throw new Error("a command with no id");

  const fields = COMMANDS[command.command];

  if (fields === undefined || !Object.hasOwn(COMMANDS, command.command)) {
    throw new Error(`no command is named ${JSON.stringify(command.command)}`);
  }

  const expected = new Set([
    "id",
    "command",
    ...fields,
    ...(command.command === "close" ? [] : ["browser"]),
  ]);

  for (const key of Object.keys(command)) {
    if (!expected.has(key)) {
      throw new Error(`${command.command} takes no field ${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(command, key)) {
      throw new Error(`${command.command} needs ${key}`);
    }
  }
  if (command.command !== "close" && !BROWSERS.includes(command.browser)) {
    throw new Error(`no browser is named ${JSON.stringify(command.browser)}`);
  }
  for (const key of fields) {
    if (
      STRING_FIELDS.has(key) &&
      (typeof command[key] !== "string" || command[key] === "")
    ) {
      throw new Error(`${command.command}'s ${key} is not a non-empty string`);
    }
  }
  if (
    command.command === "seeRequest" &&
    (!Number.isInteger(command.within) || command.within <= 0)
  ) {
    throw new Error("seeRequest's within is not a positive whole number");
  }
  if (command.command === "consent") {
    const { principal } = command;
    const kinds = Object.keys(principal ?? {});
    const valid =
      principal !== null &&
      typeof principal === "object" &&
      kinds.length === 1 &&
      ((kinds[0] === "new" &&
        typeof principal.new?.slug === "string" &&
        principal.new.slug !== "") ||
        (kinds[0] === "existing" &&
          typeof principal.existing === "string" &&
          principal.existing !== ""));

    if (!valid) {
      throw new Error(
        "consent's principal is neither { new: { slug } } nor { existing: <option> }",
      );
    }
  }

  return command;
}

/** `text` with every secret replaced, so an error cannot carry one out. */
export function redact(text, secrets) {
  let redacted = String(text);

  for (const secret of secrets) {
    if (typeof secret === "string" && secret !== "") {
      redacted = redacted.split(secret).join("<redacted>");
    }
  }

  return redacted;
}

/** The failed answer: the browser and the step first, then the first line. */
export function failureReply({ id, browser, step, error, secrets = [] }) {
  const message = error instanceof Error ? error.message : String(error);
  const first = redact(message, secrets).split("\n")[0].trim();

  return {
    id,
    ok: false,
    ...(browser === undefined ? {} : { browser }),
    step,
    error: `${browser ?? "person"}: ${step}: ${first}`,
  };
}

/**
 * Where an approved consent must land: the `redirect_uri` of the authorization
 * URL, an http address on 127.0.0.1 (the callback `login` listens on).
 */
export function callbackOf(authorizationUrl) {
  const redirect = new URL(authorizationUrl).searchParams.get("redirect_uri");

  if (redirect === null) {
    throw new Error("the authorization URL names no redirect_uri");
  }

  const callback = new URL(redirect);

  if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1") {
    throw new Error(
      `the authorization URL's redirect_uri is ${callback.origin}, not an http address on 127.0.0.1`,
    );
  }

  return { origin: callback.origin, pathname: callback.pathname };
}

/** An address without its query: the origin and the path only. */
export function addressOf(url) {
  try {
    const parsed = new URL(url);

    return parsed.origin === "null"
      ? `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(not a URL)";
  }
}

/** A locator's copies a person can see (`apps/web/tests/fixtures/shell.ts`). */
const onScreen = (locator) => locator.filter({ visible: true });

/** One option of a CUE++ `Select`: its labelled combobox, then the listbox. */
async function choose(page, control, option) {
  await page.getByRole("combobox", { exact: true, name: control }).click();
  await page
    .getByRole("listbox")
    .getByRole("option", { exact: true, name: option })
    .click();
}

const PROJECT_LINK = /^\/settings\/projects\/([0-9a-f-]{36})$/u;

/** The steps, each `(session, command) => result`, on Playwright's API. */
export const STEPS = Object.freeze({
  async signIn({ page, context }, { base, email, credential }) {
    const origin = new URL(base).origin;

    await page.goto(new URL("/sign-in", base).href);
    await onScreen(page.getByLabel("Email", { exact: true })).fill(email);
    await onScreen(page.getByLabel("Credential", { exact: true })).fill(
      credential,
    );
    await page.getByRole("button", { name: "Sign in with credential" }).click();
    await page.waitForURL(
      (url) => url.origin === origin && url.pathname === "/",
    );

    const response = await context.request.get(
      new URL("/api/auth/get-session", base).href,
    );
    const session = await response.json().catch(() => null);

    if (session?.user?.email !== email) {
      throw new Error(
        `/api/auth/get-session answered ${response.status()} naming ${JSON.stringify(session?.user?.email ?? null)}, not ${email}`,
      );
    }

    return { landed: addressOf(page.url()), session: response.status() };
  },

  async createProject({ page }, { base, name, key, slug }) {
    await page.goto(new URL("/settings/projects/new", base).href);
    await onScreen(page.getByLabel("Project name")).fill(name);
    await onScreen(page.getByLabel("Request key prefix")).fill(key);
    await onScreen(page.getByLabel("Project slug")).fill(slug);
    await page.getByRole("button", { name: "Create project" }).click();
    await page
      .getByRole("heading", { exact: true, name: "Projects" })
      .waitFor();

    const link = page.getByRole("link", { exact: true, name });

    await link.waitFor();

    const href = await link.getAttribute("href");
    const projectId = PROJECT_LINK.exec(href ?? "")?.[1];

    if (projectId === undefined) {
      throw new Error(
        `the link named ${name} goes to ${JSON.stringify(href)}, not a project's page`,
      );
    }

    return { landed: addressOf(page.url()), projectId };
  },

  async consent({ page }, { url, project, principal }) {
    const callback = callbackOf(url);
    const allow = page.getByRole("button", { name: "Allow connection" });

    await page.goto(url);
    await allow.waitFor();
    await choose(page, "Organization and project", project);
    if (principal.existing !== undefined) {
      await choose(page, "Agent principal", principal.existing);
    } else {
      await onScreen(page.getByLabel("Stable slug")).fill(principal.new.slug);
    }
    await allow.click();
    try {
      await page.waitForURL(
        (landed) =>
          landed.origin === callback.origin &&
          landed.pathname === callback.pathname,
      );
    } catch {
      throw new Error(
        `the browser did not reach the callback ${callback.origin}${callback.pathname}; it is at ${addressOf(page.url())}`,
      );
    }

    const landed = new URL(page.url());

    return {
      callback: {
        origin: landed.origin,
        pathname: landed.pathname,
        queryKeys: [...new Set(landed.searchParams.keys())].sort(),
      },
      body: (await page.locator("body").innerText()).trim(),
    };
  },

  async seeRequest({ page }, { base, title, within }) {
    await page.goto(new URL("/requests", base).href);
    await page
      .getByRole("heading", { exact: true, name: "Requests" })
      .waitFor();

    const shown = await onScreen(page.getByText(title, { exact: false }))
      .first()
      .waitFor({ timeout: within })
      .then(
        () => true,
        () => false,
      );

    return { landed: addressOf(page.url()), shown };
  },
});

/** A browser, its context and its page, from playwright-core. */
export async function openBrowser(name) {
  const playwright = await import("playwright-core");
  const browser = await playwright[name].launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(120_000);

  return { browser, context, page, version: browser.version() };
}

/**
 * Reads commands from `input` and writes one answer for each to `output`, in
 * order. `open` makes a browser's session the first time that browser is
 * named; `steps` holds what each command does.
 */
export async function serve({
  input,
  output,
  open = openBrowser,
  steps = STEPS,
  ready = {},
}) {
  const sessions = new Map();
  const secrets = new Set();
  const write = (answer) => output.write(`${JSON.stringify(answer)}\n`);

  write({ ready });

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === "") continue;

    let command;

    try {
      command = parseCommand(line);
    } catch (error) {
      let id = null;

      try {
        id = JSON.parse(line)?.id ?? null;
      } catch {}
      write(failureReply({ id, step: "protocol", error }));
      continue;
    }
    for (const field of SECRET_FIELDS) {
      if (typeof command[field] === "string") secrets.add(command[field]);
    }

    if (command.command === "close") {
      for (const session of sessions.values()) {
        await session.browser?.close?.();
      }
      sessions.clear();
      write({ id: command.id, ok: true, result: { closed: true } });
      break;
    }

    const { browser, id } = command;

    if (!sessions.has(browser)) {
      try {
        const session = await open(browser);
        const serverErrors = [];

        session.page.on?.("response", (response) => {
          if (response.status() >= 500) {
            serverErrors.push(
              `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
            );
          }
        });
        sessions.set(browser, { ...session, serverErrors });
      } catch (error) {
        write(
          failureReply({
            id,
            browser,
            step: "launch",
            error,
            secrets: [...secrets],
          }),
        );
        continue;
      }
    }

    try {
      const session = sessions.get(browser);

      session.serverErrors.length = 0;

      const result = await steps[command.command](session, command);

      write({
        id,
        ok: true,
        browser,
        browserVersion: session.version,
        result,
        serverErrors: [...session.serverErrors],
      });
    } catch (error) {
      write(
        failureReply({
          id,
          browser,
          step: command.command,
          error,
          secrets: [...secrets],
        }),
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import("node:module");
  const playwrightCore = createRequire(import.meta.url)(
    "playwright-core/package.json",
  ).version;

  await serve({
    input: process.stdin,
    output: process.stdout,
    ready: { node: process.version, playwrightCore },
  });
  // After `close`, standard input may still be open; the process ends anyway.
  process.stdin.destroy();
}
