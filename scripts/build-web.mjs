// Builds the static dashboard for Vercel. The engine runs elsewhere (Railway); JEV_API_URL is its public origin.
// Plain Node, no dependencies: nothing secret is read or bundled — only the API origin is written into config.js.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const api = (process.env.JEV_API_URL ?? "").trim().replace(/\/+$/, "");
let origin;
try { origin = new URL(api).origin; } catch { throw new Error("Set JEV_API_URL to the engine's public URL, e.g. https://jev-poly.up.railway.app"); }
if (origin !== api || !origin.startsWith("https://")) throw new Error("JEV_API_URL must be a bare https origin without a path");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of ["index.html", "app.js", "decision-view.js", "style.css"]) cpSync(`web/${f}`, `dist/${f}`);
writeFileSync("dist/config.js", `export const API_BASE = ${JSON.stringify(origin)};\n`);
const csp = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${origin}; img-src 'self' data:; base-uri 'none'; form-action 'none'`;
const html = readFileSync("dist/index.html", "utf8").replace("<head>", `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
writeFileSync("dist/index.html", html);
console.log(`dashboard built for ${origin}`);
