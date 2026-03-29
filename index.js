const express = require("express");
const { chromium } = require("playwright");
const { scrapeColruyt } = require("./scrapers/colruyt");
const { scrapeLidl } = require("./scrapers/lidl");
const { scrapeDelhaize } = require("./scrapers/delhaize");
const { scrapeCarrefour } = require("./scrapers/carrefour");
const { scrapeAldi } = require("./scrapers/aldi");
const { scrapeSpar } = require("./scrapers/spar");
const { scrapeAlbertHeijn } = require("./scrapers/albert-heijn");
const { scrapeOkay } = require("./scrapers/okay");

const app = express();
const PORT = process.env.PORT || 3001;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function saveToSupabase(deals) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key: "deals", data: deals, updated_at: new Date().toISOString() }),
    });
    if (res.ok) console.log(`[DealRadar] Supabase: ${deals.length} deals opgeslagen`);
    else console.error("[DealRadar] Supabase save mislukt:", res.status);
  } catch (err) {
    console.error("[DealRadar] Supabase save error:", err.message);
  }
}

async function loadFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cache?key=eq.deals&select=data,updated_at`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows[0] || null;
  } catch (err) {
    console.error("[DealRadar] Supabase load error:", err.message);
    return null;
  }
}

function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  return chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}


// Elke Playwright-scraper draait in een geïsoleerde browser om crashes te voorkomen
async function runWithBrowser(name, scraperFn) {
  const browser = await launchBrowser();
  try {
    const deals = await scraperFn(browser);
    console.log(`[DealRadar] ${name}: ${deals.length} deals`);
    return deals;
  } catch (err) {
    console.error(`[DealRadar] ${name} FAILED:`, err.message);
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}

async function scrapeAll() {
  console.log("[DealRadar] Starting scrape...");
  const deals = [];

  // HTTP-scrapers parallel — geen browser nodig
  const httpResults = await Promise.allSettled([
    scrapeSpar(null).then(r => { console.log(`[DealRadar] Spar: ${r.length} deals`); return r; }).catch(e => { console.error("[DealRadar] Spar FAILED:", e.message); return []; }),
    scrapeAldi(null).then(r => { console.log(`[DealRadar] Aldi: ${r.length} deals`); return r; }).catch(e => { console.error("[DealRadar] Aldi FAILED:", e.message); return []; }),
    scrapeLidl(null).then(r => { console.log(`[DealRadar] Lidl: ${r.length} deals`); return r; }).catch(e => { console.error("[DealRadar] Lidl FAILED:", e.message); return []; }),
    scrapeDelhaize(null).then(r => { console.log(`[DealRadar] Delhaize: ${r.length} deals`); return r; }).catch(e => { console.error("[DealRadar] Delhaize FAILED:", e.message); return []; }),
  ]);
  deals.push(...httpResults.flatMap(r => r.status === "fulfilled" ? r.value : []));

  // Playwright-scrapers sequentieel, elk met eigen browser — crashes cascaderen niet
  // AH verwijderd: laadt producten alleen na inloggen (3239 skeletons, €0.00 placeholder)
  for (const { name, fn } of [
    { name: "OKay", fn: b => scrapeOkay(b) },
  ]) {
    deals.push(...await runWithBrowser(name, fn));
  }

  console.log(`[DealRadar] Totaal: ${deals.length} deals`);
  await saveToSupabase(deals);
  return deals;
}

let refreshing = false;

function refreshInBackground() {
  if (refreshing) return;
  refreshing = true;
  scrapeAll()
    .then(deals => { cache = deals; cacheTime = Date.now(); })
    .catch(err => console.error("[DealRadar] Background refresh failed:", err.message))
    .finally(() => { refreshing = false; });
}

app.get("/api/deals", async (req, res) => {
  try {
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
      return res.json(cache);
    }
    // Cache expired — return stale data immediately, refresh in background
    if (cache) {
      res.json(cache);
      refreshInBackground();
      return;
    }
    // First boot — must wait
    const deals = await scrapeAll();
    cache = deals;
    cacheTime = Date.now();
    res.json(deals);
  } catch (err) {
    console.error("[DealRadar] Fatal error:", err);
    if (cache) return res.json(cache);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({
  ok: true,
  cachedAt: cacheTime ? new Date(cacheTime).toISOString() : null,
  dealCount: cache?.length ?? 0,
}));

app.get("/debug", async (req, res) => {
  const results = {};

  // HTTP-scrapers (geen browser)
  for (const [name, fn] of [
    ["lidl",     () => scrapeLidl(null)],
    ["delhaize", () => scrapeDelhaize(null)],
    ["aldi",     () => scrapeAldi(null)],
    ["spar",     () => scrapeSpar(null)],
  ]) {
    try {
      const deals = await fn();
      results[name] = { ok: true, count: deals.length, sample: deals[0]?.item || null };
    } catch (e) {
      results[name] = { ok: false, error: e.message };
    }
  }

  // Playwright-scrapers elk met eigen browser
  for (const [name, fn] of [
    ["okay", b => scrapeOkay(b)],
  ]) {
    const deals = await runWithBrowser(name, fn);
    results[name] = { ok: true, count: deals.length, sample: deals[0]?.item || null };
  }

  res.json(results);
});

const STORE_URLS = {
  colruyt: "https://www.colruyt.be/nl/promoties",
  ah: "https://www.ah.nl/bonus",
  lidl: "https://www.lidl.be/c/nl-BE/promoties/s10007548",
  delhaize: "https://www.delhaize.be/nl/promoties",
  carrefour: "https://www.carrefour.be/nl/acties",
  aldi: "https://www.aldi.be/nl/weekaanbieding.html",
  spar: "https://www.mijnspar.be/nl/promoties",
};

app.get("/rawproduct/:store", async (req, res) => {
  const storeMap = {
    lidl: { url: "https://www.lidl.be/q/nl-BE/query/promo", cookie: "#onetrust-accept-btn-handler" },
    aldi: { url: "https://www.aldi.be/nl/onze-aanbiedingen.html", cookie: null },
    delhaize: { url: "https://www.delhaize.be/nl/promoties", cookie: "#didomi-notice-agree-button" },
  };
  const cfg = storeMap[req.params.store];
  if (!cfg) return res.status(404).json({ error: "Unknown store" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    const captured = [];

    const allUrls = []; // ALL responses, not just JSON
    page.on("response", async (response) => {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";
      // Log all lidl.be responses for debugging
      if (url.includes("lidl") || ct.includes("json") || ct.includes("mindshift")) {
        allUrls.push({ url: url.slice(0, 150), ct: ct.slice(0, 60), status: response.status() });
      }
      if (!ct.includes("json") && !ct.includes("mindshift") && !ct.includes("text/plain")) return;
      try {
        const body = await response.text();
        const json = JSON.parse(body);
        const arr = json.products || json.results || json.hits || json.items
          || json.gridElements || json.searchResult?.gridElements
          || json.data?.products || (Array.isArray(json) ? json : null);
        if (Array.isArray(arr) && arr.length > 0) {
          captured.push({ url: url.slice(0, 150), count: arr.length, sample: arr[0] });
        } else if (typeof json === "object" && Object.keys(json).length > 0 && !url.includes("cookielaw") && !url.includes("onetrust") && !url.includes("batch.com")) {
          captured.push({ url: url.slice(0, 150), topKeys: Object.keys(json).slice(0, 10), snippet: JSON.stringify(json).slice(0, 300) });
        }
      } catch { /* skip */ }
    });

    await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    let cookieClicked = false;
    if (cfg.cookie) {
      try {
        await page.waitForSelector(cfg.cookie, { timeout: 10000 });
        await page.click(cfg.cookie);
        cookieClicked = true;
      } catch { /* no banner */ }
    }
    // Wacht langer na cookie accept — SPA herlaadt soms de pagina
    await page.waitForTimeout(cookieClicked ? 8000 : 3000);
    for (let i = 1; i <= 6; i++) {
      await page.evaluate((pct) => window.scrollTo(0, document.body.scrollHeight * pct), i / 6);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(5000);

    // Extract eerste product uit __NUXT_DATA__ met volledige structuur
    let nextData = null;
    try {
      nextData = await page.evaluate(() => {
        const nuxtEl = document.getElementById("__NUXT_DATA__");
        if (!nuxtEl) return { type: "none" };
        const arr = JSON.parse(nuxtEl.textContent);
        function resolve(idx, seen = new Set()) {
          if (idx === null || idx === undefined || typeof idx !== "number") return idx;
          if (seen.has(idx)) return null;
          seen.add(idx);
          const val = arr[idx];
          if (val === null || val === undefined || typeof val !== "object") return val;
          if (Array.isArray(val)) {
            if (val[0] === "ShallowReactive" || val[0] === "Reactive") return resolve(val[1], new Set(seen));
            if (val[0] === "Set") return val.slice(1).map(i => resolve(i, new Set(seen)));
            return val.map(i => (typeof i === "number" ? resolve(i, new Set(seen)) : i));
          }
          const out = {};
          for (const [k, v] of Object.entries(val)) {
            out[k] = typeof v === "number" ? resolve(v, new Set(seen)) : v;
          }
          return out;
        }
        // Vind useProductStore
        let storeIdx = null;
        for (let i = 0; i < Math.min(arr.length, 50); i++) {
          const v = arr[i];
          if (v && typeof v === "object" && !Array.isArray(v) && "useProductStore" in v) {
            storeIdx = v["useProductStore"]; break;
          }
        }
        if (storeIdx === null) return { type: "nuxt", error: "geen productStore" };
        const store = resolve(storeIdx);
        // Vind de eerste product-array
        function findFirst(obj, depth = 0) {
          if (depth > 5 || !obj || typeof obj !== "object") return null;
          if (Array.isArray(obj) && obj.length > 0 && obj[0] && typeof obj[0] === "object") return obj;
          if (!Array.isArray(obj)) { for (const v of Object.values(obj)) { const f = findFirst(v, depth+1); if (f) return f; } }
          return null;
        }
        const products = findFirst(store);
        return {
          type: "nuxt",
          storeIdx,
          storeKeys: store ? Object.keys(store) : [],
          productCount: products?.length,
          firstProduct: products?.[0],
          secondProduct: products?.[1],
        };
      });
    } catch (e) { nextData = { error: e.message }; }

    await browser.close();
    res.json({ cookieClicked, captured: captured.slice(0, 20), allLidlUrls: allUrls.slice(0, 30), nextData });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

app.get("/supabase-test", async (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return res.json({ ok: false, error: "Env vars ontbreken", SUPABASE_URL: !!url, SUPABASE_ANON_KEY: !!key });
  try {
    const r = await fetch(`${url}/rest/v1/cache`, {
      method: "POST",
      headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ key: "railway-test", data: { ts: new Date().toISOString() }, updated_at: new Date().toISOString() }),
    });
    const body = await r.text();
    res.json({ ok: r.ok, status: r.status, body: body || "(leeg = success)", SUPABASE_URL: url.slice(0, 30) + "..." });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/sparjson", async (req, res) => {
  try {
    const apiUrl = "https://www.mijnspar.be/content/spar/nl/promoties/jcr:content/root/responsivegrid/responsivegrid/responsivegrid/filter_list_store_sp.model.json";
    const r = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://www.mijnspar.be/nl/promoties",
      },
    });
    const data = await r.json();
    const results = data.results || [];
    res.json({
      total: results.length,
      firstItemKeys: results[0] ? Object.keys(results[0]) : [],
      firstItem: results[0] || null,
      secondItem: results[1] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/dump/:store", async (req, res) => {
  const url = STORE_URLS[req.params.store];
  if (!url) return res.status(404).json({ error: "Unknown store" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    const intercepted = [];

    page.on("response", async (response) => {
      const rUrl = response.url();
      const ct = response.headers()["content-type"] || "";
      if (ct.includes("application/json")) {
        try {
          const json = await response.json();
          intercepted.push({ url: rUrl, keys: Object.keys(json), sample: JSON.stringify(json).slice(0, 500) });
        } catch { /* skip */ }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    const info = await page.evaluate(() => {
      // Count classes
      const classCounts = {};
      for (const el of document.querySelectorAll("*")) {
        for (const cls of el.classList) {
          classCounts[cls] = (classCounts[cls] || 0) + 1;
        }
      }
      const topClasses = Object.entries(classCounts)
        .filter(([, c]) => c >= 4 && c <= 60)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([cls, count]) => ({ cls, count }));

      // Sample HTML from likely product areas
      const bodyHtml = document.body?.innerHTML?.slice(0, 8000) || "";

      return { title: document.title, url: location.href, topClasses, bodyHtml };
    });

    await browser.close();
    res.json({ ...info, intercepted: intercepted.slice(0, 10) });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// Test Lidl API direct vanaf Railway
app.get("/lidl-test", async (req, res) => {
  try {
    const url = "https://www.lidl.be/q/api/query/promo?assortment=BE&locale=nl_BE&version=v2.0.0&size=5";
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "nl-BE,nl;q=0.9",
        "Referer": "https://www.lidl.be/q/nl-BE/query/promo",
      },
    });
    const data = await r.json();
    const item0 = data.items?.[0]?.gridbox?.data;
    res.json({
      status: r.status,
      numFound: data.numFound,
      type: data.type,
      itemCount: data.items?.length,
      firstItem: item0 ? { title: item0.title, price: item0.price?.price, oldPrice: item0.price?.oldPrice } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Forceer verse scrape op achtergrond (behoudt stale cache)
app.get("/force-refresh", (req, res) => {
  cacheTime = 0; // markeer als verlopen maar gooi stale data niet weg
  refreshInBackground();
  res.json({ ok: true, message: "Refresh gestart op achtergrond", currentDealCount: cache?.length ?? 0 });
});

app.listen(PORT, () => {
  console.log(`[DealRadar] Scraper service running on port ${PORT}`);
  // Laad eerst Supabase cache — vermijd onnodige scrape bij herstart
  loadFromSupabase().then(row => {
    if (row?.data?.length > 0) {
      cache = row.data;
      cacheTime = new Date(row.updated_at).getTime();
      console.log(`[DealRadar] Supabase: ${cache.length} deals hersteld (${row.updated_at})`);
      if (Date.now() - cacheTime >= CACHE_TTL) {
        console.log("[DealRadar] Cache verlopen, refresh op achtergrond...");
        refreshInBackground();
      }
    } else {
      console.log("[DealRadar] Geen Supabase data, scrape gestart...");
      scrapeAll().then(deals => { cache = deals; cacheTime = Date.now(); })
                 .catch(err => console.error("[DealRadar] Warmup mislukt:", err.message));
    }
  }).catch(() => {
    scrapeAll().then(deals => { cache = deals; cacheTime = Date.now(); })
               .catch(err => console.error("[DealRadar] Warmup mislukt:", err.message));
  });
});
