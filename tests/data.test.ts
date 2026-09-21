import { expect, test } from "bun:test";
import { parseBook, parseFee, parseMarket, parseResolution, priceSource, ReferenceFeed } from "../src/polymarket";
import { conditionId, eventFixture, now, snapshot, startMs } from "./fixtures";

test("maps reversed Up/Down outcomes by label, with verified 5-minute interval and TWAP source", () => {
  const m = parseMarket(eventFixture(), snapshot().market.slug);
  expect(m.tokens.up).toBe("11"); expect(m.outcomeIndices.up).toBe(1); expect(m.source).toBe("chainlink-twap-60s");
  expect(m.anchor?.price).toBe(84000);
});
test("rejects wrong duration, ambiguous outcomes and other settlement sources", () => {
  const e = eventFixture(); e.markets[0]!.endDate = new Date(startMs + 900000).toISOString();
  expect(() => parseMarket(e, snapshot().market.slug)).toThrow();
  expect(() => priceSource("https://evil.test/streams/btc-usd-twap-60s-streams")).toThrow();
  const other = eventFixture(); other.markets[0]!.outcomes = '["Yes","No"]';
  expect(() => parseMarket(other, snapshot().market.slug)).toThrow();
});
test("sorts arbitrary book ordering and validates token and timestamp", () => {
  const raw = { asset_id: "11", timestamp: String(now), min_order_size: "5", bids: [{ price: ".2", size: "10" }, { price: ".48", size: "20" }], asks: [{ price: ".9", size: "10" }, { price: ".5", size: "20" }] };
  const b = parseBook(raw, "11", now); expect(b.bids[0]!.price).toBe(.48); expect(b.asks[0]!.price).toBe(.5);
  expect(() => parseBook(raw, "22", now)).toThrow(); expect(() => parseBook({ ...raw, timestamp: null }, "11", now)).toThrow();
});
test("unknown fee is never silently assumed to be zero", () => {
  for (const value of [undefined, {}, { rate: null, exponent: null }, { rate: -.1, exponent: 1 }]) expect(parseFee(value)).toBeNull();
  expect(parseFee({ rate: 0, exponent: 1 })).toEqual({ rate: 0, exponent: 1 });
});
test("RTDS separates TWAP/spot, orders and deduplicates history, rejects wrong asset and future ticks", () => {
  const feed = new ReferenceFeed();
  const msg = (timestamp: number, value: number, symbol = "btc/usd") => ({ topic: "crypto_prices_twap_sixty", payload: { timestamp, value, symbol } });
  feed.ingest(msg(now, 84000), now); feed.ingest(msg(now - 1000, 83900), now); feed.ingest(msg(now, 84001), now);
  feed.ingest(msg(now + 5000, 100000), now); feed.ingest(msg(now, 3000, "eth/usd"), now);
  expect(feed.ticks).toHaveLength(2); expect(feed.ticks.at(-1)?.price).toBe(84001); expect(feed.ticks[0]!.source).toBe("chainlink-twap-60s");
  feed.ingest({ topic: "crypto_prices_chainlink", payload: { symbol: "btc/usd", data: [{ timestamp: now, value: 84010 }] } }, now);
  expect(feed.ticks).toHaveLength(3);
});
test("settlement requires official resolved state and validated payouts; supports split refunds", () => {
  const row = { condition_id: conditionId, status: "resolved", payouts: [1000000, 0] };
  expect(parseResolution({ data: [row] }, conditionId)?.payouts).toEqual([1, 0]);
  expect(parseResolution({ data: [{ ...row, status: "proposed" }] }, conditionId)).toBeNull();
  expect(parseResolution({ data: [{ ...row, payouts: [1000000, 1000000] }] }, conditionId)).toBeNull();
  expect(parseResolution({ data: [{ ...row, payouts: [500000, 500000] }] }, conditionId)?.payouts).toEqual([.5, .5]);
  expect(parseResolution({ data: [row] }, "wrong-condition")).toBeNull();
});
