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

app.listen(PORT, () => {
  console.log(`[DealRadar] Scraper service running on port ${PORT}`);
  scrapeAll().then(deals => {
    cache = deals;
    cacheTime = Date.now();
  }).catch(err => console.error("[DealRadar] Warmup failed:", err.message));
});
