/**
 * Recording and replaying the pre-move goldens (Plan 13, H.1; manifest-h.md
 * §2.2, Done when 1; `track-h.md`, "The goldens' plan").
 *
 * One case is one request to one of the web's route handlers, called as Next
 * calls it: `handler(request, { params })`. What is kept of it:
 *
 * - the request: its method, URL, headers and body (a body longer than
 *   4,096 characters by its length and SHA-256);
 * - the response, as Next serves it behind the web's proxy (ruling 147): the
 *   route's status, every header as a lower-cased pair sorted by name, the
 *   proxy's over the route's where both set one (`next-proxy.ts`), and the
 *   route's body as its exact text, never re-serialised (a body that is an
 *   open event stream is not read, and says so);
 * - the admission: what the collaborators were asked, in the order they were
 *   asked it (the authenticator's audience, each rate-limit call, each call
 *   the RequestPort received, each repository and receipt call, what Better
 *   Auth's handler was handed, each import repository call, readiness), then
 *   the fake ports reached, the transactions opened and the metrics counted.
 *
 * Volatile fields are replaced by the named list in `normalisation.ts`, and
 * by nothing else.
 */
import { createHash } from "node:crypto";

import type { Mock } from "vitest";

import { servedByNext } from "./next-proxy.js";
import { type NormalisationEntry, normalisationFor } from "./normalisation.js";

export type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, unknown>> },
) => Promise<Response>;
export type RouteModule = Record<string, unknown>;

export type GoldenCase = {
  name: string;
  /** The route module's key in the test's table of routes. */
  route: string;
  method: "GET" | "POST" | "DELETE";
  /** Built afresh each time: once to record it, once to send it. */
  request: () => Request;
  /** The params of the route's dynamic segment, as Next passes them. */
  params?: Record<string, string[]>;
  /** Run after every fake is reset and before the request is sent. */
  arrange?: () => void | Promise<void>;
  /** Run after the response is read. */
  cleanup?: () => void | Promise<void>;
  /** The response is an event stream that stays open: keep its head only. */
  headOnly?: boolean;
  /** Load the route module afresh for this case, in place of the table's. */
  load?: () => Promise<RouteModule>;
};

export type ObservedRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  params?: Record<string, string[]>;
  body?: string;
  bodyLength?: number;
  bodySha256?: string;
};

export type ObservedResponse = {
  status: number;
  headers: [string, string][];
  body?: string;
  bodyNotRead?: "an open event stream";
};

export type Observation = {
  name: string;
  request: ObservedRequest;
  response: ObservedResponse;
  admission: Record<string, unknown>;
};

/** A collaborator whose calls a golden records, and how its arguments read. */
export type Recorder = {
  name: string;
  mock: Mock;
  args?: (args: unknown[], index: number) => unknown[];
};

export type Sources = {
  recorders: () => Recorder[];
  /** Admission the fakes keep outside a mock: fake ports, transactions, metrics. */
  counters: () => Record<string, unknown>;
  /** Hex values a golden names by what was hashed. */
  labels: () => ReadonlyMap<string, string>;
  reset: () => void;
};

const longBody = 4_096;

function sortedPairs(headers: Headers): [string, string][] {
  return [...headers]
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function observeRequest(
  request: Request,
  params: Record<string, string[]> | undefined,
): Promise<ObservedRequest> {
  const observed: ObservedRequest = {
    method: request.method,
    url: request.url,
    headers: sortedPairs(request.headers),
    ...(params ? { params } : {}),
  };
  if (!request.body) return observed;
  const bytes = new Uint8Array(await request.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = `base64:${Buffer.from(bytes).toString("base64")}`;
  }
  if (text.length > longBody) {
    observed.bodyLength = bytes.byteLength;
    observed.bodySha256 = createHash("sha256").update(bytes).digest("hex");
  } else {
    observed.body = text;
  }
  return observed;
}

/**
 * A value as a golden writes it: JSON, with what JSON cannot say spelled out
 * (`undefined`, sets, maps, dates, bytes, query strings, requests, functions
 * and errors), a recognised hash replaced by its label, and a string longer
 * than 4,096 characters by its length and SHA-256.
 */
export function plain(
  value: unknown,
  labels: ReadonlyMap<string, string> = new Map(),
  seen = new WeakSet<object>(),
): unknown {
  if (value === undefined) return "$undefined";
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > longBody) {
      return {
        $text: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
      };
    }
    return labels.get(value) ?? value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `$bigint:${value}`;
  if (typeof value === "function") return "$function";
  if (typeof value === "symbol") return `$symbol:${value.description ?? ""}`;
  const object = value as object;
  if (seen.has(object)) return "$circular";
  seen.add(object);
  try {
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value instanceof Uint8Array)
      return { $bytes: Buffer.from(value).toString("base64") };
    if (value instanceof URLSearchParams)
      return { $searchParams: value.toString() };
    if (value instanceof Request)
      return { $request: `${value.method} ${value.url}` };
    if (value instanceof Error)
      return {
        $error: value.name,
        message: value.message,
        ...("code" in value ? { code: plain(value.code, labels, seen) } : {}),
      };
    if (value instanceof Set)
      return { $set: [...value].map((item) => plain(item, labels, seen)) };
    if (value instanceof Map)
      return {
        $map: [...value].map(([key, item]) => [
          plain(key, labels, seen),
          plain(item, labels, seen),
        ]),
      };
    if (Array.isArray(value))
      return value.map((item) => plain(item, labels, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        plain(item, labels, seen),
      ]),
    );
  } finally {
    seen.delete(object);
  }
}

function admission(sources: Sources) {
  const labels = sources.labels();
  const calls = sources
    .recorders()
    .flatMap(({ name, mock, args }) =>
      mock.mock.calls.map((call, index) => ({
        order: mock.mock.invocationCallOrder[index] ?? 0,
        call: name,
        args: plain(args ? args(call, index) : call, labels),
      })),
    )
    .sort((a, b) => a.order - b.order)
    .map(({ call, args }) => ({ call, args }));
  const counters = plain(sources.counters(), labels) as Record<string, unknown>;
  return { calls, ...counters };
}

/**
 * The web's proxy, as Next runs it before every route its matcher covers
 * (`apps/web/src/proxy.ts`; `next-proxy.ts`).
 */
export type WebProxy = {
  /** The proxy's answer to the case's request: the headers it adds. */
  run: (request: Request) => Response | Promise<Response>;
  /** Whether its matcher covers the path. */
  covers: (pathname: string) => boolean;
};

/**
 * One case, as a golden records it, before normalisation: with `proxy`, the
 * response is what Next serves, the proxy's headers over the route's
 * (ruling 147).
 */
export async function observe(
  goldenCase: GoldenCase,
  routes: Record<string, RouteModule>,
  sources: Sources,
  proxy?: WebProxy,
): Promise<Observation> {
  sources.reset();
  await goldenCase.arrange?.();
  try {
    const request = await observeRequest(
      goldenCase.request(),
      goldenCase.params,
    );
    const module = goldenCase.load
      ? await goldenCase.load()
      : routes[goldenCase.route];
    const handler = module?.[goldenCase.method] as RouteHandler | undefined;
    if (!handler) {
      throw new Error(
        `${goldenCase.route} exports no ${goldenCase.method} handler`,
      );
    }
    const sent = goldenCase.request();
    const proxied =
      proxy?.covers(new URL(sent.url).pathname) === true
        ? await proxy.run(goldenCase.request())
        : undefined;
    const answered = await handler(sent, {
      params: Promise.resolve(goldenCase.params ?? {}),
    });
    const response = proxied ? servedByNext(proxied, answered) : answered;
    const observedResponse: ObservedResponse = {
      status: response.status,
      headers: sortedPairs(response.headers),
    };
    if (goldenCase.headOnly) {
      await response.body?.cancel();
      observedResponse.bodyNotRead = "an open event stream";
    } else {
      observedResponse.body = await response.text();
    }
    return {
      name: goldenCase.name,
      request,
      response: observedResponse,
      admission: admission(sources),
    };
  } finally {
    await goldenCase.cleanup?.();
  }
}

function replaceJsonField(text: string, field: string, token: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || !(field in parsed)) {
    return text;
  }
  const value = (parsed as Record<string, unknown>)[field];
  return text.replace(
    `${JSON.stringify(field)}:${JSON.stringify(value)}`,
    `${JSON.stringify(field)}:${JSON.stringify(token)}`,
  );
}

/** The observation with every field on the family's list replaced by its token. */
export function normalise(
  family: string,
  observation: Observation,
): Observation {
  const entries = normalisationFor(family);
  if (entries.length === 0) return observation;
  const response = { ...observation.response };
  for (const entry of entries) {
    if ("header" in entry.where) {
      const { header: name, pattern } = entry.where;
      response.headers = response.headers.map(([key, value]) =>
        key !== name
          ? [key, value]
          : [
              key,
              pattern === undefined
                ? entry.token
                : value.replace(new RegExp(pattern, "gu"), entry.token),
            ],
      );
    } else if (response.body !== undefined) {
      response.body = replaceJsonField(
        response.body,
        entry.where.jsonField,
        entry.token,
      );
    }
  }
  return { ...observation, response };
}

/** Where two observations of one case differ, as paths a list entry can name. */
export function differences(a: Observation, b: Observation): string[] {
  const paths: string[] = [];
  if (JSON.stringify(a.request) !== JSON.stringify(b.request))
    paths.push("request");
  if (a.response.status !== b.response.status) paths.push("response.status");
  const headerNames = new Set(
    [...a.response.headers, ...b.response.headers].map(([name]) => name),
  );
  for (const name of headerNames) {
    const left = a.response.headers.filter(([key]) => key === name);
    const right = b.response.headers.filter(([key]) => key === name);
    if (JSON.stringify(left) !== JSON.stringify(right))
      paths.push(`response.headers.${name}`);
  }
  if (a.response.body !== b.response.body) {
    let left: unknown;
    let right: unknown;
    try {
      left = JSON.parse(a.response.body ?? "");
      right = JSON.parse(b.response.body ?? "");
    } catch {
      left = undefined;
    }
    if (
      typeof left === "object" &&
      left !== null &&
      typeof right === "object" &&
      right !== null
    ) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        if (
          JSON.stringify((left as Record<string, unknown>)[key]) !==
          JSON.stringify((right as Record<string, unknown>)[key])
        )
          paths.push(`response.body.${key}`);
      }
    } else {
      paths.push("response.body");
    }
  }
  if (JSON.stringify(a.admission) !== JSON.stringify(b.admission))
    paths.push("admission");
  return paths;
}

/** The path a list entry names. */
export function pathOf(entry: NormalisationEntry) {
  return "header" in entry.where
    ? `response.headers.${entry.where.header}`
    : `response.body.${entry.where.jsonField}`;
}
