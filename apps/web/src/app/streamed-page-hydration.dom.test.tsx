import { format } from "node:util";

import type { RequestListItem } from "@requestport/domain";
import type { ReactNode } from "react";
import { act, Suspense, use } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("geist/font/sans", () => ({
  GeistSans: {
    variable: "__variable_geist_sans",
    className: "geist-sans",
    style: { fontFamily: "__Geist, sans-serif" },
  },
}));

vi.mock("geist/font/mono", () => ({
  GeistMono: {
    variable: "__variable_geist_mono",
    className: "geist-mono",
    style: { fontFamily: "__Geist_Mono, monospace" },
  },
}));

// The page's forms are bound to server actions whose module reads the server
// environment at import time. The page is what this suite is about.
vi.mock("./(app)/requests/actions.js", () => {
  const inert = async () => ({ status: "idle" as const });
  return {
    answerQuestionAction: inert,
    askQuestionAction: inert,
    attachArtifactAction: inert,
    closeQuestionAction: inert,
    createRequestAction: inert,
    linkRequestsAction: inert,
    postMessageAction: inert,
    previewRequestRouteAction: async () => ({ status: "invalid" as const }),
    transitionRequestAction: inert,
    unlinkRequestsAction: inert,
    updateRequestAction: inert,
  };
});

import { RequestListView } from "../components/request-workflow.js";
import ApplicationLoading from "./(app)/loading.js";
import { AppearanceRoot } from "./appearance-root.js";

/**
 * A page that streams in after the shell must be hydrated from the server's
 * markup — once — and not rendered a second time beside it.
 *
 * Every authenticated page sits inside `(app)/loading.tsx`, so on a document
 * load its markup arrives *after* the shell: first the loading fallback inside
 * a pending boundary, then the page in a hidden `<div id="S:0">` followed by an
 * inline script that swaps it in. The React this app runs queues that swap —
 * for the next animation frame, or up to 300 ms after the previous one —
 * rather than doing it at once. If a context above the boundary changes before
 * the boundary has hydrated, React cannot hydrate it: it renders the page again
 * on the client and discards the server's markup, and it reports nothing:
 * `onRecoverableError` is not called and nothing reaches `console.error`. When
 * the server's copy was already queued, it stays in the document, hidden,
 * beside the client's copy until the queued swap runs.
 *
 * That is the shape `agent-journey.spec.ts` failed on at `/requests`: the
 * request title twice, first under a `useId` minted on the client (`_r_…_`),
 * then under one minted while hydrating server markup (`_R_…_`) and outside
 * the accessibility tree.
 *
 * The context that changes is `@cueplusplus/ui@0.14.1`'s `ThemeProvider`,
 * which `AppearanceRoot` renders around the whole body. Under `system` — the
 * mode `0014` seeds every organization with — it publishes `resolvedMode` on
 * its context, starts it at `dark`, and corrects it from `matchMedia` in a
 * layout effect. In a browser that prefers light, which is Playwright's
 * default, that correction lands in the commit that hydrates the shell.
 *
 * The cure is upstream: a provider whose context value does not change while
 * the document hydrates. Until it ships, the two cases that state what the
 * page must do are `test.fails`, and the case above them pins what it does
 * today, so neither can pass for the wrong reason. The upgrade that fixes the
 * provider turns all three red: delete the pinning case and drop `.fails`.
 * `docs/implementation/plans/2026-09-27-13/track-x1.md` has the evidence and
 * the change, verified against this suite.
 *
 * The harness is the one a browser gives Next: the whole document rendered by
 * Fizz as a stream, the shell parsed first, the rest applied as the parser
 * applies it (nodes appended to the body, inline scripts run), and the
 * document hydrated with `hydrateRoot(document, …)`. The page is
 * `RequestListView`, the body of `/requests`; the fallback is the real
 * `(app)/loading.tsx`.
 */

const title = "journey Project 44463764a5d9 needs a dark mode";

const item: RequestListItem = {
  assigneeId: null,
  assigneeType: null,
  displayKey: "JRN-1",
  id: "00000000-0000-4000-8000-000000000101",
  laneId: null,
  laneName: null,
  openQuestionCount: 0,
  priority: "normal",
  reporterId: "00000000-0000-4000-8000-0000000000aa",
  reporterType: "agent",
  sensitivity: "normal",
  sourceKind: "human_direct",
  sourceProjectId: null,
  sourceProjectName: null,
  state: "submitted",
  targetProjectId: "00000000-0000-4000-8000-0000000000c1",
  targetProjectName: "journey Project 44463764a5d9",
  title,
  type: "feature",
  unread: false,
  updatedAt: new Date("2026-09-27T09:30:00.000Z"),
  visibility: "organization",
};

/** The page body, reading its items the way a streamed page waits on data. */
function RequestsPage({ items }: { items: Promise<RequestListItem[]> }) {
  return (
    <RequestListView
      lanes={[]}
      mode="all"
      page={{ items: use(items), nextCursor: null }}
      projects={[]}
      query={{}}
      queryString=""
      selected={null}
    />
  );
}

/** The root layout and the `(app)` loading boundary, as Next composes them. */
function Document({ items }: { items: Promise<RequestListItem[]> }): ReactNode {
  return (
    <html lang="en" suppressHydrationWarning>
      <head />
      <AppearanceRoot
        appearance={{
          density: "ultra-compact",
          mode: "system",
          theme: "requestport",
        }}
        nonce={undefined}
      >
        <main>
          <Suspense fallback={<ApplicationLoading />}>
            <RequestsPage items={items} />
          </Suspense>
        </main>
      </AppearanceRoot>
    </html>
  );
}

/** A promise React reads synchronously, as it reads the client's RSC data. */
function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled" as const,
    value,
  });
}

/** Stands in for the browser's colour-scheme preference. */
function preferColorScheme(scheme: "light" | "dark") {
  window.matchMedia = ((media: string) => {
    const list = new EventTarget() as MediaQueryList;
    Object.assign(list, {
      addListener() {},
      matches: media.includes(`(prefers-color-scheme: ${scheme})`),
      media,
      onchange: null,
      removeListener() {},
    });
    return list;
  }) as typeof window.matchMedia;
}

/**
 * Animation frames are held rather than run, because the gap between the
 * inline script queueing the swap and the frame that performs it is the window
 * this suite is about. `flushFrames` is the frame arriving.
 */
let frames: FrameRequestCallback[] = [];
let root: Root | null = null;

/**
 * What React reported, beyond the one line it cannot help writing here: the
 * server and client renderers share this process's contexts, which only a test
 * can arrange.
 */
let reported: string[] = [];

async function flushFrames() {
  await act(async () => {
    while (frames.length > 0) frames.shift()?.(performance.now());
  });
}

beforeEach(() => {
  frames = [];
  reported = [];
  // Fizz's inline runtime keeps its state on the global object, and each
  // document a browser loads starts without it.
  for (const name of ["$RB", "$RC", "$RT", "$RV"]) {
    Reflect.deleteProperty(globalThis, name);
  }
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const line = format(...args);
    if (!line.startsWith("Detected multiple renderers concurrently")) {
      reported.push(line);
    }
  });
  // A streaming document has not finished loading, and React reads this to
  // decide whether a pending boundary may still be completed by the server.
  Object.defineProperty(document, "readyState", {
    configurable: true,
    get: () => "loading",
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  Reflect.deleteProperty(document, "readyState");
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
  for (const attribute of document.body.getAttributeNames()) {
    document.body.removeAttribute(attribute);
  }
});

/**
 * Serves the document the way Next streams it: the shell first, with the page
 * still pending, then — once the page's data resolves — the rest.
 */
async function serveDocument() {
  let resolveItems!: (items: RequestListItem[]) => void;
  const items = new Promise<RequestListItem[]>((resolve) => {
    resolveItems = resolve;
  });
  const reader = (
    await renderToReadableStream(<Document items={items} />)
  ).getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const shell = decoder.decode(first.value);
  expect(shell, "the shell must carry the page as a pending boundary").toMatch(
    /<!--\$\?--><template id="B:0">/u,
  );

  resolveItems([item]);
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  expect(rest, "the rest must carry the page and its swap").toMatch(
    /<div hidden id="S:0">[\s\S]*\$RC\("B:0","S:0"\)/u,
  );
  return { rest, shell };
}

/** Lays the shell down as the parser has by the time the page arrives. */
function parseShell(shell: string) {
  const parsed = new DOMParser().parseFromString(shell, "text/html");
  document.head.replaceChildren(
    ...[...parsed.head.childNodes].map((node) =>
      document.importNode(node, true),
    ),
  );
  for (const attribute of parsed.body.getAttributeNames()) {
    document.body.setAttribute(
      attribute,
      parsed.body.getAttribute(attribute) ?? "",
    );
  }
  document.body.replaceChildren(
    ...[...parsed.body.childNodes].map((node) =>
      document.importNode(node, true),
    ),
  );
}

/**
 * Applies the rest of the stream: the page's hidden segment is appended to the
 * body and the inline scripts after it run, once each, in order.
 */
function parseRest(rest: string) {
  const template = document.createElement("template");
  template.innerHTML = rest;
  for (const node of [...template.content.childNodes]) {
    if (node instanceof HTMLScriptElement) {
      // biome-ignore lint/security/noGlobalEval: runs React's own inline Fizz runtime, as the browser's parser would.
      globalThis.eval(node.textContent ?? "");
    } else {
      document.body.append(document.importNode(node, true));
    }
  }
}

async function hydrate() {
  await act(async () => {
    root = hydrateRoot(document, <Document items={settled([item])} />, {
      onRecoverableError: (error) => {
        reported.push(`recoverable: ${String(error)}`);
      },
    });
  });
}

/** Every element carrying the request's title, in document order. */
function titleCopies() {
  return [...document.querySelectorAll("span")]
    .filter((span) => span.textContent === title)
    .map((span) => ({
      group: span.closest("[data-group]")?.getAttribute("data-testid") ?? null,
      hidden: span.closest("[hidden]") !== null,
    }));
}

/** A `useId` minted while hydrating server markup. */
const serverId = expect.stringMatching(/^_R_[0-9a-z]+_$/u);
/** A `useId` minted by a client render. */
const clientId = expect.stringMatching(/^_r_[0-9a-z]+_$/u);

describe("a page that streamed in after the shell", () => {
  test("is rendered twice today when the browser prefers light and its swap is still queued", async () => {
    preferColorScheme("light");
    const { rest, shell } = await serveDocument();

    // The page's markup and its swap arrived before the client code did.
    parseShell(shell);
    parseRest(rest);
    expect(document.body.innerHTML).toContain("<!--$~-->");

    await hydrate();

    // The client's copy, then the server's, hidden: what agent-journey saw.
    expect(titleCopies()).toEqual([
      { group: clientId, hidden: false },
      { group: serverId, hidden: true },
    ]);
    expect(reported, "React reports nothing").toEqual([]);

    // The queued swap removes the server's copy. The client's remains.
    await flushFrames();
    expect(titleCopies()).toEqual([{ group: clientId, hidden: false }]);
  });

  test.fails("is hydrated once when the browser prefers light and its swap is still queued", async () => {
    preferColorScheme("light");
    const { rest, shell } = await serveDocument();

    parseShell(shell);
    parseRest(rest);
    await hydrate();

    // Hydration waits for the swap, so the server's copy is the only one.
    expect(titleCopies()).toEqual([{ group: serverId, hidden: true }]);

    await flushFrames();
    expect(titleCopies()).toEqual([{ group: serverId, hidden: false }]);
    expect(reported).toEqual([]);
  });

  test.fails("keeps the server's markup when the browser prefers light and the page is still on its way", async () => {
    preferColorScheme("light");
    const { rest, shell } = await serveDocument();

    parseShell(shell);
    await hydrate();
    parseRest(rest);
    await flushFrames();

    expect(titleCopies()).toEqual([{ group: serverId, hidden: false }]);
    expect(reported).toEqual([]);
  });

  test("is hydrated once when the browser prefers dark and its swap is still queued", async () => {
    // The control: the same document in the same order, with the one input
    // that decides whether the provider's context changes during hydration.
    preferColorScheme("dark");
    const { rest, shell } = await serveDocument();

    parseShell(shell);
    parseRest(rest);
    await hydrate();

    expect(titleCopies()).toEqual([{ group: serverId, hidden: true }]);

    await flushFrames();
    expect(titleCopies()).toEqual([{ group: serverId, hidden: false }]);
    expect(reported).toEqual([]);
  });
});
