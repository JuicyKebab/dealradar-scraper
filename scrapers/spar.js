// Spar Belgium (mijnspar.be) — Direct JSON API
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
  const d = new Date(year || new Date().getFullYear(), month - 1, day);
  return `${_DDAYS[d.getDay()]} ${day} ${_DMONTHS[month - 1]}`;
}

async function scrapeSpar(browser, maxResults = 15) {
  try {
    const url = "https://www.mijnspar.be/content/spar/nl/promoties/jcr:content/root/responsivegrid/responsivegrid/responsivegrid/filter_list_store_sp.model.json";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "nl-BE,nl;q=0.9",
        "Referer": "https://www.mijnspar.be/nl/promoties",
      },
    });
    if (!res.ok) throw new Error(`Spar API ${res.status}`);
    const data = await res.json();
    const results = (data.results || []).filter(r => r.promotion?.promoTitle);
    console.log("[Spar] API:", results.length, "deals");

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
  } catch (err) {
    console.error("[Spar] Error:", err.message);
    return [];
  }
}

module.exports = { scrapeSpar };
