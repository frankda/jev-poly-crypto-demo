import type { Config } from "./config";
import { modelState, type Model } from "./model";
import { evaluate, evaluateExit, observationGuard } from "./policy";
import { clampToRound, nextCycleAt, pollIntervalAt } from "./cadence";
import type { Decision, DecisionPoint, Ledger, MarketData, Signal, Snapshot } from "./types";

export class Engine {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private busy = false;
  private lastSettlementCheck = 0;
  private failures = 0;
  private settlementTask: Promise<void> | null = null;
  private points: DecisionPoint[] = [];
  private stage: "idle" | "market-data" | "inference" | "quotes" = "idle";
  private cycleStartedAt: number | null = null;
  private cycleMs: number | null = null;
  private actualIntervalMs: number | null = null;
  private nextTickAt: number | null = null;
  private listeners = new Set<() => void>();
  paused = false;
  latest: Snapshot | null = null;
  decision: Decision | null = null;
  lastEvaluation: { slug: string; decision: Decision } | null = null;
  signal: Signal = { action: "wait", reason: "Waiting for market data" };
  error: string | null = null;
  settlementError: string | null = null;
  updatedAt: number | null = null;

  constructor(readonly config: Config, readonly data: MarketData, readonly model: Model, readonly store: Ledger, private now = Date.now) {
    this.lastEvaluation = store.lastEvaluation();
    this.points = store.recentDecisionPoints();
  }
  private intervalAt(at: number) {
    return this.config.pollSchedule ? pollIntervalAt(at, this.config.pollSchedule) : this.config.pollMs;
  }
  subscribe(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  private emit() { for (const callback of this.listeners) callback(); }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) { this.controller?.abort(); this.signal = { action: "wait", reason: "Entries paused; open positions still await settlement" }; }
    this.store.record(this.now(), "control", { paused }); this.emit();
  }
  view() {
    return { mode: "paper", dataMode: this.config.dataMode, model: this.config.model === "jev" ? this.config.jevModelId : "mock-heuristic",
      paused: this.paused, controls: this.config.control, busy: this.busy, updatedAt: this.updatedAt, serverTime: this.now(), feed: this.data.status(),
      error: this.error, settlementError: this.settlementError, snapshot: this.latest, decision: this.decision, lastEvaluation: this.lastEvaluation, signal: this.signal,
      decisionPoints: this.points.filter(p => p.slug === this.latest?.market.slug),
      cadence: { targetMs: this.intervalAt(this.cycleStartedAt ?? this.now()), actualIntervalMs: this.actualIntervalMs, cycleMs: this.cycleMs,
        cycleStartedAt: this.cycleStartedAt, nextTickAt: this.nextTickAt, stage: this.stage },
      account: this.store.account(this.now()), trades: this.store.trades(50),
      events: this.store.recentEvents(25).map(e => ({ id: e.id, at: e.at, kind: e.kind, signal: e.data?.signal ?? null, decision: e.data?.decision ?? null, pnl: e.data?.pnl ?? null, message: e.data?.message ?? null })),
      risk: { tradeUsd: this.config.tradeUsd, minEdge: this.config.minEdge, minScore: this.config.minScore,
        maxExposure: this.config.maxExposure, dailyLossLimit: this.config.dailyLossLimit, scoreWeight: this.config.scoreWeight, maxDataAgeMs: this.config.maxDataAgeMs },
    };
  }
  start() {
    if (this.running) return;
    this.running = true; this.data.start();
    const loop = async () => {
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, Math.max(0, (this.nextTickAt ?? this.now() + this.intervalAt(this.now())) - this.now()));
    };
    void loop();
  }
  async stop() {
    this.running = false; clearTimeout(this.timer); this.controller?.abort(); this.data.stop();
    while (this.busy) await Bun.sleep(20);
    await this.settlementTask;
  }
  private message(e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const key = process.env.TYPESAFE_AI_API_KEY;
    return (key ? message.split(key).join("[redacted]") : message).slice(0, 300);
  }
  private async settle() {
    if (this.now() - this.lastSettlementCheck < 30000) return;
    this.lastSettlementCheck = this.now(); this.settlementError = null;
    for (const t of this.store.openTrades()) {
      if (t.endMs > this.now()) continue;
      try {
        const resolution = await this.data.resolve(t.conditionId, t.slug);
        if (resolution) this.store.settle(t.id, resolution, this.now());
      } catch (e) { this.settlementError = this.message(e); }
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    const startedAt = this.now();
    this.actualIntervalMs = this.cycleStartedAt === null ? null : startedAt - this.cycleStartedAt;
    this.cycleStartedAt = startedAt; this.nextTickAt = null; this.stage = "market-data";
    this.emit();
    // Settlement polling must not hold up fresh model decisions.
    if (!this.settlementTask) this.settlementTask = this.settle()
      .catch(e => { this.settlementError = this.message(e); })
      .finally(() => { this.settlementTask = null; });
    try {
      const snapshot = await this.data.snapshot(this.now());
      this.latest = snapshot; this.decision = null; this.error = null;
      let point: DecisionPoint | null = null;
      const guard = observationGuard(snapshot, this.config, this.now());
      if (this.paused || guard) {
        this.signal = { action: "wait", reason: this.paused ? "Model evaluation and entries paused; open positions still await settlement" : guard! };
      } else {
        this.stage = "inference"; this.emit();
        const controller = this.controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const abort = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("Model request cancelled or timed out; no trade this cycle")), { once: true });
          timeout = setTimeout(() => controller.abort(), this.config.modelTimeoutMs);
        });
        let decision: Decision;
        try { decision = await Promise.race([this.model.decide(snapshot, controller.signal), abort]); }
        finally { clearTimeout(timeout); this.controller = undefined; }
        const evaluationId = this.store.record(this.now(), "model-evaluation", { slug: snapshot.market.slug, input: modelState(snapshot), decision });
        this.stage = "quotes";
        // Re-read executable quotes after inference; a new window invalidates the old answer.
        const refreshed = await this.data.snapshot(this.now());
        this.latest = refreshed;
        if (this.now() - snapshot.at > this.config.maxDataAgeMs) {
          this.signal = { action: "wait", reason: "Market data used for inference is stale; result discarded" };
        } else if (refreshed.market.source !== snapshot.market.source || refreshed.market.anchor?.price !== snapshot.market.anchor?.price) {
          this.signal = { action: "wait", reason: "Settlement source or price to beat changed; result discarded" };
        } else if (this.paused || refreshed.market.conditionId !== snapshot.market.conditionId) {
          this.signal = { action: "wait", reason: this.paused ? "Entries paused" : "Round changed before the model returned; result discarded" };
        } else {
          this.decision = decision;
          this.lastEvaluation = { slug: refreshed.market.slug, decision };
          const holding = this.store.openTrade(refreshed.market.conditionId);
          if (holding) {
            this.signal = evaluateExit(refreshed, decision, holding, this.config, this.now());
            if (this.signal.exit && !this.store.sell(this.signal.exit, decision, this.now())) this.signal = { action: "wait", reason: "Ledger rejected the sell: position already settled or mismatched" };
          } else {
            this.signal = evaluate(refreshed, decision, this.store.account(this.now()), this.store.hasOpenTrade(refreshed.market.conditionId), this.config, this.now());
            if (this.signal.quote) {
              const opened = this.store.open(refreshed, this.signal.quote, decision, this.now());
              if (!opened) this.signal = { action: "wait", reason: "Ledger rejected the entry: position already open or insufficient cash" };
            }
          }
          point = { id: evaluationId, slug: snapshot.market.slug, at: decision.at, referenceAt: snapshot.reference!.timestamp,
            price: snapshot.reference!.price, direction: decision.rawScores.up === decision.rawScores.down ? "neutral" : decision.rawScores.up > decision.rawScores.down ? "up" : "down",
            decision, action: this.signal.action };
          this.points = [...this.points.filter(p => p.slug === snapshot.market.slug), point].slice(-180);
        }
      }
      this.store.recordDecision(this.latest, this.decision, this.signal, point);
      this.failures = 0;
    } catch (e) {
      this.error = this.message(e); this.decision = null;
      this.signal = { action: "wait", reason: "Data or model request failed; waiting to recover" };
      this.failures++;
      this.store.record(this.now(), "error", { message: this.error });
    } finally {
      this.updatedAt = this.now(); this.busy = false; this.stage = "idle";
      this.cycleMs = this.updatedAt - startedAt;
      const interval = this.intervalAt(startedAt);
      const next = nextCycleAt(startedAt, this.updatedAt, interval, this.failures);
      this.nextTickAt = this.failures > 0 || !this.config.pollSchedule ? next : clampToRound(startedAt, next);
      this.emit();
    }
  }
}
