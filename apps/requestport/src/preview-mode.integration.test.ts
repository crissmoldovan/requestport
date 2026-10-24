import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { defaultSelfHostWebDirectory, locateSelfHostWeb } from "./serve/web.js";
import {
  type Finished,
  freePort,
  runStart,
} from "./test-support/start-process.js";

/*
 * The preview-mode id the published build carries (ruling 202 item 1).
 * `@requestport/web`'s `server/preview-props.json` holds Next's
 * `previewModeId`, the same in every install, and `next@16.4.2`'s node
 * runtime reads it from that file only (`dist/server/next-server.js:1279-1285`
 * and `dist/server/route-modules/route-module.js:170`; 16.3.8 read
 * `prerender-manifest.json`'s, which still carries the same props). For a
 * request whose `x-prerender-revalidate` equals it, Next skips middleware
 * (`dist/server/next-server.js:1144-1152`), here `apps/web/src/proxy.ts`,
 * which sets the content-security policy with its nonce, the other security
 * headers and `cache-control: private, no-store`. The self-host removes that
 * header and `x-prerender-revalidate-if-generated` from every request before
 * Next sees it (`serve/web.ts`).
 *
 * One first start on PGlite, through the executable, serving the self-host
 * build the integration project's global setup made. While it serves,
 * `/sign-in` is asked for plainly, with a wrong id of the same length, with
 * the served build's own id, read from that build's preview props, with
 * that id and `x-prerender-revalidate-if-generated`, and plainly again. Each
 * must answer whole within `ANSWER_BOUND_MS`, as the first plain request
 * does, with the proxy's headers. The id is never written
 * to this suite's output: the answers recorded and compared hold none of it.
 * The data directory is under this run's default temporary directory, with a
 * space in its name (ruling 152).
 */

const PREVIEW_PROPS = join(
  defaultSelfHostWebDirectory(),
  ".next-self-host",
  "server",
  "preview-props.json",
);
const scratch = mkdtempSync(join(tmpdir(), "requestport-preview-mode "));
const directory = join(scratch, "data pglite");

/** The headers `proxy.ts` sets beside the content-security policy (`packages/server/src/security-headers.ts`), as served over http on loopback. */
const SECURITY_HEADERS = [
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
] as const;

/** How long each request may take to answer whole. */
const ANSWER_BOUND_MS = 30_000;

/** What an answer carries of the proxy's headers: no value of the request's. */
interface Answer {
  /**
   * Its status, or, when it did not arrive whole, "no whole answer" and the
   * name of the error `fetch` gave (`TimeoutError` past `ANSWER_BOUND_MS`).
   */
  status: number | string;
  /** Whether a content-security policy came back with a nonce in it. */
  policyWithNonce: boolean;
  /** Which of `SECURITY_HEADERS` came back. */
  securityHeaders: string[];
  cacheControl: string | null;
}

const answers: Record<string, Answer> = {};
let finished: Finished;

beforeAll(async () => {
  // The global setup builds it; without it the start below refuses.
  locateSelfHostWeb();
  const { previewModeId } = JSON.parse(readFileSync(PREVIEW_PROPS, "utf8")) as {
    previewModeId: string;
  };
  expect(
    /^[0-9a-f]{32}$/u.test(previewModeId),
    "the served build's preview props hold a preview-mode id of 32 hex",
  ).toBe(true);

  const port = await freePort();
  const ask = async (headers: Record<string, string>): Promise<Answer> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sign-in`, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(ANSWER_BOUND_MS),
      });
      await response.arrayBuffer();
      const policy = response.headers.get("content-security-policy");
      return {
        status: response.status,
        policyWithNonce: policy?.includes("'nonce-") ?? false,
        securityHeaders: SECURITY_HEADERS.filter((name) =>
          response.headers.has(name),
        ),
        cacheControl: response.headers.get("cache-control"),
      };
    } catch (error) {
      return {
        status: `no whole answer: ${String((error as { name?: unknown }).name)}`,
        policyWithNonce: false,
        securityHeaders: [],
        cacheControl: null,
      };
    }
  };

  finished = await runStart(
    "bin",
    [
      "--data-dir",
      directory,
      "--storage",
      "pglite",
      "--port",
      String(port),
      "--email",
      "owner@example.com",
      "--organization",
      "acme",
      "--organization-name",
      "Acme",
    ],
    {
      whileServing: async () => {
        answers.plain = await ask({});
        answers["a wrong id"] = await ask({
          "x-prerender-revalidate": "0".repeat(previewModeId.length),
        });
        answers["the build's id"] = await ask({
          "x-prerender-revalidate": previewModeId,
        });
        answers["the build's id, if generated"] = await ask({
          "x-prerender-revalidate": previewModeId,
          "x-prerender-revalidate-if-generated": "1",
        });
        answers["plain, after them"] = await ask({});
      },
    },
  );
}, 300_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("requestport start and the build's preview-mode id (ruling 202 item 1)", () => {
  test("a page asked for with the build's own id as x-prerender-revalidate, with or without x-prerender-revalidate-if-generated, answers with the proxy's content-security policy, security headers and cache-control private, no-store, as a plain request does; a plain request after them is answered so too, and the start then stops on SIGTERM with exit 0", () => {
    const proxied: Answer = {
      status: 200,
      policyWithNonce: true,
      securityHeaders: [...SECURITY_HEADERS],
      cacheControl: "private, no-store",
    };
    // One comparison, so that a failure shows every answer and the exit.
    expect(
      { code: finished.code, served: finished.served, answers },
      finished.stderr,
    ).toEqual({
      code: 0,
      served: true,
      answers: {
        plain: proxied,
        "a wrong id": proxied,
        "the build's id": proxied,
        "the build's id, if generated": proxied,
        "plain, after them": proxied,
      },
    });
  });
});
