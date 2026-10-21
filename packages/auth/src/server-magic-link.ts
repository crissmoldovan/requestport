import {
  captureE2EMagicLink,
  type E2EEnvironment,
  isE2EEmailMode,
} from "./e2e-email-outbox.js";

export type ServerMagicLinkSender = (input: {
  email: string;
  url: string;
}) => Promise<void>;

export function createE2EMagicLinkSender(
  env: E2EEnvironment = process.env,
): ServerMagicLinkSender {
  return async (input) => {
    captureE2EMagicLink(input, env);
  };
}

export function selectServerMagicLinkSender({
  createE2ESender,
  createResendSender,
  env,
}: {
  createE2ESender: () => ServerMagicLinkSender;
  createResendSender: () => ServerMagicLinkSender;
  env: E2EEnvironment;
}): ServerMagicLinkSender {
  if (isE2EEmailMode(env)) return createE2ESender();
  if (env.NODE_ENV === "test") {
    return async () => {
      throw new Error("Magic-link delivery is unavailable in unit tests");
    };
  }
  return createResendSender();
}
