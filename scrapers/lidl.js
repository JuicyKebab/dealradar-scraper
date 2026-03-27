// Lidl Belgium — directe API (geen Playwright nodig)
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
function isoToDutch(str) {
  if (!str) return dutchDate(7);
  const d = new Date(str);
  if (isNaN(d)) return dutchDate(7);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}
function categoryToEmoji(cat) {
  const map = { "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞", "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫", "wijn": "🍷", "bier": "🍺" };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) { if (lower.includes(key)) return emoji; }
  return "🛒";
}

const LIDL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/mindshift.search+json;version=2",
  "Accept-Language": "nl-BE,nl;q=0.9",
  "Referer": "https://www.lidl.be/q/nl-BE/query/promo",
  "Origin": "https://www.lidl.be",
};

function mapItem(item, i) {
  const d = item.gridbox?.data || item;
  const priceObj = d.price || {};
  const curr = priceObj.price ?? 0;
  const orig = priceObj.oldPrice ?? priceObj.discount?.deletedPrice ?? curr;
  const savings = priceObj.discount?.percentageDiscount ?? (orig > curr && curr > 0 ? Math.round((1 - curr / orig) * 100) : 0);
  const validUntil = d.storeEndDate
    ? unixToDutch(d.storeEndDate)
    : isoToDutch(d.stockAvailability?.badgeInfoV2?.[0]?.validUntil || d.endDate);
  return {
    id: 4000 + i,
    store: "Lidl", storeColor: "#0050AA", storeLogo: "L",
    item: d.fullTitle || d.title || "Onbekend",
    deal: savings > 0 ? `-${savings}%` : (d.promotionText || "Aanbieding"),
    category: d.category || d.categorySecondaryPath || "Overig",
    originalPrice: orig, newPrice: curr, savings,
    emoji: categoryToEmoji(d.category),
    validUntil,
    hot: savings >= 30,
    description: d.keyfacts?.features?.[0] || "",
    image: d.cutoutimageV2 || d.image || d.imageList?.[0] || null,
  };
}

async function fetchLidlPage(offset = 0, limit = 600) {
  const url = `https://www.lidl.be/q/api/query/promo?assortment=BE&locale=nl_BE&version=v2.0.0&limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { headers: LIDL_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function scrapeLidl(browser, maxResults = 1000) {
  try {
    // Eerste call: haal alles in één keer op
    const data = await fetchLidlPage(0, 1000);
    const items = data.items || [];
    const numFound = data.numFound || items.length;
    console.log(`[Lidl] Directe API: ${items.length} van ${numFound} deals`);

    // Als er meer zijn dan de eerste batch, haal de rest op
    let allItems = [...items];
    if (numFound > items.length) {
      const remaining = [];
      for (let offset = items.length; offset < numFound; offset += 600) {
        remaining.push(fetchLidlPage(offset, 600).then(d => d.items || []).catch(() => []));
      }
      const batches = await Promise.all(remaining);
      batches.forEach(b => allItems.push(...b));
      console.log(`[Lidl] Totaal na paginering: ${allItems.length}`);
    }

    return allItems.slice(0, maxResults).map(mapItem);
  } catch (e) {
    console.log("[Lidl] Directe API fout:", e.message);
    return [];
  }
}

module.exports = { scrapeLidl };
