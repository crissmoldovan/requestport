// The webpack loader `InertSeamsWebpackPlugin` (`test-seams.ts`) puts first
// in a replaced module's chain, in requestport's self-host Next build alone
// (Plan 13, H.7; ruling 174; ruling 193 item 5): it ignores the module's text
// and answers its replacement's (`options.inert`, an absolute path: a test
// seam's inert module, or a private module's public variant), which the rest
// of the chain (Next's SWC loader) compiles as it would have compiled the
// module itself. The replacement is a dependency of the result, so a change
// to it makes the module again. The module keeps its own path, so Next's
// output tracing counts it as bundled and copies neither file into the
// standalone tree.
const { readFileSync } = require("node:fs");

module.exports = function inertSeamLoader() {
  const { inert } = this.getOptions();
  this.addDependency(inert);
  return readFileSync(inert, "utf8");
};
