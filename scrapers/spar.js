// Spar Belgium (mijnspar.be) — Playwright intercept of JSON API
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function sparDateToDutch(formatted) {
  // "25/03/2026" → "wo 25 maart"
  if (!formatted) return dutchDate(7);
  const [day, month, year] = formatted.split("/");
  if (!day || !month) return dutchDate(7);
  const d = new Date(year || new Date().getFullYear(), Number(month) - 1, Number(day));
  return `${_DDAYS[d.getDay()]} ${day} ${_DMONTHS[Number(month) - 1]}`;
}

async function scrapeSpar(browser, maxResults = 15) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9" });

    let sparData = null;
    page.on("response", async (response) => {
      if (response.url().includes("filter_list_store_sp.model.json")) {
        try { sparData = await response.json(); } catch { /* skip */ }
      }
    });

    await page.goto("https://www.mijnspar.be/nl/promoties", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);

    if (!sparData) {
      console.log("[Spar] API not intercepted");
      return [];
    }

    const results = (sparData.results || []).filter(r => r.promotion?.promoTitle);
    console.log("[Spar] API intercepted:", results.length, "deals");

    return results.slice(0, maxResults).map((item, i) => {
      const p = item.promotion;
      const normalPrice = parseFloat(`${p.normalPrice?.beforeDecimal || 0}.${String(p.normalPrice?.afterDecimal || "00").padStart(2, "0")}`);
      const promoPrice = parseFloat(`${p.promoPrice?.beforeDecimal || 0}.${String(p.promoPrice?.afterDecimal || "00").padStart(2, "0")}`);
      const savings = normalPrice > promoPrice && promoPrice > 0
        ? Math.round((1 - promoPrice / normalPrice) * 100) : 0;
      const description = [p.promoDescription, p.quantity].filter(Boolean).join(" ");
      return {
        id: 8000 + i,
        store: "Spar", storeColor: "#007A33", storeLogo: "S",
        item: p.promoTitle,
        deal: savings > 0 ? `-${savings}%` : "Aanbieding",
        category: "Overig",
        originalPrice: normalPrice,
        newPrice: promoPrice || normalPrice,
        savings,
        emoji: "🛒",
        validUntil: sparDateToDutch(p.formattedEndDate),
        hot: savings >= 30,
        description,
        image: p.promoAssetPath ? `https://www.mijnspar.be${p.promoAssetPath}` : null,
      };
    });
  } finally {
    await page.close();
  }
}

module.exports = { scrapeSpar };
