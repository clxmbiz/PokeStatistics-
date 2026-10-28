// PokéFlip : serveur local, sans dépendance. Node 18+.
// Usage : node server.mjs     puis ouvre http://localhost:3000
//
// - sert le site (index.html, data.json...)
// - interroge Vinted EN CONTINU (1 requête par seconde par défaut) avec les cartes de watchlist.json
// - expose /api/deals : le site lit cette route toutes les secondes
//
// Variables d'environnement : PORT (3000), INTERVAL_MS (1000), VINTED (https://www.vinted.fr)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const INTERVAL = Math.max(300, +process.env.INTERVAL_MS || 1000);
const D = process.env.VINTED || "https://www.vinted.fr";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BAD = /ne\s*pas\s*(acheter|commander)|n['’]ach[eè]te[zs]?\s*pas|do\s*not\s*buy|don['’]?t\s*buy|pas\s*(à|a)\s*vendre|annonce\s*(test|bidon|factice)/i;
const JP = /jap|jpn|\bjp\b|日本/i;
const KEEP = 4; // annonces gardées par carte

const readJSON = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
let watch = readJSON("watchlist.json");
fs.watchFile(path.join(ROOT, "watchlist.json"), { interval: 2000 }, () => {
  try { watch = readJSON("watchlist.json"); console.log("watchlist rechargée :", watch.length, "cartes"); } catch {}
});

// ---------- état ----------
const state = new Map();      // clé carte -> [{...annonce}]
const descCache = new Map();  // id annonce -> description
const detailQueue = [];       // id d'annonces dont il faut lire la description
const imgCache = new Map();   // id carte -> image tcgdex
let cookie = "", cookieAt = 0;
let cursor = 0, lastOk = 0, lastError = "", requests = 0, blockedUntil = 0, cycles = 0;
const key = w => w.n + "|" + w.l + "|" + w.r;
const price = p => parseFloat(typeof p === "object" && p ? p.amount : p);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Vinted ----------
async function newSession() {
  const r = await fetch(D + "/", { headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9" } });
  cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
  cookieAt = Date.now();
  if (!cookie) throw new Error("pas de cookie Vinted (HTTP " + r.status + ")");
}
async function api(p, retry = true) {
  if (!cookie || Date.now() - cookieAt > 20 * 60e3) await newSession();
  requests++;
  const r = await fetch(D + p, { headers: { "user-agent": UA, cookie, accept: "application/json, text/plain, */*", "accept-language": "fr-FR,fr;q=0.9" } });
  if ((r.status === 401 || r.status === 403) && retry) { await newSession(); return api(p, false); }
  if (r.status === 429) { const e = new Error("HTTP 429 (Vinted limite le débit)"); e.rate = true; throw e; }
  if (!r.ok) throw new Error(p.split("?")[0] + " -> HTTP " + r.status);
  return r.json();
}
async function cardImage(w) {
  const k = key(w);
  if (imgCache.has(k)) return imgCache.get(k);
  let img = w.img || "";
  if (!img && w.id) {
    try {
      const r = await fetch(`https://api.tcgdex.net/v2/${w.l === "JP" ? "ja" : "fr"}/cards/${encodeURIComponent(w.id)}`);
      const j = await r.json();
      if (j.image) img = j.image + "/high.webp";
    } catch {}
  }
  imgCache.set(k, img);
  return img;
}

async function searchOne(w) {
  const q = new URLSearchParams({ search_text: w.q, order: "newest_first", per_page: "40" });
  const res = await api("/api/v2/catalog/items?" + q);
  const rar = new RegExp("\\b" + w.r + "\\b", "i");
  const items = (res.items || [])
    .filter(it => rar.test(it.title) && (w.l === "JP") === JP.test(it.title))
    .map(it => ({
      id: it.id, title: it.title, v: price(it.price), u: it.url || `${D}/items/${it.id}`,
      photo: it.photo?.url || it.photo?.full_size_url || "", at: it.photo?.high_resolution?.timestamp ? it.photo.high_resolution.timestamp * 1000 : 0,
    }))
    .filter(it => it.v > 0)
    .sort((a, b) => a.v - b.v)
    .slice(0, 12);
  const img = await cardImage(w);
  const out = [];
  for (const it of items) {
    const desc = descCache.get(it.id);
    if (desc === undefined) { if (!detailQueue.includes(it.id)) detailQueue.push(it.id); }
    else if (BAD.test(desc)) continue;
    if (it.v <= 1 && desc === undefined) continue; // 1 € : on attend la description avant d'afficher
    out.push({ n: w.n, s: w.s, l: w.l, r: w.r, t: w.t, cm: w.cm, v: it.v, u: it.u, vid: it.id, title: it.title, vimg: it.photo, img, desc: (desc || "").slice(0, 140) });
    if (out.length >= KEEP) break;
  }
  state.set(key(w), out);
}

async function readDetail(id) {
  const j = await api(`/api/v2/items/${id}`);
  const desc = j.item?.description || "";
  descCache.set(id, desc);
  if (descCache.size > 5000) descCache.delete(descCache.keys().next().value);
  if (BAD.test(desc)) for (const [k, list] of state) state.set(k, list.filter(d => d.vid !== id));
  else for (const list of state.values()) for (const d of list) if (d.vid === id) d.desc = desc.slice(0, 140);
}

// ---------- boucle : 1 requête par INTERVAL ----------
async function tick() {
  if (Date.now() < blockedUntil) return;
  try {
    if (detailQueue.length && cursor % 2 === 1) await readDetail(detailQueue.shift());
    else {
      if (!watch.length) return;
      const w = watch[cursor % watch.length];
      await searchOne(w);
      if (cursor % watch.length === watch.length - 1) cycles++;
    }
    cursor++; lastOk = Date.now(); lastError = "";
  } catch (e) {
    lastError = e.message; cursor++;
    console.error(new Date().toLocaleTimeString("fr-FR"), "ERREUR", e.message);
    if (e.rate) { blockedUntil = Date.now() + 30e3; console.error("Pause de 30 s pour laisser Vinted respirer."); }
  }
}
(async function loop() { for (;;) { const t0 = Date.now(); await tick(); await sleep(Math.max(0, INTERVAL - (Date.now() - t0))); } })();

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/deals") {
    const deals = [...state.values()].flat();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({
      live: true, now: Date.now(), lastOk, lastError, requests, cycles,
      blocked: Date.now() < blockedUntil, intervalMs: INTERVAL, cards: watch.length, deals,
    }));
  }
  let p = decodeURIComponent(u.pathname); if (p === "/") p = "/index.html";
  const f = path.join(ROOT, path.normalize(p));
  if (!f.startsWith(ROOT) || /server\.mjs|node_modules/.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`PokéFlip prêt : http://localhost:${PORT}  (Vinted interrogé toutes les ${INTERVAL} ms)`));
