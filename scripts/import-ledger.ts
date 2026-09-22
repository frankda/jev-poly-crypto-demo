// Import trades exported from a running engine (GET /api/state + /api/history) into a compact SQLite ledger.
// Usage: bun run scripts/import-ledger.ts <state.json> <history.json> <ledger.sqlite> [bankroll]
// Keeps original ids and timestamps; re-running is idempotent. Only trade-state events are imported.
import { Store, TRADE_EVENT_KINDS } from "../src/store";
import type { Trade } from "../src/types";

const [statePath, historyPath, dbPath, bankrollArg] = process.argv.slice(2);
if (!statePath || !historyPath || !dbPath) throw new Error("Usage: import-ledger.ts <state.json> <history.json> <ledger.sqlite> [bankroll]");
const state = await Bun.file(statePath).json() as { trades: Trade[]; account: { bankroll: number; openTrades: number; settledTrades: number; realizedPnl: number } };
const history = await Bun.file(historyPath).json() as { id: number; at: number; kind: string; data: unknown }[];
const bankroll = Number(bankrollArg ?? state.account.bankroll);
if (state.trades.length !== state.account.openTrades + state.account.settledTrades)
  throw new Error(`Export is incomplete: ${state.trades.length} trades listed but the account has ${state.account.openTrades + state.account.settledTrades}`);

const store = new Store(dbPath, bankroll, false);
const insertTrade = store.db.query("INSERT OR IGNORE INTO trades(id,condition_id,opened_at,settled_at,data) VALUES(?,?,?,?,?)");
const insertEvent = store.db.query("INSERT OR IGNORE INTO events(id,at,kind,data) VALUES(?,?,?,?)");
let trades = 0, events = 0;
store.db.transaction(() => {
  for (const { id, ...trade } of state.trades) trades += insertTrade.run(id, trade.conditionId, trade.openedAt, trade.settledAt, JSON.stringify(trade)).changes;
  for (const e of history) if (TRADE_EVENT_KINDS.has(e.kind)) events += insertEvent.run(e.id, e.at, e.kind, JSON.stringify(e.data)).changes;
})();
const account = store.account();
store.close();
if (Math.abs(account.realizedPnl - state.account.realizedPnl) > 1e-6) throw new Error("Imported realized P&L does not match the export");
console.log(JSON.stringify({ imported: { trades, events }, account }, null, 2));
