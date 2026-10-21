import type { CommandResult, CommandRunner } from "../credentials.js";

export function ok(stdout: string): CommandResult {
  return { status: 0, stderr: "", stdout };
}

export function notFound(): CommandResult {
  return {
    status: 44,
    stderr:
      "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
    stdout: "",
  };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** The key the fake keychain files an item under: its service and account. */
export function itemKey(service: string, account: string): string {
  return `${service} ${account}`;
}

export type FakeKeychain = {
  calls: { args: readonly string[]; command: string }[];
  entries: Map<string, string>;
  run: CommandRunner;
};

/**
 * A stand-in for `/usr/bin/security`, faithful where faithfulness is the test.
 *
 * It keys items on the service *and* the account, exactly as the real keychain
 * does, so the store cannot pass the isolation tests by accident — but neither
 * is it punished for a naming choice the real thing would tolerate. What the
 * store must get right about the name is asserted directly instead, against
 * the keys it produced. `find-generic-password` without `-w` answers whether
 * the item exists and prints no secret, as the real one does.
 */
export function fakeKeychain(): FakeKeychain {
  const entries = new Map<string, string>();
  const calls: { args: readonly string[]; command: string }[] = [];

  const run: CommandRunner = (command, args) => {
    calls.push({ args, command });
    const key = itemKey(flag(args, "-s") ?? "", flag(args, "-a") ?? "");

    switch (args[0]) {
      case "add-generic-password": {
        if (entries.has(key) && !args.includes("-U")) {
          return {
            status: 45,
            stderr: "security: The specified item already exists.\n",
            stdout: "",
          };
        }
        entries.set(key, flag(args, "-w") ?? "");
        return ok("");
      }
      case "delete-generic-password":
        return entries.delete(key) ? ok("") : notFound();
      case "find-generic-password": {
        const stored = entries.get(key);
        if (stored === undefined) return notFound();
        // `security -w` writes the secret followed by a newline, and the store
        // has to put that back the way it found it.
        return args.includes("-w")
          ? ok(`${stored}\n`)
          : ok(
              'keychain: "/Users/someone/Library/Keychains/login.keychain-db"\n',
            );
      }
      case "list-keychains":
        return ok('    "/Users/someone/Library/Keychains/login.keychain-db"\n');
      default:
        return { status: 1, stderr: "security: unknown command\n", stdout: "" };
    }
  };

  return { calls, entries, run };
}
