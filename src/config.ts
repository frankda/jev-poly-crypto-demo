import { DEFAULT_POLL_SCHEDULE, parsePollSchedule } from "./cadence";

export function readConfig(env: Record<string, string | undefined> = process.env) {
  const num = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key]?.trim() ? Number(env[key]) : fallback;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected ${min}..${max}`);
    return value;
  };
  const dataMode = env.DATA_MODE ?? "live";
  const model = env.MODEL ?? "mock";
  if (dataMode !== "live" && dataMode !== "demo") throw new Error("DATA_MODE must be live or demo");
  if (model !== "mock" && model !== "jev") throw new Error("MODEL must be mock or jev");
  const ledger = env.LEDGER ?? "sqlite";
  if (ledger !== "sqlite" && ledger !== "memory") throw new Error("LEDGER must be sqlite or memory");
  const corsOrigin = env.CORS_ORIGIN?.trim() || null;
  if (corsOrigin && (!/^https?:\/\/[^/]+$/.test(corsOrigin) || corsOrigin.includes("*"))) throw new Error("CORS_ORIGIN must be one exact origin like https://example.vercel.app");
  const entryDecider = env.ENTRY_DECIDER ?? "jev";
  if (entryDecider !== "jev" && entryDecider !== "rules") throw new Error("ENTRY_DECIDER must be jev or rules");
  const control = env.CONTROL ?? "on";
  if (control !== "on" && control !== "off") throw new Error("CONTROL must be on or off");
  const perpFeatures = env.PERP_FEATURES ?? "on";
  if (perpFeatures !== "on" && perpFeatures !== "off") throw new Error("PERP_FEATURES must be on or off");
  if ((env.TRADING_MODE ?? "paper") !== "paper") throw new Error("Only TRADING_MODE=paper is implemented; real orders are not supported");
  if (model === "jev" && !env.TYPESAFE_AI_API_KEY?.trim()) throw new Error("MODEL=jev requires TYPESAFE_AI_API_KEY in .env");
  const config = {
    dataMode, model, perpFeatures: perpFeatures === "on", jevModelId: env.JEV_MODEL_ID ?? "jev-latest",
    entryDecider, control: control === "on", corsOrigin, maxSseClients: num("MAX_SSE_CLIENTS", 200, 1, 10000), ledger, dataDir: env.DATA_DIR ?? `data/${dataMode === "demo" ? "demo" : "paper"}`,
    host: env.HOST ?? "127.0.0.1", port: num("PORT", 3000, 1024, 65535),
    pollMs: num("POLL_MS", 2000, 1000, 60000),
    // "fixed" = constant POLL_MS; otherwise the interval depends on time elapsed in the round.
    pollSchedule: (env.POLL_SCHEDULE ?? DEFAULT_POLL_SCHEDULE).trim() === "fixed" ? null : parsePollSchedule(env.POLL_SCHEDULE ?? DEFAULT_POLL_SCHEDULE),
    modelTimeoutMs: num("MODEL_TIMEOUT_MS", 3000, 100, 30000),
    maxDataAgeMs: num("MAX_DATA_AGE_MS", 15000, 1000, 60000),
    minSecondsLeft: num("MIN_SECONDS_LEFT", 30, 5, 290),
    maxSecondsLeft: num("MAX_SECONDS_LEFT", 240, 10, 300),
    bankroll: num("BANKROLL_USD", 1000, 1, 1e7),
    tradeUsd: num("TRADE_USD", 10, 1, 1e5),
    maxExposure: num("MAX_OPEN_EXPOSURE_USD", 50, 1, 1e6),
    // "off" disables the daily loss stop (paper-only dry runs).
    dailyLossLimit: env.DAILY_LOSS_LIMIT_USD?.trim().toLowerCase() === "off" ? null : num("DAILY_LOSS_LIMIT_USD", 30, 1, 1e6),
    minEdge: num("MIN_EDGE", 0.05, 0, 0.5),
    minScore: num("MIN_SCORE", 0, 0, 0.99),
    maxSpread: num("MAX_SPREAD", 0.06, 0.001, 0.5),
    slippageBuffer: num("SLIPPAGE_BUFFER", 0.01, 0, 0.1),
    scoreWeight: num("SCORE_WEIGHT", 0.5, 0, 1),
  } as const;
  if (!Number.isInteger(config.port)) throw new Error("PORT must be an integer");
  if (config.minSecondsLeft >= config.maxSecondsLeft) throw new Error("MIN_SECONDS_LEFT must be below MAX_SECONDS_LEFT");
  if (config.tradeUsd > config.maxExposure || config.tradeUsd > config.bankroll) throw new Error("TRADE_USD exceeds bankroll or exposure limit");
  return config;
}
export type Config = ReturnType<typeof readConfig>;
