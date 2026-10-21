/**
 * The administration reads' dispatch (Plan 13, F.2.0; `manifest-f2.md` §4.1)
 * is core's (`packages/core/src/administration-reads.ts`; Plan 13, G.6,
 * ruling 137): the dispatch map `administrationReads`, an R4 append point
 * (ruling 28), the path lookups and each read's admission. The `/api/v1` GET
 * handler hands every path to the web's RequestPort (`resolveRestQuery`,
 * then `query`), which sends every path under `administrationBasePath`, the
 * prefix itself included, to that dispatch before it asks for a project,
 * and never to the agent queries. Each read runs on the web root's storage's
 * handle, under the deployment's REQUESTPORT_OPERATOR_CREDENTIALS, which the
 * RequestPort hands it.
 *
 * Re-exported here for the web's suites that read them.
 */
export {
  type AdministrationRead,
  type AdministrationReadInput,
  administrationReads,
  findAdministrationRead,
  isAdministrationPath,
  type OperatorReadScope,
} from "@requestport/core/adapters";
