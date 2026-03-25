// Albert Heijn — direct API (geen browser nodig)
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

async function scrapeAlbertHeijn(_browser, maxResults = 50) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "nl-NL,nl;q=0.9",
    "Origin": "https://www.ah.nl",
    "Referer": "https://www.ah.nl/bonus",
  };

  // AH bonus-producten API — pagineren voor meer resultaten
  const allProducts = [];
  for (let page = 0; page < 5; page++) {
    try {
      const url = `https://www.ah.nl/zoeken/api/products/search?q=*&page=${page}&size=50&taxonomyId=bonus`;
      const res = await fetch(url, { headers });
      if (!res.ok) { console.log("[AH] API status:", res.status); break; }
      const data = await res.json();
      const products = data.products || data.cards?.flatMap(c => c.products || []) || [];
      if (products.length === 0) break;
      allProducts.push(...products);
      console.log(`[AH] Pagina ${page}: ${products.length} producten`);
      if (products.length < 50) break; // laatste pagina
    } catch (e) {
      console.log("[AH] API fout:", e.message);
      break;
    }
  }

  if (allProducts.length === 0) {
    // Fallback: probeer de bonus tile API
    try {
      const res = await fetch("https://api.ah.nl/mobile-services/product/search/v2?sortOn=RELEVANCE&taxonomyId=bonus&page=0&size=50", { headers });
      if (res.ok) {
        const data = await res.json();
        const products = data.products || data.content || [];
        allProducts.push(...products);
        console.log("[AH] Mobile API:", allProducts.length, "producten");
      }
    } catch { /* skip */ }
  }

  console.log("[AH] Totaal:", allProducts.length, "producten");

  return allProducts.slice(0, maxResults).map((p, i) => {
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
      description: p.descriptionFull || p.descriptionHighlights?.join(", ") || "",
      image: p.images?.[0]?.url || p.imageUrl || null,
    };
  });
}

module.exports = { scrapeAlbertHeijn };
