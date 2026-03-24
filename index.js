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

// Simple in-memory cache
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function scrapeAll() {
  console.log("[DealRadar] Starting scrape...");

  // Colruyt and AH don't need a browser
  const [colruytResult, ahResult] = await Promise.allSettled([
    scrapeColruyt(),
    scrapeAlbertHeijn(),
  ]);

  // Browser-based scrapers
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });

  let lidlResult, delhaizeResult, carrefourResult, aldiResult, sparResult;

  try {
    [lidlResult, delhaizeResult, carrefourResult, aldiResult, sparResult] =
      await Promise.allSettled([
        scrapeLidl(browser),
        scrapeDelhaize(browser),
        scrapeCarrefour(browser),
        scrapeAldi(browser),
        scrapeSpar(browser),
      ]);
  } finally {
    await browser.close();
  }

  const scrapers = [
    { name: "Colruyt", result: colruytResult },
    { name: "Albert Heijn", result: ahResult },
    { name: "Lidl", result: lidlResult },
    { name: "Delhaize", result: delhaizeResult },
    { name: "Carrefour", result: carrefourResult },
    { name: "Aldi", result: aldiResult },
    { name: "Spar", result: sparResult },
  ];

  const deals = scrapers.flatMap(({ name, result }) => {
    if (result.status === "fulfilled") {
      console.log(`[DealRadar] ${name}: ${result.value.length} deals`);
      return result.value;
    } else {
      console.error(`[DealRadar] ${name} FAILED:`, result.reason?.message);
      return [];
    }
  });

  console.log(`[DealRadar] Total: ${deals.length} deals`);
  return deals;
}

app.get("/api/deals", async (req, res) => {
  try {
    // Return cache if fresh
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
      return res.json(cache);
    }

    const deals = await scrapeAll();
    cache = deals;
    cacheTime = Date.now();
    res.json(deals);
  } catch (err) {
    console.error("[DealRadar] Fatal error:", err);
    // Return stale cache if available
    if (cache) return res.json(cache);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true, cachedAt: cacheTime ? new Date(cacheTime).toISOString() : null }));

app.get("/debug", async (req, res) => {
  const results = {};

  // Test Colruyt (no browser)
  try {
    const deals = await scrapeColruyt();
    results.colruyt = { ok: true, count: deals.length };
  } catch (e) {
    results.colruyt = { ok: false, error: e.message };
  }

  // Test AH (no browser)
  try {
    const deals = await scrapeAlbertHeijn();
    results.albertHeijn = { ok: true, count: deals.length };
  } catch (e) {
    results.albertHeijn = { ok: false, error: e.message };
  }

  // Test browser launch
  let browser;
  try {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    browser = await chromium.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
    });
    results.browser = { ok: true, version: browser.version() };
  } catch (e) {
    results.browser = { ok: false, error: e.message };
    return res.json(results);
  }

  // Test each browser scraper
  const browserScrapers = [
    { name: "lidl", fn: () => scrapeLidl(browser) },
    { name: "delhaize", fn: () => scrapeDelhaize(browser) },
    { name: "carrefour", fn: () => scrapeCarrefour(browser) },
    { name: "aldi", fn: () => scrapeAldi(browser) },
    { name: "spar", fn: () => scrapeSpar(browser) },
  ];

  for (const { name, fn } of browserScrapers) {
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
  // Warm up cache on start
  scrapeAll().then(deals => {
    cache = deals;
    cacheTime = Date.now();
  }).catch(err => console.error("[DealRadar] Warmup failed:", err));
});
