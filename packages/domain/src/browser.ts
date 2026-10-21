// Browser-safe values shared by client components. Keep this entry point free
// of services and adapters that depend on Node.js built-ins.
export { type AgentScope, agentScopes } from "./agents/agent-types.js";
export {
  type AppearanceAxis,
  type AppearanceDefaults,
  type AppearanceDensity,
  type AppearanceMode,
  type AppearanceOverrides,
  type AppearanceSnapshot,
  type AppearanceSource,
  type AppearanceTheme,
  appearanceAxes,
  appearanceDensities,
  appearanceFallback,
  appearanceModes,
  appearanceThemes,
  isAppearanceDensity,
  isAppearanceMode,
  isAppearanceTheme,
  parseAppearanceDefaults,
  parseAppearanceOverrides,
  parseAppearanceVersion,
} from "./appearance/appearance-types.js";
export {
  type PrivateTelemetryField,
  privateTelemetryFields,
} from "./workspaces/workspace-types.js";
