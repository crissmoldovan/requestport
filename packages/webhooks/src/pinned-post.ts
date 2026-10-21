import http from "node:http";
import https from "node:https";

/**
 * One webhook POST to an address the endpoint policy has already judged.
 *
 * The address is pinned: the request never resolves the hostname again, so a
 * name that resolved to a public address when it was judged cannot be
 * answered with a private one when the socket opens.
 */
export type DeliveryResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
};

export function postPinned(input: {
  url: URL;
  address: string;
  family: 4 | 6;
  body: Uint8Array;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<DeliveryResponse> {
  return new Promise((resolve, reject) => {
    const transport = input.url.protocol === "https:" ? https : http;
    const request = transport.request(
      input.url,
      {
        method: "POST",
        headers: {
          ...input.headers,
          "content-length": String(input.body.byteLength),
          host: input.url.host,
        },
        ...(input.url.protocol === "https:"
          ? { servername: input.url.hostname }
          : {}),
        // Node 22 asks with `all: true` when family autoselection is on,
        // which is its default, and wants a list then; a lone address in
        // that form fails as "Invalid IP address: undefined" before any
        // socket opens. Both forms answer the one pinned address.
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ address: input.address, family: input.family }]);
          } else {
            callback(null, input.address, input.family);
          }
        },
        timeout: input.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65_536) request.destroy(new Error("response_too_large"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("delivery_timeout")));
    request.on("error", reject);
    request.end(input.body);
  });
}
