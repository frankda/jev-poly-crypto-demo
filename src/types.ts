export type Side = "up" | "down";
export type PriceSource = "chainlink-spot" | "chainlink-twap-30s" | "chainlink-twap-60s";
export interface Fee { rate: number; exponent: number }
export interface Tick { timestamp: number; price: number; source: PriceSource }
export interface Market {
  slug: string;
  conditionId: string;
  question: string;
  startMs: number;
  endMs: number;
  tokens: Record<Side, string>;
  outcomeIndices: Record<Side, number>;
  acceptingOrders: boolean;
  source: PriceSource;
  resolutionSource: string;
  description: string;
  fee: Fee | null;
  anchor: { price: number; source: "gamma-metadata" | "rtds-exact-boundary" | "demo" } | null;
}
export interface Level { price: number; size: number }
export interface Book {
  tokenId: string;
  bids: Level[];
  asks: Level[];
  timestamp: number;
  receivedAt: number;
  minOrderSize: number;
}
export interface Snapshot {
  at: number;
  market: Market;
  books: Record<Side, Book>;
  reference: Tick | null;
  history: Tick[];
  /** Auxiliary predictor only; settlement always uses market.source. */
  perp: PerpFeatures | null;
}
// Type aliases (not interfaces) so these stay assignable to the SDK's JSON state type.
export type TakerFlow = { buyBtc: number; sellBtc: number; imbalance: number | null };
export type PerpFeatures = {
  source: "binance-usdm-btcusdt-perp" | "demo";
  at: number;
  mid: number;
  spreadBps: number;
  micropriceOffsetBps: number;
  depthImbalance: { top5: number | null; top20: number | null };
  takerFlow: { seconds10: TakerFlow | null; seconds30: TakerFlow | null; seconds60: TakerFlow | null };
  returnsBps: { seconds10: number | null; seconds30: number | null; seconds60: number | null };
  sinceWindowStartBps: number | null;
  basisVsChainlinkSpotBps: number | null;
};
export interface Decision {
  model: string;
  scores: Record<Side, number>;
  rawScores: Record<Side, number>;
  latencyMs: number;
  inputTokens: number;
  at: number;
}
export interface DecisionPoint {
  id: number;
  slug: string;
  at: number;
  referenceAt: number;
  price: number;
  direction: Side | "neutral";
  decision: Decision;
  action: Signal["action"];
}
export interface Quote {
  side: Side;
  shares: number;
  notional: number;
  fee: number;
  total: number;
  averagePrice: number;
  edge: number;
}
export interface ExitQuote {
  tradeId: number;
  side: Side;
  shares: number;
  notional: number;
  fee: number;
  proceeds: number;
  averagePrice: number;
  bestBid: number;
  score: number;
}
export interface Signal {
  action: Side | "sell" | "wait";
  reason: string;
  quote?: Quote;
  exit?: ExitQuote;
}
export interface Trade extends Quote {
  id: number;
  conditionId: string;
  slug: string;
  outcomeIndex: number;
  openedAt: number;
  endMs: number;
  settledAt: number | null;
  payout: number | null;
  pnl: number | null;
  /** Set when closed by a simulated sell before official settlement. */
  exit?: (Omit<ExitQuote, "tradeId"> & { at: number }) | null;
}
export interface Account {
  bankroll: number;
  cash: number;
  exposure: number;
  realizedPnl: number;
  dailyPnl: number;
  openTrades: number;
  settledTrades: number;
  wins: number;
}
export interface Resolution { payouts: [number, number]; source: "polymarket" | "demo" }
/** Paper ledger: SQLite for local runs (LEDGER=sqlite), in-memory for hosted demos (LEDGER=memory). */
export interface Ledger {
  readonly bankroll: number;
  close(): void;
  trades(limit?: number): Trade[];
  openTrades(): Trade[];
  openTrade(conditionId: string): Trade | null;
  hasOpenTrade(conditionId: string): boolean;
  account(now?: number): Account;
  record(at: number, kind: string, data: unknown): number;
  recentDecisionPoints(limit?: number): DecisionPoint[];
  recentEvents(limit?: number): { id: number; at: number; kind: string; data: any }[];
  lastEvaluation(): { slug: string; decision: Decision } | null;
  open(snapshot: Snapshot, quote: Quote, decision: Decision, now?: number): boolean;
  sell(exit: ExitQuote, decision: Decision, now?: number): boolean;
  settle(tradeId: number, resolution: Resolution, now?: number): boolean;
  recordDecision(snapshot: Snapshot, decision: Decision | null, signal: Signal, point?: DecisionPoint | null): void;
}
export interface MarketData {
  start(): void;
  stop(): void;
  snapshot(now?: number): Promise<Snapshot>;
  resolve(conditionId: string, slug: string): Promise<Resolution | null>;
  status(): string;
}
