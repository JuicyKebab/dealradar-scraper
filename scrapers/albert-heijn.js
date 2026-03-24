// Albert Heijn — Playwright scraper
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

async function scrapeAlbertHeijn(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    // Intercept ALL JSON responses to find product data
    const apiProducts = [];
    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      try {
        const json = await response.json();
        // Look for arrays of products in any shape
        const candidates = [
          json.products,
          json.bonusGroups?.flatMap(g => g.products || []),
          json.lanes?.flatMap(l => l.products || l.items || []),
          json.data?.products,
          json.results,
          json.items,
          Array.isArray(json) ? json : null,
        ].filter(a => Array.isArray(a) && a.length > 2 && (a[0]?.title || a[0]?.name || a[0]?.id));

        for (const arr of candidates) {
          if (arr.length > 0) {
            console.log("[AH] Intercepted products:", arr.length, "from", response.url().slice(0, 80));
            apiProducts.push(...arr);
          }
        }
      } catch { /* skip */ }
    });

    await page.goto("https://www.ah.nl/bonus", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait for skeleton loaders to disappear (max 15s)
    try {
      await page.waitForFunction(() => {
        const skeletons = document.querySelectorAll('[class*="skeleton"]');
        return skeletons.length === 0;
      }, { timeout: 15000 });
    } catch { /* continue anyway */ }

    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    if (apiProducts.length > 0) {
      console.log("[AH] Total intercepted:", apiProducts.length);
      const unique = apiProducts.filter((p, i, arr) =>
        arr.findIndex(x => (x.id || x.webshopId) === (p.id || p.webshopId)) === i
      );
      return unique.slice(0, maxResults).map((p, i) => {
        const curr = p.currentPrice?.amount ?? p.priceLabel?.now?.amount ?? p.price?.now ?? 0;
        const prev = p.priceBeforeBonus?.amount ?? p.priceLabel?.was?.amount ?? p.price?.was ?? curr;
        const savings = prev > curr ? Math.round((1 - curr / prev) * 100) : 0;
        return {
          id: 3000 + i,
          store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
          item: p.title || p.name || p.productName || "Onbekend",
          deal: savings > 0 ? `-${savings}%` : (p.bonusMechanism || p.promotionType || "Bonus"),
          category: p.mainCategory || p.subCategory || p.category || "Overig",
          originalPrice: prev, newPrice: curr, savings,
          emoji: categoryToEmoji(p.mainCategory || p.subCategory),
          validUntil: isoToDutch(p.bonusEndDate || p.endDate),
          hot: savings >= 30,
          description: p.descriptionFull || p.description || "",
          image: p.images?.[0]?.url || p.imageUrl || null,
        };
      });
    }

    // HTML fallback — use data-testid selectors (more stable than hashed CSS modules)
    const products = await page.evaluate(() => {
      const results = [];
      const cards = Array.from(document.querySelectorAll(
        '[data-testid*="product"], [data-testid*="bonus"], [class*="product-card"], [class*="lane-product"]'
      ));
      console.log("AH cards found:", cards.length);

      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector('[data-testid*="title"], [data-testid*="name"], [class*="title"], h2, h3, p')?.textContent?.trim();
        if (!name || name.length < 3) continue;

        const allText = card.textContent || "";
        const priceMatch = allText.match(/€\s*(\d+)[,.](\d{2})/);
        const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;

        const badge = card.querySelector('[class*="discount"], [class*="badge"], [class*="bonus"]')?.textContent?.trim() || "Bonus";
        const image = card.querySelector("img")?.src || null;
        results.push({ name, newPrice, badge, image });
      }
      return results;
    });

    console.log("[AH] HTML found:", products.length, "products");
    return products.slice(0, maxResults).map((p, i) => ({
      id: 3000 + i,
      store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
      item: p.name, deal: p.badge || "Bonus",
      category: "Overig", originalPrice: p.newPrice, newPrice: p.newPrice, savings: 0,
      emoji: "🛒", validUntil: dutchDate(7), hot: false, description: "", image: p.image,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeAlbertHeijn };
