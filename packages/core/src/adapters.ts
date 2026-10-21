/*
  The names the repository's web imports from core that `.` does not keep
  (Plan 13, G.7a; rulings 142 and 144), but one: the REST route's query
  resolution, the administration reads' dispatch, the command ports and
  scopes of the web's own buses, the command fingerprint and the workspace
  encryption, and the legacy import's segments; and the execution, query and
  registration functions two of the REST route's suites build their stand-in
  RequestPort from. The one is `personCommandContext`, the builder of a
  person's command context, which ruling 230 item 3 does not publish: it is
  on `./person-context` (`person-context.ts`), which is not.

  Published since ruling 193 item 1, because `@requestport/server` imports
  `resolveRestQuery` from it (ruling 144 had G.7's pack step leave it out of
  the packed manifest): `published-types.test.ts` walks it as a published
  entry, so it also gives the five types its functions' declarations name
  that no other published entry exports (`AdministrationEntry`,
  `AdministrationReading`, `CommandTargets`, `ProjectRegistrationOptions`
  and `QueryTargets`). Each other name is re-exported from the module `.`
  re-exported it from until G.7a, so it is the same binding; the five types
  are re-exported from the modules that declare them.
*/
export {
  type AdministrationEntry,
  type AdministrationRead,
  type AdministrationReadInput,
  type AdministrationReading,
  administrationReads,
  findAdministrationRead,
  isAdministrationPath,
  type OperatorReadScope,
} from "./administration-reads.js";
export { createCommandPorts, humanScopes } from "./command-bus.js";
export { type CommandTargets, createCommandExecution } from "./execute.js";
export { legacySegments } from "./import-split.js";
export {
  createProjectRegistration,
  type ProjectRegistrationOptions,
} from "./project-registration.js";
export {
  createAgentQueries,
  createQueryExecution,
  type QueryTargets,
  resolveRestQuery,
} from "./query.js";
export {
  commandFingerprintSecret,
  createWorkspaceEncryption,
} from "./secrets.js";
