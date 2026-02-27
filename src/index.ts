export {
  scanAllServers,
  findDuplicates,
  findMissingEnvVars,
  findMisplacedConfigs,
  readClaudeConfig,
  getClaudeConfigPath,
} from "./scanner/config-reader.js";

export {
  checkServerHealth,
  checkAllServers,
  redactSecrets,
} from "./scanner/health-checker.js";

export type { HealthStatus, HealthResult } from "./scanner/health-checker.js";
export type { McpServerConfig, McpServerEntry, ClaudeConfig, MisplacedConfig } from "./scanner/config-reader.js";

export { analyzeTiers, generateOnDemandCommands } from "./analyzer/tier-optimizer.js";
export type { TierRecommendation } from "./analyzer/tier-optimizer.js";

export { listPresets, getPreset, generateInstallCommands, PRESETS } from "./analyzer/presets.js";
export type { PresetPack, PresetServer } from "./analyzer/presets.js";
