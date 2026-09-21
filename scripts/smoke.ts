import { PolymarketData } from "../src/polymarket";

// Read-only connectivity test; no model call, no API key, no simulated or real trade.
const data = new PolymarketData();
data.start();
try {
  await Bun.sleep(5000);
  const s = await data.snapshot();
  console.log(JSON.stringify({ market: s.market.slug, source: s.market.source, anchor: s.market.anchor,
    fee: s.market.fee, reference: s.reference, feed: data.status(),
    upAsk: s.books.up.asks[0], downAsk: s.books.down.asks[0], perp: s.perp }, null, 2));
  if (!s.reference) { console.error("RTDS reference not yet available; live end-to-end data is not verified."); process.exitCode = 1; }
  if (!s.perp) console.error("Binance perp features unavailable (auxiliary only; trading logic still runs without them).");
} catch (e) {
  console.error(e instanceof Error ? e.message : "Connectivity test failed"); process.exitCode = 1;
} finally { data.stop(); }
