import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * A person's browser, as far as Done when 11 needs one (manifest-h.md
 * §2.7.1; `web-ui.integration.test.ts`): plain `fetch` against a serving
 * `requestport start`, with a cookie jar, and server actions called as
 * Next's client calls them. The encoding is H.0c's (`spikes/h0-probe/
 * k1b-drive.mjs`): POST to the action's page with a `Next-Action` header
 * naming the action's id, read from the build's
 * `server-reference-manifest.json` by its file and exported name, and the
 * arguments as React's `encodeReply` encodes `(prevState, formData)` in the
 * `react-server-dom-webpack` Next compiles in (read at 16.3.1): a multipart body whose
 * fields `_1_<name>` are the form's, followed by the field `0`, the argument
 * list `["$undefined","$K1"]`. Redirects are never followed.
 */

export interface PageAnswer {
  status: number;
  location: string | null;
  headers: Headers;
  text: string;
}

export interface ActionAnswer {
  status: number;
  code: string | null;
  message: string | null;
  redirect: string | null;
}

/** Each server action's id, by `<file>#<exported name>`, from the self-host build. */
export function actionIdsOf(serverDirectory: string): Record<string, string> {
  const manifest = JSON.parse(
    readFileSync(
      join(serverDirectory, "server-reference-manifest.json"),
      "utf8",
    ),
  ) as {
    node: Record<string, { filename?: string; exportedName?: string }>;
  };
  return Object.fromEntries(
    Object.entries(manifest.node).map(([id, entry]) => [
      `${entry.filename}#${entry.exportedName}`,
      id,
    ]),
  );
}

export class WebUiDriver {
  readonly #jar = new Map<string, string>();

  constructor(
    readonly base: string,
    readonly actionIds: Readonly<Record<string, string>>,
  ) {}

  get signedIn(): boolean {
    return this.#jar.size > 0;
  }

  #cookie(session: boolean): Record<string, string> {
    return session && this.#jar.size > 0
      ? {
          cookie: [...this.#jar]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        }
      : {};
  }

  #keep(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === "" || /max-age=0/iu.test(line)) this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
  }

  async get(
    path: string,
    { session = true }: { session?: boolean } = {},
  ): Promise<PageAnswer> {
    const response = await fetch(new URL(path, this.base), {
      redirect: "manual",
      headers: this.#cookie(session),
    });
    return {
      status: response.status,
      location: response.headers.get("location"),
      headers: response.headers,
      text: await response.text(),
    };
  }

  /** Signs in with the local credential, from the public origin: the status. */
  async signIn(email: string, password: string): Promise<number> {
    const response = await fetch(
      new URL("/api/auth/sign-in/email", this.base),
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          origin: new URL(this.base).origin,
        },
        body: JSON.stringify({ email, password }),
      },
    );
    this.#keep(response);
    await response.arrayBuffer();
    return response.status;
  }

  /** Calls the action `name` exported by `file`, on `page`, with the form's `fields`. */
  async action(
    page: string,
    file: string,
    name: string,
    fields: Record<string, string>,
    { session = true }: { session?: boolean } = {},
  ): Promise<ActionAnswer> {
    const id = this.actionIds[`${file}#${name}`];
    if (id === undefined) {
      throw new Error(`no action ${file}#${name} in the build's manifest`);
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(`_1_${key}`, value);
    }
    form.append("0", JSON.stringify(["$undefined", "$K1"]));
    const response = await fetch(new URL(page, this.base), {
      method: "POST",
      redirect: "manual",
      headers: {
        "next-action": id,
        origin: new URL(this.base).origin,
        accept: "text/x-component",
        ...this.#cookie(session),
      },
      body: form,
    });
    if (session) this.#keep(response);
    const text = await response.text();
    return {
      status: response.status,
      code: text.match(/"code":"([a-z_]+)"/u)?.[1] ?? null,
      message: text.match(/"message":"([^"]*)"/u)?.[1] ?? null,
      redirect: response.headers.get("x-action-redirect"),
    };
  }

  /**
   * Registers a public client, asks to authorize it with this session, and
   * answers the consent page Better Auth sends the person to, with the
   * client's name.
   */
  async consentPage(clientName: string): Promise<PageAnswer & { url: string }> {
    const redirectUri = "http://127.0.0.1:41999/callback";
    const registered = await fetch(
      new URL("/api/auth/oauth2/register", this.base),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_name: clientName,
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [redirectUri],
          require_pkce: true,
          response_types: ["code"],
          scope: "offline_access project:provision",
          token_endpoint_auth_method: "none",
        }),
      },
    );
    const client = (await registered.json()) as { client_id?: string };
    if (registered.status !== 201 || typeof client.client_id !== "string") {
      throw new Error(`dynamic registration answered ${registered.status}`);
    }
    const query = new URLSearchParams({
      client_id: client.client_id,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "offline_access project:provision",
      state: "web-ui",
    });
    const authorize = await this.get(`/api/auth/oauth2/authorize?${query}`);
    const location =
      authorize.location ??
      authorize.text.match(/"(?:url|redirect)":"([^"]+)"/u)?.[1] ??
      null;
    if (location === null || !location.includes("/oauth/agent-consent")) {
      throw new Error(
        `the authorize request answered ${authorize.status} without the consent page`,
      );
    }
    const url = new URL(location, this.base);
    return {
      ...(await this.get(`${url.pathname}${url.search}`)),
      url: url.pathname,
    };
  }
}

/** The page's first heading, as text. */
export function headingOf(html: string): string {
  return (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/u)?.[1] ?? "")
    .replace(/<[^>]+>/gu, "")
    .trim();
}
