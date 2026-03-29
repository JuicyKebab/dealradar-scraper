// OKay Belgium — Playwright scraper (browser-based, intercepteert API-calls met auth)
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
  if (isNaN(d.getTime())) return dutchDate(7);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
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

function parseProduct(product, index) {
  // Colruyt-stijl genest price object (zelfde structuur als colruyt.js)
  const pr = product.price || {};
  const promo = (product.promotion || [])[0] || {};
  const name = product.name || product.LongName || "Onbekend";
  const category = product.topCategoryName || "";
  const image = product.thumbNail || product.fullImage || null;

  const basicPrice = parseFloat(pr.basicPrice || 0);
  const qtyPrice = parseFloat(pr.quantityPrice || 0);
  const qtyQty = parseFloat(pr.quantityPriceQuantity || 1);
  const isQtyDeal = qtyQty > 1 && qtyPrice > 0 && qtyPrice < basicPrice;
  const savings = isQtyDeal ? Math.round((1 - qtyPrice / basicPrice) * 100) : 0;

  let dealText;
  if (isQtyDeal) dealText = `${Math.round(qtyQty)} voor €${(qtyPrice * qtyQty).toFixed(2)}`;
  else if (pr.priceReason === "Promo") dealText = "Actieprijs";
  else if (pr.priceReason === "Reaction") dealText = "Laagste prijs";
  else dealText = "Promo";

  const endDate = promo.publicationEndDate || pr.quantityActivationDate || null;

  return {
    id: 1200 + index,
    store: "OKay", storeColor: "#E2001A", storeLogo: "OK",
    item: name,
    deal: dealText,
    category: category || "Overig",
    originalPrice: basicPrice,
    newPrice: isQtyDeal ? parseFloat(qtyPrice.toFixed(2)) : basicPrice,
    savings,
    emoji: categoryToEmoji(category),
    validUntil: isoToDutch(endDate),
    hot: savings >= 30 || promo.topPromo === true,
    description: (product.description || product.content || "").replace(/\n/g, " ").trim(),
    image,
  };
}

function parsePromotion(promo, index) {
  // Promotions endpoint — vlakke structuur
  const name = promo.productName || promo.name || promo.title || "Onbekend";
  const category = promo.categoryName || promo.category || promo.topCategoryName || "";
  const image = promo.imageUrl || promo.thumbNail || promo.image || null;

  const originalPrice = parseFloat(promo.basicPrice || promo.originalPrice || promo.normalPrice || 0);
  const newPrice = parseFloat(promo.promoPrice || promo.promotionPrice || promo.currentPrice || originalPrice);
  const qtyQty = parseInt(promo.quantityPriceQuantity || promo.quantity || 1, 10);
  const qtyPrice = parseFloat(promo.quantityPrice || 0);
  const isQtyDeal = qtyQty > 1 && qtyPrice > 0 && qtyPrice < originalPrice;

  let savings = 0;
  let dealText = promo.promoText || promo.promotionText || promo.dealText || "";
  if (isQtyDeal) {
    savings = Math.round((1 - qtyPrice / originalPrice) * 100);
    dealText = dealText || `${qtyQty} voor €${(qtyPrice * qtyQty).toFixed(2)}`;
  } else if (originalPrice > 0 && newPrice < originalPrice) {
    savings = Math.round((1 - newPrice / originalPrice) * 100);
    dealText = dealText || `-${savings}%`;
  } else {
    dealText = dealText || "Actieprijs";
  }

  const endDate = promo.endDate || promo.publicationEndDate || promo.validTo || promo.validUntil || null;

  return {
    id: 1200 + index,
    store: "OKay", storeColor: "#E2001A", storeLogo: "OK",
    item: name,
    deal: dealText,
    category: category || "Overig",
    originalPrice: originalPrice || newPrice,
    newPrice: isQtyDeal ? parseFloat(qtyPrice.toFixed(2)) : newPrice,
    savings,
    emoji: categoryToEmoji(category),
    validUntil: isoToDutch(endDate),
    hot: savings >= 30 || promo.topPromo === true,
    description: (promo.description || promo.longDescription || "").replace(/\n/g, " ").trim(),
    image,
  };
}

async function scrapeOkay(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    const captured = [];
    const pendingPromises = [];

    // Intercept alle API responses van okay.be en de Colruyt Group middleware
    page.on("response", (response) => {
      const url = response.url();
      const isRelevant =
        url.includes("apip.okay.be") ||
        url.includes("ecgpromotionmw") ||
        url.includes("ecgproductmw") ||
        url.includes("colruytgroup.com") ||
        (url.includes("okay.be") && url.includes("promot"));

      if (!isRelevant) return;

      const p = (async () => {
        try {
          const ct = response.headers()["content-type"] || "";
          if (!ct.includes("json")) return;
          const json = await response.json();
          captured.push({ url, json });
        } catch { /* skip non-JSON */ }
      })();
      pendingPromises.push(p);
    });

    await page.goto("https://www.okay.be/nl/promos/promoties", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wacht kort tot pagina geladen is
    await page.waitForTimeout(3000);
    await Promise.allSettled(pendingPromises);

    // Haal placeId op uit een onderschepte call (default: 843)
    let placeId = 843;
    for (const { url } of captured) {
      const m = url.match(/placeId=(\d+)/);
      if (m) { placeId = parseInt(m[1]); break; }
    }

    // Stap 1: haal alle promoties op via POST (vanuit browser = auth via cookies + apikey)
    const allPromos = await page.evaluate(async (placeId) => {
      const url = "https://apip.okay.be/gateway/emec.promotion.productretrsvc.v1/v1/nl/api/promotions/by-date-range";
      const results = [];
      let pageNum = 1;
      while (true) {
        try {
          const res = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "x-cg-apikey": "20983a76-c872-11ec-89b3-b6ab19c0acfa",
            },
            body: JSON.stringify({
              commonParameters: { page: pageNum, size: 100 },
              filters: { promotionType: "0,3,4" },
              sort: ["benefitpercentage desc"],
              placeId,
              clientCode: "OKAYBE",
              incPromoWithoutPrd: false,
            }),
          });
          if (!res.ok) break;
          const json = await res.json();
          results.push(...(json.promotions || []));
          if (results.length >= json.totalPromotionFound || (json.promotions?.length || 0) < 100) break;
          pageNum++;
          if (pageNum > 10) break;
        } catch { break; }
      }
      return results;
    }, placeId);

    // Stap 2: combineer met onderschepte kortingsproducten (hebben echte prijzen)
    const priceProducts = [];
    const seenTan = new Set();
    for (const { url, json } of captured) {
      if (json.products?.length > 0 && url.includes("discounts=reducedPrice") && json.products[0].price?.basicPrice !== undefined) {
        for (const p of json.products) {
          if (!seenTan.has(p.technicalArticleNumber)) {
            seenTan.add(p.technicalArticleNumber);
            priceProducts.push(p);
          }
        }
      }
    }

    // Stap 3: merge — prijsproducten krijgen voorkeur boven promoties voor hetzelfde artikel
    const productsByTan = new Map(priceProducts.map(p => [p.technicalArticleNumber, p]));
    const results = [];

    for (const promo of allPromos) {
      const tan = promo.linkedTechnicalArticleNumber;
      if (tan && productsByTan.has(tan)) {
        // Gebruik de rijkere prijsdata van het products endpoint
        results.push(parseProduct(productsByTan.get(tan), results.length));
        productsByTan.delete(tan); // voorkom duplicaat
      } else {
        // Gebruik promotie-data (heeft benefitPercentage maar geen exacte prijs)
        const prod = promo.highestSalesRank || {};
        const benefit = (promo.benefit || [])[0] || {};
        const pct = benefit.benefitPercentage || 0;
        const minLimit = benefit.minLimit || 0;
        let dealText;
        if (pct === 50 && minLimit > 0) dealText = `2e halve prijs`;
        else if (pct > 0) dealText = `-${pct}%`;
        else dealText = "Actieprijs";
        results.push({
          id: 1200 + results.length,
          store: "OKay", storeColor: "#E2001A", storeLogo: "OK",
          item: prod.name || prod.longName || "Onbekend",
          deal: dealText,
          category: prod.topCategoryName || "Overig",
          originalPrice: 0, newPrice: 0, savings: pct,
          emoji: categoryToEmoji(prod.topCategoryName),
          validUntil: isoToDutch(promo.publicationEndDate),
          hot: pct >= 30 || promo.topPromo === true,
          description: "",
          image: prod.thumbnail || prod.thumbNail || null,
        });
      }
    }

    // Voeg resterende prijsproducten toe die niet gelinkt waren aan een promotie
    for (const p of productsByTan.values()) {
      results.push(parseProduct(p, results.length));
    }

    if (results.length > 0) return results;

    // Fallback: HTML scraping van productkaarten
    const products = await page.evaluate(() => {
      const results = [];
      const selectors = [
        "[data-testid='product-card']",
        "[class*='ProductCard']",
        "[class*='product-card']",
        "[class*='ProductTile']",
        "[class*='PromotionCard']",
        "[class*='promotion-card']",
        ".product-list-item",
        "[class*='promo']",
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
        id: 1200 + i,
        store: "OKay", storeColor: "#E2001A", storeLogo: "OK",
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

module.exports = { scrapeOkay };
