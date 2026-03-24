const express = require("express");
const { chromium } = require("playwright");
const { scrapeColruyt } = require("./scrapers/colruyt");
const { scrapeLidl } = require("./scrapers/lidl");
const { scrapeDelhaize } = require("./scrapers/delhaize");
const { scrapeCarrefour } = require("./scrapers/carrefour");
const { scrapeAldi } = require("./scrapers/aldi");
const { scrapeSpar } = require("./scrapers/spar");
const { scrapeAlbertHeijn } = require("./scrapers/albert-heijn");

const app = express();
const PORT = process.env.PORT || 3001;

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  return chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

async function scrapeAll() {
  console.log("[DealRadar] Starting scrape...");
  const browser = await launchBrowser();

  const scrapers = [
    { name: "Colruyt",      fn: () => scrapeColruyt(browser) },
    { name: "Albert Heijn", fn: () => scrapeAlbertHeijn(browser) },
    { name: "Lidl",         fn: () => scrapeLidl(browser) },
    { name: "Delhaize",     fn: () => scrapeDelhaize(browser) },
    { name: "Carrefour",    fn: () => scrapeCarrefour(browser) },
    { name: "Aldi",         fn: () => scrapeAldi(browser) },
    { name: "Spar",         fn: () => scrapeSpar(browser) },
  ];

  // Run scrapers sequentially to avoid overloading the browser
  const deals = [];
  for (const { name, fn } of scrapers) {
    try {
      const result = await fn();
      console.log(`[DealRadar] ${name}: ${result.length} deals`);
      deals.push(...result);
    } catch (err) {
      console.error(`[DealRadar] ${name} FAILED:`, err.message);
    }
  }

  await browser.close();
  console.log(`[DealRadar] Total: ${deals.length} deals`);
  return deals;
}

app.get("/api/deals", async (req, res) => {
  try {
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
      return res.json(cache);
    }
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
  let browser;
  try {
    browser = await launchBrowser();
    results.browser = { ok: true };
  } catch (e) {
    return res.json({ browser: { ok: false, error: e.message } });
  }

  const scrapers = [
    { name: "colruyt",      fn: () => scrapeColruyt(browser) },
    { name: "albertHeijn",  fn: () => scrapeAlbertHeijn(browser) },
    { name: "lidl",         fn: () => scrapeLidl(browser) },
    { name: "delhaize",     fn: () => scrapeDelhaize(browser) },
    { name: "carrefour",    fn: () => scrapeCarrefour(browser) },
    { name: "aldi",         fn: () => scrapeAldi(browser) },
    { name: "spar",         fn: () => scrapeSpar(browser) },
  ];

  for (const { name, fn } of scrapers) {
    try {
      const deals = await fn();
      results[name] = { ok: true, count: deals.length, sample: deals[0]?.item || null };
    } catch (e) {
      results[name] = { ok: false, error: e.message };
    }
  }

  await browser.close();
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

app.listen(PORT, () => {
  console.log(`[DealRadar] Scraper service running on port ${PORT}`);
  scrapeAll().then(deals => {
    cache = deals;
    cacheTime = Date.now();
  }).catch(err => console.error("[DealRadar] Warmup failed:", err.message));
});
