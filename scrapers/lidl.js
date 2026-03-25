// Lidl Belgium — directe API (geen browser nodig)
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

async function scrapeLidl(_browser, maxResults = 1000) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "nl-BE,nl;q=0.9",
    "Referer": "https://www.lidl.be/q/nl-BE/query/promo",
  };

  const url = "https://www.lidl.be/q/api/query/promo?assortment=BE&locale=nl_BE&version=v2.0.0&size=1000";
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Lidl API ${res.status}`);
  const json = await res.json();

  const items = json.items || [];
  console.log(`[Lidl] API: ${items.length} items (numFound: ${json.numFound})`);

  return items.slice(0, maxResults).map((item, i) => {
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
}

module.exports = { scrapeLidl };
