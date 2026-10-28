// vinted.mjs — Node 18+ (fetch intégré), aucune dépendance
const BASE = process.env.VINTED_BASE || "https://www.vinted.fr";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  Referer: BASE + "/catalog",
};

let cookieJar = "";
let sessionAt = 0;
const SESSION_TTL = 20 * 60 * 1000; // renouvelle la session toutes les 20 min

async function refreshSession() {
  const res = await fetch(BASE, { headers: { ...HEADERS, Accept: "text/html" } });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  cookieJar = set.map((c) => c.split(";")[0]).join("; ");
  sessionAt = Date.now();
  if (!cookieJar) throw new Error("Aucun cookie reçu (page d'accueil bloquée ?) HTTP " + res.status);
}

async function request(path, retry = true) {
  if (!cookieJar || Date.now() - sessionAt > SESSION_TTL) await refreshSession();
  const res = await fetch(BASE + path, { headers: { ...HEADERS, Cookie: cookieJar } });
  if ((res.status === 401 || res.status === 403) && retry) {
    await refreshSession(); // un seul retry avec un cookie neuf
    return request(path, false);
  }
  if (!res.ok) {
    const err = new Error(`${path} -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function searchItems({ text, priceTo, perPage = 20 } = {}) {
  const p = new URLSearchParams({
    search_text: text || "",
    order: "newest_first",
    per_page: String(perPage),
  });
  if (priceTo) p.set("price_to", String(priceTo));
  const data = await request("/api/v2/catalog/items?" + p.toString());
  return data.items || [];
}

// Boucle : ~120 s ± 20 s, et délai croissant (5 → 10 → 20 → 30 min) après erreur
function startPolling(query, onItems, { interval = 120000, jitter = 20000 } = {}) {
  let failures = 0;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let wait;
    try {
      const items = await searchItems(query);
      failures = 0;
      onItems(items);
      wait = interval + (Math.random() * 2 - 1) * jitter;
    } catch (e) {
      failures++;
      wait = Math.min(5 * 60000 * 2 ** (failures - 1), 30 * 60000);
      console.error(`[vinted] ${e.message} — nouvel essai dans ${Math.round(wait / 1000)} s`);
    }
    setTimeout(tick, wait);
  };

  tick();
  return () => (stopped = true);
}

export { searchItems, startPolling };
