// Nationale filiaal-scraper — geport van app/api/scrape-stores.
// Hybride: chain-API's (Lidl/Delhaize/Aveve) + Overpass OSM-fallback. Rijkere Delhaize-
// weekuren via stores.delhaize.be (Mobilosoft). Schrijft Supabase cache-key "national_stores".
// Vervangt de oudere /dump-stores GQL-aanpak (die mist per-store weekuren).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CLOSED_STORES = new Set([
  "50.7297,3.303974", // Delhaize Dottignies (7711) — gesloten 31 maart 2026
]);

const SUPABASE_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const EMPTY_WEEK = () => ["", "", "", "", "", "", ""];

// Op Railway is er geen platform-maxDuration (anders dan Vercel's 300s); Overpass-mirrors
// kunnen per fetch tot de AbortSignal-timeout hangen. Begrens de Overpass-fase in code,
// anders kan de stores-scrape tientallen minuten blijven draaien. Chain-API's (Lidl/
// Delhaize/Aveve) leveren de kerndata; ontbrekende Overpass-ketens vallen terug op cache.
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchLidl() {
  const stores = [];
  const apiKey = process.env.LIDL_STORE_API_KEY || "KxboQtt40BG4VpBL16IhaRd2CXh0QbAc";
  for (let offset = 0; offset < 1000; offset += 250) {
    const res = await fetch(
      `https://live.api.schwarz/odj/stores-api/v2/myapi/stores-frontend/stores?locale=nl-BE&country_code=BE&offset=${offset}&limit=250`,
      { headers: { "x-apikey": apiKey, "User-Agent": UA }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) break;
    const json = await res.json();
    const items = json.items || json || [];
    if (!items.length) break;
    for (const s of items) {
      const lat = s.address?.latitude, lon = s.address?.longitude;
      if (!lat || !lon) continue;
      stores.push({
        lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
        name: s.storeName || "Lidl", city: s.address.city || "",
        street: s.address.streetName || "", housenumber: s.address.streetNumber || "",
        postcode: s.address.zip || "",
      });
    }
    if (items.length < 250) break;
  }
  return stores;
}

const DELHAIZE_GRID = [
  [51.22, 4.40], [51.05, 3.72], [51.21, 3.22], [50.93, 5.34], [50.88, 4.70],
  [50.85, 4.35], [50.47, 4.87], [50.63, 5.57], [50.41, 4.44], [50.45, 3.95],
  [50.83, 3.26], [51.23, 2.92], [51.03, 4.48], [50.94, 4.04], [51.32, 4.94],
  [50.97, 5.50], [50.95, 3.12], [51.16, 4.14], [50.72, 4.60], [50.59, 5.86],
  [49.68, 5.81], [50.61, 3.39], [50.00, 5.72], [50.26, 4.91], [50.85, 2.89], [51.03, 2.86],
];

function delhaizeWeek(businessHours) {
  const week = EMPTY_WEEK();
  for (const b of businessHours || []) {
    const o = b.openTimeFormat, c = b.closeTimeFormat;
    if (!o || !c) continue;
    for (let d = b.startDay; d <= b.endDay; d++) {
      if (d >= 1 && d <= 7) week[d - 1] = `${o}-${c}`;
    }
  }
  return week;
}

async function fetchDelhaize() {
  const byGuid = new Map();
  await mapLimit(DELHAIZE_GRID, 6, async ([lat, lng]) => {
    const res = await fetch(
      `https://stores.delhaize.be/locations?version=v3&near=${lat},${lng}&size=200&radius=15000&searchType=NEAR`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) return;
    const text = new TextDecoder("windows-1252").decode(await res.arrayBuffer());
    let arr;
    try { arr = JSON.parse(text); } catch { return; }
    for (const s of arr || []) {
      const a = s.address || {};
      if (!a.latitude || !a.longitude || byGuid.has(s.guid)) continue;
      byGuid.set(s.guid, {
        lat: Math.round(a.latitude * 1e6) / 1e6, lon: Math.round(a.longitude * 1e6) / 1e6,
        name: s.name ? (/delhaize/i.test(s.name) ? s.name.trim() : `Delhaize ${s.name.trim()}`) : "Delhaize",
        city: a.locality || "", street: a.street || "", housenumber: a.number || "",
        postcode: a.zipCode || "", hours: delhaizeWeek(s.businessHours),
      });
    }
  });
  return [...byGuid.values()];
}

async function fetchAveve() {
  const stores = [];
  try {
    const res = await fetch("https://www.aveve.be/nl/winkels", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return stores;
    const html = await res.text();
    const jsonMatch = html.match(/(\[\s*\{[^}]*"lat"[\s\S]*?\}\s*\])/);
    if (!jsonMatch) return stores;
    const arr = JSON.parse(jsonMatch[1]);
    for (const s of arr) {
      if (!s.lat || !s.lng) continue;
      const p = (s.address || "").match(/^(.+?)\s*,\s*(\d{4})\s+(.+)$/);
      stores.push({
        lat: Math.round(s.lat * 1e6) / 1e6, lon: Math.round(s.lng * 1e6) / 1e6,
        name: s.name || "Aveve", street: p?.[1] || s.address || "",
        housenumber: "", postcode: p?.[2] || "", city: p?.[3] || "",
      });
    }
  } catch {}
  return stores;
}

const BBOX = "49.5,2.5,51.5,6.4";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
];

const OVERPASS_CHAINS = [
  { match: /colruyt/i, name: "Colruyt" },
  { match: /aldi/i, name: "Aldi" },
  { match: /jumbo/i, name: "Jumbo" },
  { match: /albert heijn/i, name: "Albert Heijn" },
  { match: /action/i, name: "Action" },
  { match: /carrefour/i, name: "Carrefour" },
  { match: /\bokay\b/i, name: "OKay" },
  { match: /bio-planet|bio planet/i, name: "Bio-Planet" },
  { match: /hubo/i, name: "Hubo" },
  { match: /\bbrico\b/i, name: "Brico" },
  { match: /intermarché|intermarche/i, name: "Intermarché" },
  { match: /bon.?ap/i, name: "Bon'Ap" },
  { match: /aveve/i, name: "Aveve" },
  { match: /coolblue/i, name: "Coolblue" },
  { match: /delitraiteur/i, name: "Delitraiteur" },
  { match: /tom\s*&?\s*co/i, name: "Tom & Co" },
];

async function queryOverpass(query) {
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "dealoco-store-locator/1.0 (hallo@dealoco.be)",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(35_000),
      });
      if (res.ok) return await res.json();
      console.log(`Overpass ${url} returned ${res.status}`);
    } catch (err) {
      console.log(`Overpass ${url} error: ${err.message}`);
    }
  }
  return null;
}

async function fetchOverpassChains() {
  const stores = {};
  for (const c of OVERPASS_CHAINS) stores[c.name] = [];

  const queries = [
    `[out:json][timeout:120][bbox:${BBOX}];(nw["shop"~"^(supermarket|variety_store|discount)$"];);out center;`,
    `[out:json][timeout:120][bbox:${BBOX}];(nw["shop"~"^(doityourself|garden_centre)$"];nw["shop"="butcher"]["name"~"Bon.?Ap",i];);out center;`,
    `[out:json][timeout:120][bbox:${BBOX}];(nw["shop"="electronics"]["name"~"Coolblue",i];);out center;`,
    `[out:json][timeout:120][bbox:${BBOX}];(nw["name"~"Delitraiteur",i];);out center;`,
    `[out:json][timeout:120][bbox:${BBOX}];(nw["shop"="pet"]["name"~"Tom.*Co",i];);out center;`,
  ];

  for (const q of queries) {
    const data = await queryOverpass(q);
    if (data?.elements) {
      for (const el of data.elements) {
        const name = el.tags?.name;
        if (!name) continue;
        const chain = OVERPASS_CHAINS.find(c => c.match.test(name));
        if (!chain) continue;
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (!lat || !lon) continue;
        const tags = el.tags || {};
        stores[chain.name].push({
          lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
          name: tags.name || "", city: tags["addr:city"] || tags["addr:municipality"] || "",
          street: tags["addr:street"] || "", housenumber: tags["addr:housenumber"] || "",
          postcode: tags["addr:postcode"] || "", opening_hours: tags["opening_hours"] || "",
        });
      }
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  for (const chain of Object.keys(stores)) {
    const seen = new Set();
    stores[chain] = stores[chain].filter(s => {
      const key = `${s.lat},${s.lon}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return stores;
}

export async function scrapeNationalStores() {
  const results = {};
  const errors = [];

  const [lidl, delhaize, aveve, overpassStores] = await Promise.allSettled([
    fetchLidl().catch(e => { errors.push(`Lidl: ${e.message}`); return []; }),
    fetchDelhaize().catch(e => { errors.push(`Delhaize: ${e.message}`); return []; }),
    fetchAveve().catch(e => { errors.push(`Aveve: ${e.message}`); return []; }),
    withTimeout(fetchOverpassChains(), 120_000, {}).catch(e => { errors.push(`Overpass: ${e.message}`); return {}; }),
  ]);

  if (lidl.value?.length) results["Lidl"] = lidl.value;
  if (delhaize.value?.length) results["Delhaize"] = delhaize.value;
  if (aveve.value?.length) results["Aveve"] = aveve.value;

  const osm = overpassStores.value || {};
  for (const [chain, locs] of Object.entries(osm)) {
    if (locs.length > 0 && !results[chain]) results[chain] = locs;
  }

  // Overpass faalt → merge cached data voor ontbrekende ketens
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const missingChains = [...OVERPASS_CHAINS.map(c => c.name), "Lidl", "Delhaize"]
      .filter(c => !results[c] || results[c].length === 0);
    if (missingChains.length > 0) {
      try {
        const cacheRes = await fetch(
          `${SUPABASE_URL}/rest/v1/cache?key=eq.national_stores&select=data`,
          { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
        );
        if (cacheRes.ok) {
          const rows = await cacheRes.json();
          const cached = rows[0]?.data;
          if (cached) {
            for (const chain of missingChains) {
              if (cached[chain]?.length > 0) {
                results[chain] = cached[chain];
                errors.push(`${chain}: used cached data (${cached[chain].length} stores)`);
              }
            }
          }
        }
      } catch {}
    }
  }

  for (const [chain, stores] of Object.entries(results)) {
    results[chain] = stores.filter(s => !CLOSED_STORES.has(`${s.lat},${s.lon}`));
  }

  const totalStores = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  const summary = Object.fromEntries(
    Object.entries(results).map(([k, v]) => [k, v.length]).filter(([, v]) => v > 0)
  );

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY && totalStores > 0) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
      method: "POST",
      headers: SUPABASE_HEADERS,
      body: JSON.stringify({ key: "national_stores", data: results, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) console.error("Failed to write national_stores:", res.status);
  }

  return { ok: totalStores > 0, total: totalStores, chains: summary, errors: errors.length ? errors : undefined };
}
