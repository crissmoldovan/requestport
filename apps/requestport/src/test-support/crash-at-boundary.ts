/*
 * The first start's crash injection (manifest-h.md §2.3.1's proof, Done when
 * 6a), for the test entries beside this module and nothing else: an
 * `afterBoundary` hook that kills its own process with SIGKILL at the one
 * boundary `RP_H4_TEST_CRASH_AT` names (`B1` to `B11`), and returns at every
 * other. The variable reaches the operator child in the environment the
 * start passes on, so the parent's entry dies at B1 to B4 and the child's at
 * B5 to B11. The shipped entries install no hook and read no such variable.
 *
 * Before it kills, it waits until what the process wrote to its standard
 * output and error has been handed to the pipes, so that a credential
 * printed before B11 reaches the test as the self-hoster would have seen it.
 */

const CRASH_AT = "RP_H4_TEST_CRASH_AT";

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

export async function crashAtBoundary(boundary: string): Promise<void> {
  if (process.env[CRASH_AT] !== boundary) return;
  await flushed(process.stdout);
  await flushed(process.stderr);
  process.kill(process.pid, "SIGKILL");
  // SIGKILL cannot be caught; nothing after the boundary runs.
  await new Promise<never>(() => undefined);
}
