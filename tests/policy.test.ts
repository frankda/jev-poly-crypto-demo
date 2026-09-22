import { describe, expect, test } from "bun:test";
import { readConfig } from "../src/config";
import { normalizeEntry, normalizeScores } from "../src/model";
import { dataGuard, evaluate, evaluateExit, feePerShare, quoteBuy, quoteSell, riskGuard } from "../src/policy";
import { account, config, decision, now, snapshot } from "./fixtures";

describe("execution and risk gates", () => {
  test("can buy Down when the Down score and executable price qualify", () => {
    const result = evaluate(snapshot(), { ...decision, scores: { up: .25, down: .75 } }, account, false, config, now);
    expect(result.action).toBe("down"); expect(result.quote!.side).toBe("down");
  });
  test("positive edge buys Up with fees included in the fixed cash budget", () => {
    const signal = evaluate(snapshot(), decision, account, false, config, now);
    expect(signal.action).toBe("up"); expect(signal.quote!.total).toBeCloseTo(10, 8);
    expect(signal.quote!.fee).toBeGreaterThan(0); expect(signal.quote!.shares).toBeLessThan(20);
  });
  test("an apparent edge that disappears after fees and buffer does not enter", () => {
    const s = snapshot(); s.books.up.asks[0]!.price = 0.59; s.books.up.bids[0]!.price = 0.58;
    expect(evaluate(s, { ...decision, scores: { up: 0.65, down: 0.35 } }, account, false, config, now).action).toBe("wait");
  });
  test("walks asks in price order and rejects insufficient size inside slippage limit", () => {
    const b = snapshot().books.up;
    b.asks = [{ price: 0.5, size: 10 }, { price: 0.51, size: 100 }];
    const q = quoteBuy(b, "up", 10, { rate: 0.07, exponent: 1 }, .01);
    expect(q!.averagePrice).toBeGreaterThan(.5); expect(q!.total).toBeCloseTo(10);
    b.asks[1]!.price = .52;
    expect(quoteBuy(b, "up", 10, { rate: .07, exponent: 1 }, .01)).toBeNull();
  });
  test("fee curve supports current linear and older exponent-two schedules", () => {
    expect(feePerShare(.5, { rate: .07, exponent: 1 })).toBeCloseTo(.0175);
    expect(feePerShare(.5, { rate: .25, exponent: 2 })).toBeCloseTo(.015625);
    expect(feePerShare(.5, { rate: 0, exponent: 1 })).toBe(0);
  });
  test("missing anchor, unknown fees, stale/future data and wrong stream all fail closed", () => {
    for (const mutate of [
      (s: ReturnType<typeof snapshot>) => { s.market.anchor = null; },
      (s: ReturnType<typeof snapshot>) => { s.market.fee = null; },
      (s: ReturnType<typeof snapshot>) => { s.reference!.timestamp = now - 16000; },
      (s: ReturnType<typeof snapshot>) => { s.books.up.timestamp = now + 5000; },
      (s: ReturnType<typeof snapshot>) => { s.reference!.source = "chainlink-spot"; },
      (s: ReturnType<typeof snapshot>) => { s.market.acceptingOrders = false; },
    ]) { const s = snapshot(); mutate(s); expect(dataGuard(s, config, now)).not.toBeNull(); }
  });
  test("does not enter before entry window, near expiry, or with an old model answer", () => {
    expect(dataGuard(snapshot(), config, snapshot().market.startMs + 10000)).not.toBeNull();
    expect(dataGuard(snapshot(), config, snapshot().market.endMs - 1000)).not.toBeNull();
    expect(evaluate(snapshot(), { ...decision, at: now - 16000 }, account, false, config, now).action).toBe("wait");
  });
  test("blocks repeated round, exhausted balance, loss limit and open stake risk", () => {
    expect(evaluate(snapshot(), decision, account, true, config, now).action).toBe("wait");
    for (const patch of [{ cash: 9 }, { dailyPnl: -30 }, { dailyPnl: -15, exposure: 10 }, { exposure: 50 }])
      expect(evaluate(snapshot(), decision, { ...account, ...patch }, false, config, now).action).toBe("wait");
  });
  test("rejects crossed books and excessive spread", () => {
    for (const bid of [.51, .3]) { const s = snapshot(); s.books.up.bids[0]!.price = bid; expect(evaluate(s, decision, account, false, config, now).action).toBe("wait"); }
  });
  test("DAILY_LOSS_LIMIT_USD=off disables only the daily loss stop", () => {
    const lost = { ...account, dailyPnl: -30, realizedPnl: -30, cash: 970 };
    expect(riskGuard(lost, config)).toContain("loss limit");
    const off = readConfig({ DATA_MODE: "demo", DAILY_LOSS_LIMIT_USD: "off" });
    expect(off.dailyLossLimit).toBeNull(); expect(riskGuard(lost, off)).toBeNull();
    expect(riskGuard({ ...lost, exposure: 50 }, off)).toContain("exposure");
  });
  test("buys any side priced at least MIN_EDGE below Jev, with no minimum-score requirement", () => {
    const s = snapshot(); s.books.down.asks = [{ price: .3, size: 100 }]; s.books.down.bids = [{ price: .29, size: 100 }];
    const signal = evaluate(s, { ...decision, scores: { up: .6, down: .4 } }, account, false, config, now);
    expect(signal.action).toBe("down"); expect(signal.quote!.edge).toBeCloseTo(.4 - (.3 + .07 * .3 * .7));
  });
  test("sell quote walks bids within slippage and deducts fees; rejects thin books", () => {
    const b = snapshot().books.up; b.bids = [{ price: .7, size: 5 }, { price: .69, size: 10 }, { price: .6, size: 100 }];
    const q = quoteSell(b, 12, { rate: .07, exponent: 1 }, .01)!;
    expect(q.notional).toBeCloseTo(5 * .7 + 7 * .69); expect(q.proceeds).toBeCloseTo(q.notional - q.fee); expect(q.bestBid).toBe(.7);
    expect(quoteSell(b, 20, { rate: .07, exponent: 1 }, .01)).toBeNull();
  });
  test("exit waits while the bid is at or below Jev, and with a stale model answer", () => {
    const trade = { id: 1, side: "up" as const, shares: 10, notional: 5, fee: .1, total: 5.1, averagePrice: .5, edge: .2, conditionId: "x", slug: "x", outcomeIndex: 0, openedAt: now, endMs: now + 1, settledAt: null, payout: null, pnl: null };
    const s = snapshot(); s.books.up.bids = [{ price: .75, size: 100 }];
    expect(evaluateExit(s, decision, trade, config, now).action).toBe("wait");
    s.books.up.bids = [{ price: .76, size: 100 }];
    expect(evaluateExit(s, decision, trade, config, now).action).toBe("sell");
    expect(evaluateExit(s, { ...decision, at: now - 16000 }, trade, config, now).action).toBe("wait");
  });
});

describe("model and configuration validation", () => {
  test("shrinks class scores without treating a choice as certainty", () => {
    expect(normalizeScores({ up: .9, down: .1 }, .5).scores.up).toBeCloseTo(.7);
    for (const bad of [undefined, { choice: "up" }, { up: NaN, down: .5 }, { up: 1.1, down: -.1 }, { up: 0, down: 0 }, { up: .8, down: .8 }])
      expect(() => normalizeScores(bad, .5)).toThrow();
  });
  test("refuses live trading, missing credentials and invalid risk settings", () => {
    for (const env of [{ TRADING_MODE: "live" }, { MODEL: "jev" }, { MIN_EDGE: "NaN" }, { SCORE_WEIGHT: "2" }, { TRADE_USD: "5000" }, { MIN_SECONDS_LEFT: "250" }])
      expect(() => readConfig(env)).toThrow();
  });
});

describe("ENTRY_DECIDER=jev", () => {
  const jevConfig = readConfig({ DATA_MODE: "demo" });
  const withEntry = (action: "buy_up" | "buy_down" | "wait", scores = { up: .5, down: .5 }) =>
    ({ ...decision, scores, entry: { action, probabilities: { buy_up: action === "buy_up" ? .6 : .2, buy_down: action === "buy_down" ? .6 : .2, wait: action === "wait" ? .6 : .2 } } });
  test("is the default, and Jev's buy call opens a trade even when the old 5¢ edge rule would refuse", () => {
    expect(jevConfig.entryDecider).toBe("jev");
    const signal = evaluate(snapshot(), withEntry("buy_up"), account, false, jevConfig, now);
    expect(signal.action).toBe("up"); expect(signal.reason).toContain("Jev chose buy UP");
    expect(evaluate(snapshot(), withEntry("buy_up"), account, false, config, now).action).toBe("wait");
  });
  test("Jev can buy DOWN, and choosing wait keeps the trader flat even with a large rule-based edge", () => {
    expect(evaluate(snapshot(), withEntry("buy_down"), account, false, jevConfig, now).action).toBe("down");
    const wait = evaluate(snapshot(), withEntry("wait", { up: .95, down: .05 }), account, false, jevConfig, now);
    expect(wait.action).toBe("wait"); expect(wait.reason).toContain("Jev chose to wait");
  });
  test("missing entry answer, thin books and risk or data guards still block Jev's call", () => {
    expect(evaluate(snapshot(), { ...decision, entry: null }, account, false, jevConfig, now).reason).toContain("no valid entry decision");
    const thin = snapshot(); thin.books.up.asks = [{ price: .5, size: 1 }];
    expect(evaluate(thin, withEntry("buy_up"), account, false, jevConfig, now).reason).toContain("depth");
    expect(evaluate(snapshot(), withEntry("buy_up"), { ...account, cash: 5 }, false, jevConfig, now).action).toBe("wait");
    expect(evaluate(snapshot(), withEntry("buy_up"), account, true, jevConfig, now).action).toBe("wait");
    const stale = snapshot(); stale.reference!.timestamp = now - 16000;
    expect(evaluate(stale, withEntry("buy_up"), account, false, jevConfig, now).action).toBe("wait");
  });
  test("entry answers are validated; ties resolve to wait", () => {
    expect(normalizeEntry({ buy_up: .5, buy_down: .2, wait: .3 })?.action).toBe("buy_up");
    expect(normalizeEntry({ buy_up: .4, buy_down: .4, wait: .2 })?.action).toBe("wait");
    for (const bad of [null, {}, { buy_up: .9, buy_down: .9, wait: .1 }, { buy_up: -1, buy_down: 1, wait: 1 }, { buy_up: "x", buy_down: .5, wait: .5 }])
      expect(normalizeEntry(bad)).toBeNull();
    expect(() => readConfig({ DATA_MODE: "demo", ENTRY_DECIDER: "maybe" })).toThrow();
  });
});
