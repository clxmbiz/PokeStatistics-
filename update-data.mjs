// Usage : node tools/update-data.mjs   (Node 18+)
// Lit watchlist.json, cherche les annonces Vinted, écarte les annonces « ne pas acheter » à ~1 €,
// compare à la cote Cardmarket (champ cm) et réécrit la section "deals" de data.json.
import fs from "node:fs";
const D = "https://www.vinted.fr";
const BAD = /ne\s*pas\s*(acheter|commander)|n['’]ach[eè]te[zs]?\s*pas|do\s*not\s*buy|don['’]?t\s*buy|pas\s*(à|a)\s*vendre|annonce\s*(test|bidon|factice)/i;
const JP = /jap|jpn|\bjp\b|日本/i;
const watch = JSON.parse(fs.readFileSync("watchlist.json", "utf8"));
const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const price = p => parseFloat(typeof p === "object" ? p.amount : p);

async function session() {
  const r = await fetch(D + "/", { headers: { "user-agent": "Mozilla/5.0" } });
  return (r.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
}
async function api(path, cookie) {
  const r = await fetch(D + path, { headers: { "user-agent": "Mozilla/5.0", cookie, accept: "application/json" } });
  if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
  return r.json();
}
async function cardImage(w) {
  if (w.img) return w.img;
  if (!w.id) return "";
  try {
    const r = await fetch(`https://api.tcgdex.net/v2/${w.l === "JP" ? "ja" : "fr"}/cards/${encodeURIComponent(w.id)}`);
    const j = await r.json();
    return j.image ? j.image + "/high.webp" : "";
  } catch { return ""; }
}

const cookie = await session();
const deals = [];
for (const w of watch) {
  try {
    const res = await api(`/api/v2/catalog/items?search_text=${encodeURIComponent(w.q)}&order=relevance&per_page=40`, cookie);
    const rar = new RegExp("\\b" + w.r + "\\b", "i");
    let items = (res.items || [])
      .filter(it => rar.test(it.title) && (w.l === "JP") === JP.test(it.title))
      .map(it => ({ id: it.id, title: it.title, v: price(it.price), u: it.url }))
      .filter(it => it.v > 0).sort((a, b) => a.v - b.v).slice(0, 8);
    const img = await cardImage(w);
    let kept = 0;
    for (const it of items) {
      if (kept >= 3) break;
      let desc = "";
      try { desc = (await api(`/api/v2/items/${it.id}`, cookie)).item?.description || ""; await sleep(800); } catch {}
      if (BAD.test(desc)) continue;            // annonce « ne pas acheter »
      if (it.v <= 1 && !desc) continue;        // 1 € impossible à vérifier : on écarte
      deals.push({ n: w.n, s: w.s, l: w.l, r: w.r, t: w.t, v: it.v, cm: w.cm, u: it.u, img, desc: desc.slice(0, 140) });
      kept++;
    }
    console.log(w.n, "->", kept, "annonce(s)");
  } catch (e) { console.error(w.n, "ERREUR", e.message); }
  await sleep(1500);
}
if (deals.length) { data.deals = deals; data.updated = new Date().toISOString(); fs.writeFileSync("data.json", JSON.stringify(data, null, 1)); }
else console.error("Aucune annonce récupérée : data.json inchangé.");
