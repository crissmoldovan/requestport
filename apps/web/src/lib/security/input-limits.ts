/*
  Bounded request bodies (Plan 13, H.1). The bodies moved to
  `@requestport/server`'s `./input-limits`; this module re-exports each under
  the name its importers use. `RequestTooLargeError` is the package's own
  class, so an `instanceof` here holds against an error the package throws.
*/
export {
  assertJsonDepth,
  RequestTooLargeError,
  readBoundedRequestBody,
  readBoundedRequestText,
} from "@requestport/server/input-limits";
