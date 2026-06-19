// lib/env.ts — thin façade over types/env.ts so app code imports from one
// place. The actual implementation lives in types/env.ts (kept there so
// scripts/ and api/ can both reach it without a lib/ runtime dependency
// for type-only consumers).

export {
  getEnv,
  getDiscordEnv,
  getCommaList,
  getBool,
  resetEnvCache,
  type Env,
  type DiscordEnv,
} from '../types/env.js';