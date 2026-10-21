import { Resend } from "resend";

const unsupportedDiagnosticContract =
  "Unsupported Resend 6.20.0 diagnostic contract";

export function createSafeResendClient(apiKey: string) {
  const client = new Resend(apiKey);
  const diagnostic = Reflect.get(client, "logError");

  // Resend 6.20.0 calls this instance method with parsed provider errors in
  // non-production environments. Replace only this client's diagnostic hook;
  // request/response behavior and React rendering remain the SDK's own.
  if (typeof diagnostic !== "function" || diagnostic.length !== 3) {
    throw new Error(unsupportedDiagnosticContract);
  }
  const disabledDiagnostic = () => undefined;
  if (
    !Reflect.set(client, "logError", disabledDiagnostic) ||
    Reflect.get(client, "logError") !== disabledDiagnostic
  ) {
    throw new Error(unsupportedDiagnosticContract);
  }

  return client;
}
