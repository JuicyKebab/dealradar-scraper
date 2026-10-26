// Prijsgeschiedenis voor Railway scrapers — identiek aan app/lib/priceHistory.js
// maar zonder Next.js module-aliassen

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Winkels waar de deal-`id` NIET uit een echte catalogus-code komt (Jumbo:
// hash(naam); Action/Alvo: slug; Renmans: md5(naam) + per-filiaal, terwijl de
// frontend per item dedupt). Voor deze winkels: EAN uit de image indien
// aanwezig, anders de naam (NOOIT de id-slug). Zie app/lib/priceHistory.js.
const NAME_KEYED_STORES = new Set(["jumbo", "action", "alvo", "renmans"]);

// Schrijf-guards tegen vervuilde prijsgeschiedenis (debug 2026-10-14). Zie app/lib.
const MULTIBUY_RE = /gratis|\d+\s*\+\s*\d+|\b\d+\s*voor\b|\b2e\b|tweede|halve|aan\s*-?\s*\d+\s*%/i;
const GENERIC_NAMES = new Set(["original", "aardbei", "natuur", "classic", "promo", "mix", "duo", "assorti", "value", "family"]);
const isNameKey = (key) => key && !key.includes("|id:") && !key.includes("|ean:");
function isGenericNameKey(key) {
  const name = key.slice(key.indexOf("|") + 1);
  return name.length < 5 || GENERIC_NAMES.has(name);
}
const hasRealId = (d) =>
  d && !NAME_KEYED_STORES.has(String(d.store || "").toLowerCase()) &&
  d.id != null && String(d.id).trim() !== "";

// Bepaalt of/onder welke key een deal gelogd mag worden (3 bugs, zie app/lib).
export function logKeyFor(d, storesWithId) {
  const key = normalizeItemKey(d.store, d.item, d.id, d.image);
  if (!key) return null;
  if (isNameKey(key)) {
    const s = String(d.store || "").toLowerCase();
    if (storesWithId.has(s)) return null;
    if (isGenericNameKey(key)) return null;
  }
  if (MULTIBUY_RE.test(d.deal || "") && !(parseFloat(d.unitPrice) > 0)) return null;
  return key;
}

function eanChecksumOk(code) {
  const n = code.length;
  if (n !== 13 && n !== 8) return false;
  const d = [...code].map(Number);
  let sum = 0;
  for (let i = n - 2, pos = 0; i >= 0; i--, pos++) {
    sum += d[i] * (pos % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === d[n - 1];
}

// Volledige cijfergroepen, exact 13 (EAN-13), checksum-geldig; LAATSTE wint.
// EAN-8 genegeerd: een 8-cijferige datum haalt anders de checksum. Zie app/lib.
export function extractEan(image) {
  if (!image) return null;
  let found = null;
  for (const r of String(image).match(/\d+/g) || []) {
    if (r.length === 13 && eanChecksumOk(r)) found = r;
  }
  return found;
}

export function normalizeItemKey(store, item, id, image) {
  if (!store) return null;
  const s = store.toLowerCase();
  const idStr = id != null && String(id).trim() !== "" ? String(id).trim().toLowerCase() : null;

  if (NAME_KEYED_STORES.has(s)) {
    const ean = extractEan(image);
    if (ean) return `${s}|ean:${ean}`;
    // geen id-fallback: naam-afgeleid/per-filiaal → val door naar naam
  } else if (idStr) {
    return `${s}|id:${idStr}`;
  }

  if (!item) return null;
  const normalized = item
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/,(\d)/g, ".$1")
    .replace(/[^\w\s.'-]/g, "")
    .trim();
  return `${s}|${normalized}`;
}

export async function logPrices(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  if (!deals || deals.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);

  // id-capabele winkels in deze batch (zie app/lib: voorkomt naam-collisie + fragmentatie)
  const storesWithId = new Set();
  for (const d of deals) if (hasRealId(d)) storesWithId.add(String(d.store).toLowerCase());

  const rowsRaw = deals
    .map(d => {
      const key = logKeyFor(d, storesWithId);
      if (!key) return null;
      // Prefer per-stuk prijs (AH multi-buy zet unitPrice); anders newPrice.
      const price = parseFloat(d.unitPrice) || parseFloat(d.newPrice) || 0;
      if (price <= 0) return null;
      return {
        store: d.store,
        item_key: key,
        item: d.item,
        price,
        original_price: parseFloat(d.originalPrice) || 0,
        savings: parseInt(d.savings) || 0,
        scraped_at: today,
      };
    })
    .filter(Boolean);

  if (rowsRaw.length === 0) return;

  // Dedup op (item_key, scraped_at) binnen de batch: ON CONFLICT kan dezelfde
  // rij niet twee keer raken in 1 command. Laatste voorkomen wint.
  const byKey = new Map();
  for (const r of rowsRaw) byKey.set(`${r.item_key}|${r.scraped_at}`, r);
  const rows = [...byKey.values()];

  if (rows.length === 0) return;

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      const res = await fetch(
        // RPC log_prices: enkel bij prijswijziging of heartbeat (>= 7d)
        `${SUPABASE_URL}/rest/v1/rpc/log_prices`,
        {
          method: "POST",
          headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ rows: chunk }),
        }
      );
      if (!res.ok) console.error(`[priceHistory] Write failed: ${res.status}`);
    } catch (err) {
      console.error(`[priceHistory] Error: ${err.message}`);
    }
  }
}
