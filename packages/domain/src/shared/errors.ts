export type DomainErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "idempotency_conflict"
  | "version_conflict"
  | "route_denied"
  | "invalid_state"
  | "invalid_transition"
  | "already_answered"
  | "rate_limited"
  | "configuration_error";

/*
  The brand that lets `instanceof DomainError` hold across copies of this
  module (Plan 13, H.5; manifest-h.md §2.7.1; ruling 143). A process that
  serves Next beside the host holds two copies: the host's, and the one Next's
  build carries. There, Next's server actions call the host's core and check
  what it throws against Next's class. `Symbol.for` gives every copy the same
  key.
*/
const DOMAIN_ERROR_BRAND = Symbol.for("requestport.domain-error");

export class DomainError extends Error {
  /**
   * True for this class's own instances, as for any class, and also for an
   * Error that another copy of this module built, which carries the brand.
   * Only `DomainError` itself accepts the brand: a subclass, which inherits
   * this method, answers by its own identity alone, so it does not take every
   * branded error for one of its own.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    // `this` is the class `instanceof` was asked about: DomainError, or a
    // subclass that inherited this method. Naming DomainError instead, as
    // the rule's fix does, would let every subclass accept every brand.
    // biome-ignore lint/complexity/noThisInStatic: the receiver is the point.
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return (
      // biome-ignore lint/complexity/noThisInStatic: as above.
      this === DomainError &&
      value instanceof Error &&
      (value as { [DOMAIN_ERROR_BRAND]?: unknown })[DOMAIN_ERROR_BRAND] === true
    );
  }

  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    // Not enumerable, so what spreads, copies or serialises an error is as it was.
    Object.defineProperty(this, DOMAIN_ERROR_BRAND, { value: true });
  }
}
