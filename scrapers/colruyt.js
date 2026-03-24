// Colruyt Group API (Colruyt + OKay) — JSON API, no browser needed
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.colruyt.be/",
  "Origin": "https://www.colruyt.be",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function apiDateToDutch(dateStr) {
  const [d, m] = dateStr.split("-").map(Number);
  const date = new Date(new Date().getFullYear(), m - 1, d);
  return `${_DDAYS[date.getDay()]} ${d} ${_DMONTHS[m - 1]}`;
}

const CATEGORY_EMOJI = {
  "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
  "bakkerij": "🥐", "vis": "🐟", "diepvries": "🧊", "groenten": "🥦",
  "fruit": "🍎", "koeken": "🍫", "chocolade": "🍫", "snoep": "🍬",
  "wijn": "🍷", "bier": "🍺", "hygiëne": "🧴", "beauty": "🧴",
  "huishouden": "🧹", "baby": "🍼", "pasta": "🍝", "rijst": "🍚",
  "kaas": "🧀", "aardappelen": "🥔", "maaltijden": "🍲", "charcuterie": "🥓",
  "sauzen": "🫙", "ontbijt": "🫓", "koffie": "☕", "thee": "🍵",
  "snacks": "🍿", "chips": "🍟",
};

function categoryToEmoji(cat) {
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJI)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

async function fetchColruytGroupDeals(clientCode, storeConfig, placeId = 710, maxResults = 15) {
  const url = new URL("https://ecgproductmw.colruytgroup.com/ecgproductmw/v2/nl/products");
  url.searchParams.set("clientCode", clientCode);
  url.searchParams.set("isAvailable", "true");
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "100");
  url.searchParams.set("placeId", String(placeId));
  url.searchParams.set("inPromo", "true");

  const res = await fetch(url.toString(), { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`${storeConfig.store} API ${res.status}`);
  const data = await res.json();

  return (data.products || [])
    .filter(p => p.price?.isPromoActive === "Y")
    .slice(0, maxResults)
    .map((product, index) => {
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
      const validUntil = promo.publicationEndDate ? apiDateToDutch(promo.publicationEndDate) : dutchDate(7);
      return {
        id: storeConfig.idBase + index,
        store: storeConfig.store, storeColor: storeConfig.color, storeLogo: storeConfig.logo,
        item: product.name || "Onbekend product",
        deal: dealText,
        category: product.topCategoryName || "Overig",
        originalPrice: basicPrice,
        newPrice: isQtyDeal ? parseFloat(qtyPrice.toFixed(2)) : basicPrice,
        savings,
        emoji: categoryToEmoji(product.topCategoryName),
        validUntil,
        hot: promo.topPromo === true,
        description: (product.description || "").replace(/\n/g, " ").trim(),
        image: product.thumbNail || null,
      };
    });
}

module.exports = {
  scrapeColruyt: () => fetchColruytGroupDeals("clp", { store: "Colruyt", color: "#E31837", logo: "C", idBase: 1000 }, 710, 15),
};
