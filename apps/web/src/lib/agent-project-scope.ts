/*
  The same agent context, proven to name a project (Plan 13, H.1). The body,
  and why the refusal is shared, moved to `@requestport/server`'s
  `./project-scope`; this module re-exports it under the name the web's
  routes import.
*/
export { withProject } from "@requestport/server/project-scope";
