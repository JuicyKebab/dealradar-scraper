// Albert Heijn — Playwright scraper (browser-based als API blokkeert)
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
  const map = {
    "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
    "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫",
    "chocolade": "🍫", "wijn": "🍷", "bier": "🍺", "snacks": "🍿",
    "kaas": "🧀",
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

async function scrapeAlbertHeijn(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    const apiData = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("api.ah.nl") || url.includes("bonus") || url.includes("promotion")) {
        try {
          const json = await response.json();
          apiData.push({ url, json });
        } catch { /* skip */ }
      }
    });

    await page.goto("https://www.ah.nl/bonus", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);

    // Check API intercepts
    for (const { json } of apiData) {
      const products = json.products || json.bonusGroups?.flatMap(g => g.products || []) || [];
      if (products.length > 0) {
        return products.slice(0, maxResults).map((p, i) => {
          const currentPrice = p.currentPrice?.amount ?? p.priceLabel?.now ?? 0;
          const previousPrice = p.priceBeforeBonus?.amount ?? p.priceLabel?.was ?? currentPrice;
          const savings = previousPrice > currentPrice ? Math.round((1 - currentPrice / previousPrice) * 100) : 0;
          return {
            id: 3000 + i,
            store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
            item: p.title || p.name || "Onbekend",
            deal: savings > 0 ? `-${savings}%` : (p.bonusMechanism || "Bonus"),
            category: p.mainCategory || p.subCategory || "Overig",
            originalPrice: previousPrice, newPrice: currentPrice, savings,
            emoji: categoryToEmoji(p.mainCategory || p.subCategory),
            validUntil: isoToDutch(p.bonusEndDate || p.endDate),
            hot: savings >= 30,
            description: p.descriptionFull || "",
            image: p.images?.[0]?.url || null,
          };
        });
      }
    }

    // HTML scraping fallback
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        "[data-testhook='product-card']",
        "[class*='product-card']",
        "[class*='ProductCard']",
        "[class*='BonusCard']",
        "[class*='bonus-card']",
      ];
      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }
      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[class*='title'], [class*='name'], h2, h3, p")?.textContent?.trim();
        if (!name || name.length < 3) continue;
        const priceText = card.querySelector("[class*='price'], [class*='Price']")?.textContent || "";
        const match = priceText.match(/(\d+)[,.](\d{2})/);
        const newPrice = match ? parseFloat(`${match[1]}.${match[2]}`) : 0;
        const image = card.querySelector("img")?.src || null;
        const badge = card.querySelector("[class*='discount'], [class*='badge'], [class*='bonus']")?.textContent?.trim() || "Bonus";
        results.push({ name, newPrice, badge, image });
      }
      return results;
    });

    return products.slice(0, maxResults).map((p, i) => ({
      id: 3000 + i,
      store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
      item: p.name,
      deal: p.badge || "Bonus",
      category: "Overig",
      originalPrice: p.newPrice, newPrice: p.newPrice, savings: 0,
      emoji: "🛒",
      validUntil: dutchDate(7),
      hot: false,
      description: "",
      image: p.image,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeAlbertHeijn };
