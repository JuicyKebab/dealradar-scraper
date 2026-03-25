// Albert Heijn — Playwright + API intercept
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function isoToDutch(dateStr) {
  if (!dateStr) return dutchDate(7);
  const d = new Date(dateStr);
  if (isNaN(d)) return dutchDate(7);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function categoryToEmoji(cat) {
  const map = { "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫", "wijn": "🍷", "bier": "🍺", "kaas": "🧀" };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) { if (lower.includes(key)) return emoji; }
  return "🛒";
}

function mapAH(p, i) {
  const curr = p.priceLabel?.now?.amount ?? p.currentPrice?.amount ?? p.price?.now ?? p.price ?? 0;
  const prev = p.priceLabel?.was?.amount ?? p.priceBeforeBonus?.amount ?? p.price?.was ?? curr;
  const savings = prev > curr && curr > 0 ? Math.round((1 - curr / prev) * 100) : 0;
  return {
    id: 3000 + i,
    store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
    item: p.title || p.description || p.name || p.productName || "Onbekend",
    deal: savings > 0 ? `-${savings}%` : (p.bonusMechanism || p.promotionType || "Bonus"),
    category: p.mainCategory || p.subCategory || p.category || "Overig",
    originalPrice: prev, newPrice: curr, savings,
    emoji: categoryToEmoji(p.mainCategory || p.subCategory),
    validUntil: isoToDutch(p.bonusEndDate || p.endDate),
    hot: savings >= 30,
    description: p.descriptionHighlights?.join(", ") || "",
    image: p.images?.[0]?.url || p.imageUrl || null,
  };
}

async function scrapeAlbertHeijn(browser, maxResults = 100) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-NL,nl;q=0.9" });

    const products = [];
    page.on("response", async (response) => {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      if (!url.includes("ah.nl") && !url.includes("appie")) return;
      try {
        const json = await response.json();
        const candidates = [
          json.products,
          json.cards?.flatMap(c => c.products || []),
          json.lanes?.flatMap(l => l.products || l.items || []),
          json.results,
          Array.isArray(json) ? json : null,
        ].filter(a => Array.isArray(a) && a.length > 0 && (a[0]?.title || a[0]?.name || a[0]?.description));
        for (const arr of candidates) {
          console.log(`[AH] Intercepted ${arr.length} products from ${url.slice(0, 80)}`);
          products.push(...arr);
        }
      } catch { /* skip */ }
    });

    await page.goto("https://www.ah.nl/bonus", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Cookie banner
    try {
      await page.waitForSelector("[data-testhook='accept-cookies'], button:has-text('Alles accepteren')", { timeout: 6000 });
      await page.click("[data-testhook='accept-cookies'], button:has-text('Alles accepteren')");
      await page.waitForTimeout(2000);
    } catch { /* geen banner */ }

    // Wacht op producten + scroll
    await page.waitForTimeout(4000);
    for (let i = 1; i <= 5; i++) {
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p), i / 5);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);

    const unique = products.filter((p, i, arr) =>
      arr.findIndex(x => (x.id || x.webshopId || x.title) === (p.id || p.webshopId || p.title)) === i
    );
    console.log(`[AH] Totaal: ${unique.length} producten`);
    return unique.slice(0, maxResults).map(mapAH);
  } finally {
    await page.close();
  }
}

module.exports = { scrapeAlbertHeijn };
