// Builds the static dashboard for Vercel. The engine runs elsewhere (Railway); JEV_API_URL is its public origin.
// Plain Node, no dependencies: nothing secret is read or bundled — only the API origin is written into config.js.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// The experiment has ended: the dashboard is a static record and contacts no server, so JEV_API_URL is no longer
// needed (it is still honoured if set, which keeps the build working for anyone running their own engine).
const raw = process.env.JEV_API_URL;
const api = (raw ?? "").trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
let origin = null;
if (api) {
  try { origin = new URL(api).origin; } catch { origin = null; }
  if (origin !== api || !origin?.startsWith("https://"))
    throw new Error(`JEV_API_URL must be a bare https origin without a path. Got ${JSON.stringify(raw)}. Unset it for the static build.`);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of ["index.html", "app.js", "decision-view.js", "state-patch.js", "style.css"]) cpSync(`web/${f}`, `dist/${f}`);
writeFileSync("dist/config.js", `export const API_BASE = ${JSON.stringify(origin)};\n`);
const csp = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${origin ?? "'none'"}; img-src 'self' data:; base-uri 'none'; form-action 'none'`;
const html = readFileSync("dist/index.html", "utf8").replace("<head>", `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
writeFileSync("dist/index.html", html);
console.log(origin ? `dashboard built for ${origin}` : "static dashboard built (no engine connection)");
