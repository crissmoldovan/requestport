import { describe, expect, test } from "vitest";

import { dynamic, GET } from "./route.js";

/*
  The security.txt requestport.com serves (RFC 9116; Plan 13, J.4; ruling
  175, J question 6). Its body is pinned byte for byte, so any change to
  where a reporter is sent is a change to this file too.

  Expires is the one value here that goes stale on its own: RFC 9116 says a
  file is stale after its Expires, and recommends an Expires less than a
  year away. So it is judged against the clock on every run. It must be in
  the future and less than a year and a month away, and a second case fails
  once it is under 30 days away, a month before it lapses rather than after.
  Renewing it means a new date in `route.ts` and in `BODY` below; the steps
  are in `docs/implementation/runbooks/vulnerability-intake.md`.
*/

const BODY = [
  "Contact: https://github.com/crissmoldovan/requestport/security/advisories/new",
  "Expires: 2027-10-01T00:00:00Z",
  "Policy: https://github.com/crissmoldovan/requestport/security/policy",
  "Preferred-Languages: en",
  "Canonical: https://requestport.com/.well-known/security.txt",
  "",
].join("\n");

const DAY = 86_400_000;
const RENEWAL_NOTICE_DAYS = 30;

/** The response's status, content type and body. */
async function served() {
  const response = await GET();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/** Each field's values, by name as written, in order. */
function fieldsOf(body: string) {
  const fields = new Map<string, string[]>();
  for (const line of body.split("\n").filter((line) => line !== "")) {
    const match = /^([A-Za-z0-9-]+): (\S.*)$/u.exec(line);
    if (!match) throw new Error(`not a field line: ${JSON.stringify(line)}`);
    const [, name, value] = match;
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
}

/** The one Expires value of a body, as a date. */
function expiresOf(body: string) {
  const values = fieldsOf(body).get("Expires") ?? [];
  expect(values).toHaveLength(1);
  return new Date(values[0]);
}

/** Why an Expires read at `now` has lapsed or lies too far ahead, or null. */
function lapsedOrTooFar(expires: Date, now: Date) {
  if (Number.isNaN(expires.getTime())) return "Expires is not a date";
  if (expires.getTime() <= now.getTime()) return "Expires has passed";
  const limit = new Date(now);
  limit.setUTCMonth(limit.getUTCMonth() + 13);
  if (expires.getTime() >= limit.getTime()) {
    return "Expires is a year and a month away or more";
  }
  return null;
}

/** Whether an Expires read at `now` is under 30 days away (or passed). */
function renewalDue(expires: Date, now: Date) {
  return expires.getTime() - now.getTime() < RENEWAL_NOTICE_DAYS * DAY;
}

describe("/.well-known/security.txt", () => {
  test("serves its five fields, byte for byte, as text/plain in UTF-8", async () => {
    const { status, contentType, body } = await served();

    expect(status).toBe(200);
    expect(contentType).toBe("text/plain; charset=utf-8");
    expect(body).toBe(BODY);
  });

  test("answers each request itself, as the discovery documents beside it do", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  test("holds RFC 9116's required fields, each once where it must be once", async () => {
    const fields = fieldsOf((await served()).body);

    expect([...fields.keys()]).toEqual([
      "Contact",
      "Expires",
      "Policy",
      "Preferred-Languages",
      "Canonical",
    ]);
    for (const uri of [
      ...(fields.get("Contact") ?? []),
      ...(fields.get("Policy") ?? []),
      ...(fields.get("Canonical") ?? []),
    ]) {
      expect(uri.startsWith("https://")).toBe(true);
    }
    expect(fields.get("Expires")).toHaveLength(1);
    expect(fields.get("Expires")?.[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
    );
    expect(fields.get("Preferred-Languages")).toEqual(["en"]);
  });

  test("its Expires is in the future and less than a year and a month away", async () => {
    const expires = expiresOf((await served()).body);

    expect(lapsedOrTooFar(expires, new Date())).toBeNull();
  });

  test("its Expires is at least 30 days away: renew it before this fails", async () => {
    const expires = expiresOf((await served()).body);
    const daysLeft = Math.floor((expires.getTime() - Date.now()) / DAY);

    expect(
      renewalDue(expires, new Date()),
      `security.txt's Expires is ${daysLeft} days away; set a new date about a year out in route.ts and in this test's BODY`,
    ).toBe(false);
  });
});

describe("the Expires checks refuse what they should", () => {
  const now = new Date("2027-01-15T12:00:00Z");

  test.each([
    ["2027-01-15T12:00:00Z", "Expires has passed"],
    ["2026-12-01T00:00:00Z", "Expires has passed"],
    ["2028-02-15T12:00:00Z", "Expires is a year and a month away or more"],
    ["2028-06-01T00:00:00Z", "Expires is a year and a month away or more"],
    ["not a date", "Expires is not a date"],
  ])("refuses an Expires of %s read on 2027-01-15", (value, problem) => {
    expect(lapsedOrTooFar(new Date(value), now)).toBe(problem);
  });

  test("accepts an Expires eleven months ahead", () => {
    expect(lapsedOrTooFar(new Date("2027-12-15T12:00:00Z"), now)).toBeNull();
    expect(renewalDue(new Date("2027-12-15T12:00:00Z"), now)).toBe(false);
  });

  test("calls a renewal due under 30 days ahead, and not at 30", () => {
    expect(renewalDue(new Date("2027-02-13T12:00:00Z"), now)).toBe(true);
    expect(renewalDue(new Date("2027-02-14T11:59:59.999Z"), now)).toBe(true);
    expect(renewalDue(new Date("2027-02-14T12:00:00Z"), now)).toBe(false);
  });
});
