export const timedOut = Symbol("timed out");

/**
 * Waits for `promise` for at most `ms`, then answers `timedOut` instead. The
 * promise itself carries on: JavaScript cannot stop it, only stop waiting.
 */
export function within<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), ms);
    }),
  ]);
}
