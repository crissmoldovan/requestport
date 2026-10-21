import { describe, expect, test } from "vitest";

import {
  CIMD_ALLOWED_ORIGINS_VARIABLE,
  createCimdOriginPredicate,
  parseCimdAllowedOrigins,
} from "./cimd-origin-allowlist.js";

describe("the CIMD origin allowlist, as configured", () => {
  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["only commas", " , ,, "],
    ["http", "https://agents.example,http://agents.example"],
    ["userinfo", "https://user@agents.example"],
    ["a path", "https://agents.example/clients"],
    ["a query", "https://agents.example/?a=1"],
    ["an empty query", "https://agents.example/?"],
    ["a fragment", "https://agents.example/#a"],
    ["a wildcard", "https://*.agents.example"],
    ["no scheme", "agents.example"],
    ["not a URL", "https://"],
  ])("is refused when %s, naming the variable", (_, value) => {
    expect(() => parseCimdAllowedOrigins(value)).toThrow(
      CIMD_ALLOWED_ORIGINS_VARIABLE,
    );
  });

  test("keeps each entry as its origin", () => {
    expect(
      parseCimdAllowedOrigins(
        " https://Agents.Example/ , https://agents.example:443,https://bücher.example,https://other.example:8443",
      ),
    ).toEqual([
      "https://agents.example",
      "https://xn--bcher-kva.example",
      "https://other.example:8443",
    ]);
  });
});

describe("whether a client_id URL may be fetched", () => {
  const allowed = createCimdOriginPredicate(
    parseCimdAllowedOrigins("https://agents.example"),
  );

  test.each([
    "https://agents.example/c.json",
    "https://agents.example:443/c.json",
    "https://AGENTS.example/c.json",
  ])("admits %s", (url) => {
    expect(allowed(url)).toBe(true);
  });

  test.each([
    ["the scheme", "http://agents.example/c.json"],
    ["an alternate port", "https://agents.example:8443/c.json"],
    ["a subdomain", "https://sub.agents.example/c.json"],
    ["a longer host", "https://agents.example.evil.test/c.json"],
    ["a trailing dot", "https://agents.example./c.json"],
    ["userinfo naming the host", "https://agents.example@evil.test/c.json"],
    ["userinfo on the host", "https://user@agents.example/c.json"],
    ["not a URL", "agents.example/c.json"],
  ])("refuses %s", (_, url) => {
    expect(allowed(url)).toBe(false);
  });

  test("admits only the port an entry names", () => {
    const withPort = createCimdOriginPredicate(
      parseCimdAllowedOrigins("https://agents.example:8443"),
    );

    expect(withPort("https://agents.example:8443/c.json")).toBe(true);
    expect(withPort("https://agents.example/c.json")).toBe(false);
  });

  test("matches an IDN in either form, and refuses a look-alike", () => {
    const unicode = createCimdOriginPredicate(
      parseCimdAllowedOrigins("https://bücher.example"),
    );
    const ascii = createCimdOriginPredicate(
      parseCimdAllowedOrigins("https://xn--bcher-kva.example"),
    );

    expect(unicode("https://xn--bcher-kva.example/c.json")).toBe(true);
    expect(ascii("https://bücher.example/c.json")).toBe(true);
    // "а" below is U+0430 CYRILLIC SMALL LETTER A, not the Latin "a".
    expect(allowedLookAlike()).toBe(false);

    function allowedLookAlike() {
      return createCimdOriginPredicate(
        parseCimdAllowedOrigins("https://agents.example"),
      )("https://аgents.example/c.json");
    }
  });
});
