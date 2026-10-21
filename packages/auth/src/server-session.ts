import { APIError } from "better-auth";

type SessionReader<T> = (input: { headers: Headers }) => Promise<T | null>;

export function createRequireHumanSession<T>(getSession: SessionReader<T>) {
  return async (headers: Headers) => {
    const session = await getSession({ headers });
    if (!session) {
      throw new APIError("UNAUTHORIZED", {
        code: "unauthorized",
        message: "unauthorized",
      });
    }
    return session;
  };
}
