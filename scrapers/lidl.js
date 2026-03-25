// Lidl Belgium — sessie via Playwright, daarna directe API-call vanuit browser
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function unixToDutch(ts) {
  if (!ts) return dutchDate(7);
  const d = new Date(ts * 1000);
  if (isNaN(d)) return dutchDate(7);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function categoryToEmoji(cat) {
  const map = { "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫", "wijn": "🍷", "bier": "🍺" };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

async function scrapeLidl(browser, maxResults = 1000) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    // Bezoek homepage om sessie/cookies te initialiseren
    await page.goto("https://www.lidl.be/", { waitUntil: "domcontentloaded", timeout: 30000 });
    try {
      await page.waitForSelector("#onetrust-accept-btn-handler", { timeout: 8000 });
      await page.click("#onetrust-accept-btn-handler");
      console.log("[Lidl] Cookie geaccepteerd");
      await page.waitForTimeout(1500);
    } catch { /* geen banner */ }

    // Doe de API-call vanuit de browser (inclusief alle cookies/headers)
    const apiUrl = "https://www.lidl.be/q/api/query/promo?assortment=BE&locale=nl_BE&version=v2.0.0&size=1000";
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          headers: {
            "Accept": "application/json",
            "Accept-Language": "nl-BE,nl;q=0.9",
          },
          credentials: "include",
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, type: data.type, numFound: data.numFound, items: data.items || [] };
      } catch (e) {
        return { error: e.message };
      }
    }, apiUrl);

    console.log(`[Lidl] API: status=${result.status} type=${result.type} numFound=${result.numFound} items=${result.items?.length}`);

    if (!result.items || result.items.length === 0) {
      console.log("[Lidl] Geen producten van API, type:", result.type);
      return [];
    }

    return result.items.slice(0, maxResults).map((item, i) => {
      const d = item.gridbox?.data || item;
      const priceObj = d.price || {};
      const curr = priceObj.price ?? 0;
      const orig = priceObj.oldPrice ?? priceObj.discount?.deletedPrice ?? curr;
      const savings = priceObj.discount?.percentageDiscount ?? (orig > curr && curr > 0 ? Math.round((1 - curr / orig) * 100) : 0);
      return {
        id: 4000 + i,
        store: "Lidl", storeColor: "#0050AA", storeLogo: "L",
        item: d.fullTitle || d.title || "Onbekend",
        deal: savings > 0 ? `-${savings}%` : (d.promotionText || "Aanbieding"),
        category: d.category || "Overig",
        originalPrice: orig,
        newPrice: curr,
        savings,
        emoji: categoryToEmoji(d.category),
        validUntil: unixToDutch(d.storeEndDate || d.stockAvailability?.badgeInfoV2?.[0]?.validUntil),
        hot: savings >= 30,
        description: d.keyfacts?.features?.[0] || "",
        image: d.image || d.imageList?.[0] || null,
      };
    });
  } finally {
    await page.close();
  }
}

module.exports = { scrapeLidl };
