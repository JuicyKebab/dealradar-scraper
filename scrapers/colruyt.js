// Colruyt Belgium — Playwright scraper (browser-based omdat API geblokkeerd is op Railway)
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function apiDateToDutch(dateStr) {
  if (!dateStr) return dutchDate(7);
  const [d, m] = dateStr.split("-").map(Number);
  if (!d || !m) return dutchDate(7);
  const date = new Date(new Date().getFullYear(), m - 1, d);
  return `${_DDAYS[date.getDay()]} ${d} ${_DMONTHS[m - 1]}`;
}

function categoryToEmoji(cat) {
  const map = {
    "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
    "bakkerij": "🥐", "vis": "🐟", "diepvries": "🧊", "groenten": "🥦",
    "fruit": "🍎", "koeken": "🍫", "chocolade": "🍫", "snoep": "🍬",
    "wijn": "🍷", "bier": "🍺", "hygiëne": "🧴", "beauty": "🧴",
    "huishouden": "🧹", "pasta": "🍝", "kaas": "🧀", "maaltijden": "🍲",
    "charcuterie": "🥓", "koffie": "☕", "thee": "🍵", "snacks": "🍿",
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

async function scrapeColruyt(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    // Intercept the Colruyt Group API calls the website makes
    const apiData = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("ecgproductmw") || url.includes("colruytgroup.com")) {
        try {
          const json = await response.json();
          if (json.products && json.products.length > 0) apiData.push(json);
        } catch { /* skip */ }
      }
    });

    await page.goto("https://www.colruyt.be/nl/promoties", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(5000);

    // Check intercepted API calls
    if (apiData.length > 0) {
      const products = apiData[0].products || [];
      return products.filter(p => p.price?.isPromoActive === "Y").slice(0, maxResults).map((product, index) => {
        const pr = product.price || {};
        const promo = (product.promotion || [])[0] || {};
        const basicPrice = pr.basicPrice || 0;
        const qtyPrice = pr.quantityPrice;
        const qtyQty = qtyPrice ? parseFloat(pr.quantityPriceQuantity || 1) : 1;
        const isQtyDeal = qtyPrice && qtyQty > 1 && qtyPrice < basicPrice;
        const savings = isQtyDeal ? Math.round((1 - qtyPrice / basicPrice) * 100) : 0;
        let dealText;
        if (isQtyDeal) dealText = `${Math.round(qtyQty)} voor €${(qtyPrice * qtyQty).toFixed(2)}`;
        else if (pr.priceReason === "Promo") dealText = "Actieprijs";
        else if (pr.priceReason === "Reaction") dealText = "Laagste prijs";
        else dealText = "Promo";
        return {
          id: 1000 + index,
          store: "Colruyt", storeColor: "#E31837", storeLogo: "C",
          item: product.name || "Onbekend",
          deal: dealText,
          category: product.topCategoryName || "Overig",
          originalPrice: basicPrice,
          newPrice: isQtyDeal ? parseFloat(qtyPrice.toFixed(2)) : basicPrice,
          savings,
          emoji: categoryToEmoji(product.topCategoryName),
          validUntil: apiDateToDutch(promo.publicationEndDate),
          hot: promo.topPromo === true,
          description: (product.description || "").replace(/\n/g, " ").trim(),
          image: product.thumbNail || null,
        };
      });
    }

    // Fallback: scrape HTML product cards
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        "[data-testid='product-card']",
        "[class*='ProductCard']",
        "[class*='product-card']",
        "[class*='ProductTile']",
        "[class*='product-tile']",
        ".product-list-item",
      ];
      let cards = [];
      for (const sel of selectors) {
        cards = Array.from(document.querySelectorAll(sel));
        if (cards.length > 2) break;
      }
      for (const card of cards.slice(0, 25)) {
        const name = card.querySelector("[class*='name'], [class*='title'], [class*='description'], h2, h3, p")?.textContent?.trim();
        if (!name || name.length < 3) continue;
        const priceEls = card.querySelectorAll("[class*='price'], [class*='Price']");
        let newPrice = 0, originalPrice = 0;
        for (const el of priceEls) {
          const match = el.textContent.match(/(\d+)[,.](\d{2})/);
          if (match) {
            const val = parseFloat(`${match[1]}.${match[2]}`);
            if (el.className?.includes?.("old") || el.className?.includes?.("before") || el.tagName === "S") {
              originalPrice = val;
            } else if (newPrice === 0) {
              newPrice = val;
            }
          }
        }
        if (originalPrice === 0) originalPrice = newPrice;
        const image = card.querySelector("img")?.src || null;
        const badge = card.querySelector("[class*='badge'], [class*='promo'], [class*='discount']")?.textContent?.trim() || "";
        results.push({ name, newPrice, originalPrice, badge, image });
      }
      return results;
    });

    return products.slice(0, maxResults).map((p, i) => {
      const savings = p.originalPrice > p.newPrice && p.newPrice > 0
        ? Math.round((1 - p.newPrice / p.originalPrice) * 100) : 0;
      return {
        id: 1000 + i,
        store: "Colruyt", storeColor: "#E31837", storeLogo: "C",
        item: p.name,
        deal: p.badge || (savings > 0 ? `-${savings}%` : "Actieprijs"),
        category: "Overig",
        originalPrice: p.originalPrice,
        newPrice: p.newPrice,
        savings,
        emoji: "🛒",
        validUntil: dutchDate(7),
        hot: savings >= 30,
        description: "",
        image: p.image,
      };
    });
  } finally {
    await page.close();
  }
}

module.exports = { scrapeColruyt };
