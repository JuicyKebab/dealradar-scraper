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
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
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

app.listen(PORT, () => {
  console.log(`[DealRadar] Scraper service running on port ${PORT}`);
  // Warm up cache on start
  scrapeAll().then(deals => {
    cache = deals;
    cacheTime = Date.now();
  }).catch(err => console.error("[DealRadar] Warmup failed:", err));
});
