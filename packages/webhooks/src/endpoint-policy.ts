import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type ResolvedEndpoint = {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
};
export type EndpointResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

function ipv4Number(address: string) {
  return (
    address
      .split(".")
      .reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0
  );
}

function inV4(address: string, base: string, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function ipv6Number(address: string): bigint | null {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  function components(value: string) {
    if (!value) return [];
    const parts = value.split(":");
    const last = parts.at(-1);
    if (last?.includes(".")) {
      if (isIP(last) !== 4) return null;
      parts.splice(
        parts.length - 1,
        1,
        ((ipv4Number(last) >>> 16) & 0xffff).toString(16),
        (ipv4Number(last) & 0xffff).toString(16),
      );
    }
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  }
  const left = components(halves[0] ?? "");
  const right = components(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return null;
  const values = [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
  if (values.length !== 8) return null;
  return values.reduce((result, value) => (result << 16n) | BigInt(value), 0n);
}

function inV6(address: bigint, base: string, prefix: number) {
  const baseValue = ipv6Number(base);
  if (baseValue === null) return false;
  const shift = BigInt(128 - prefix);
  return address >> shift === baseValue >> shift;
}

function mappedIpv4(value: bigint) {
  const mapped = Number(value & 0xffffffffn);
  return `${(mapped >>> 24) & 255}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
}

/*
 * The ranges the operator's opt-in for private and loopback receivers admits
 * (Plan 13, H.10; rulings 175 and 176): loopback (127.0.0.0/8, ::1), RFC 1918
 * (10/8, 172.16/12, 192.168/16), shared address space (100.64/10) and IPv6
 * unique-local (fc00::/7), each also as an IPv4-mapped IPv6 address. Every
 * one is inside a range `isForbiddenAddress` refuses, so the switch only
 * ever lifts a refusal; it never admits link-local (169.254/16, fe80::/10),
 * unspecified, multicast, broadcast or the other reserved ranges.
 */
const privateReceiverV4: ReadonlyArray<readonly [string, number]> = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];
const privateReceiverV6: ReadonlyArray<readonly [string, number]> = [
  ["::1", 128],
  ["fc00::", 7],
];

/*
 * Known cloud metadata endpoints inside those ranges, which stay refused with
 * the switch on, as link-local does. Not exhaustive: the switch admits any
 * other address a cloud places in 100.64.0.0/10 or fc00::/7. Alibaba Cloud's
 * ECS metadata service (100.100.100.200, in 100.64.0.0/10); and in
 * fc00::/7, AWS's IPv6 instance metadata endpoint (fd00:ec2::254), the EKS
 * Pod Identity Agent's IPv6 address (fd00:ec2::23), Google Compute Engine's
 * IPv6 metadata server (fd20:ce::254), Oracle Cloud's IPv6 instance metadata
 * endpoint (fd00:c1::a9fe:a9fe) and Scaleway's IPv6 metadata service
 * (fd00:42::42). The IPv4 metadata addresses most clouds use, such as
 * 169.254.169.254, are link-local.
 */
const metadataV4 = new Set<number>(["100.100.100.200"].map(ipv4Number));
const metadataV6 = new Set<bigint>(
  [
    "fd00:ec2::254",
    "fd00:ec2::23",
    "fd20:ce::254",
    "fd00:c1::a9fe:a9fe",
    "fd00:42::42",
  ].flatMap((address) => {
    const value = ipv6Number(address);
    return value === null ? [] : [value];
  }),
);

/** Whether `address` is in a range the opt-in admits, and no known metadata endpoint. */
function isPrivateReceiverAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return (
      !metadataV4.has(ipv4Number(address)) &&
      privateReceiverV4.some(([base, prefix]) => inV4(address, base, prefix))
    );
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (value === null) return false;
  if (inV6(value, "::ffff:0:0", 96)) {
    return isPrivateReceiverAddress(mappedIpv4(value));
  }
  return (
    !metadataV6.has(value) &&
    privateReceiverV6.some(([base, prefix]) => inV6(value, base, prefix))
  );
}

/**
 * Whether a receiver at `address` is refused. With `privateReceivers`, an
 * address in a range the operator's opt-in admits is not; every other
 * address is judged the same either way.
 */
export function isForbiddenAddress(
  address: string,
  options: { privateReceivers?: boolean } = {},
) {
  if (options.privateReceivers === true && isPrivateReceiverAddress(address)) {
    return false;
  }
  const family = isIP(address);
  if (family === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, prefix]) => inV4(address, String(base), Number(prefix)));
  }
  if (family !== 6) return true;
  const value = ipv6Number(address);
  if (value === null) return true;
  if (inV6(value, "::ffff:0:0", 96)) {
    return isForbiddenAddress(mappedIpv4(value));
  }
  return [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
  ].some(([base, prefix]) => inV6(value, String(base), Number(prefix)));
}

const defaultResolver: EndpointResolver = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({
    address: row.address,
    family: row.family as 4 | 6,
  }));
};

/**
 * What a receiver is judged under, besides its URL.
 *
 * - `production`: anything but `false` is the production policy: `https`,
 *   with no port or port 443. `false` admits plain `http` too, on any port.
 * - `resolver`: how the host's addresses are found; DNS by default.
 * - `privateReceivers`: the operator's opt-in for private and loopback
 *   receivers (rulings 175 and 176), off when absent. On, the address rule
 *   admits `privateReceiverV4` and `privateReceiverV6`, less the known
 *   metadata endpoints inside them, and under the production policy a receiver whose
 *   every address is in one of those ranges may use plain `http` and any port
 *   as well (ruling 179). Every other receiver keeps the scheme and port
 *   rules above. This package reads no environment: the switch is the
 *   caller's to read and pass.
 */
export type EndpointPolicyOptions = {
  production?: boolean;
  resolver?: EndpointResolver;
  privateReceivers?: boolean;
};

export async function resolveWebhookEndpoint(
  value: string,
  options: EndpointPolicyOptions = {},
): Promise<ResolvedEndpoint> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_endpoint_url");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /^https?:\/\/[^/?#]*@/iu.test(value) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    // Endpoint URLs are rendered in the integration UI and retained for
    // delivery. Do not let them become a second secret store; receivers should
    // authenticate the signed RequestPort headers instead.
    throw new Error("unsafe_endpoint_url");
  }
  const privateReceivers = options.privateReceivers === true;
  // With the switch on, plain http under the production policy waits for the
  // addresses, below. Off, it is refused here, before any lookup.
  const httpIfPrivate =
    privateReceivers &&
    url.protocol === "http:" &&
    options.production !== false;
  if (
    url.protocol !== "https:" &&
    (options.production !== false || url.protocol !== "http:") &&
    !httpIfPrivate
  ) {
    throw new Error("https_required");
  }
  const portRuleApplies =
    url.port !== "" &&
    url.port !== "443" &&
    !(options.production === false && url.protocol === "http:");
  // With the switch on, a port other than 443 waits for the addresses, as
  // plain http does: a receiver whose every address is private may use any
  // port (ruling 179). Off, it is refused here, before any lookup.
  if (portRuleApplies && !privateReceivers) {
    throw new Error("unsafe_endpoint_port");
  }
  const addresses = await (options.resolver ?? defaultResolver)(url.hostname);
  if (
    httpIfPrivate &&
    addresses.length > 0 &&
    !addresses.every((row) => isPrivateReceiverAddress(row.address))
  ) {
    throw new Error("https_required");
  }
  if (
    portRuleApplies &&
    privateReceivers &&
    addresses.length > 0 &&
    !addresses.every((row) => isPrivateReceiverAddress(row.address))
  ) {
    throw new Error("unsafe_endpoint_port");
  }
  if (
    !addresses.length ||
    addresses.some((row) =>
      isForbiddenAddress(row.address, { privateReceivers }),
    )
  ) {
    throw new Error("unsafe_endpoint_address");
  }
  return { url, addresses };
}
