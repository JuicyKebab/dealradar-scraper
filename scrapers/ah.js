// Albert Heijn scraper — mobile API (api.ah.nl), geen Akamai op dit endpoint
// Anonymous bearer token via POST /mobile-auth/v1/auth/token/anonymous
// Pagineert door producten en filtert NATIONAL bonus deals client-side
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const AH_API = "https://api.ah.nl";
const AH_HEADERS = {
  "User-Agent": "Appie/8.22.3",
  "x-application": "AHWEBSHOP",
  "Content-Type": "application/json",
};

const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d)) return "";
  return `${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function categorize(product) {
  const cat = (product.mainCategory || "").toLowerCase();
  const sub = (product.subCategory || "").toLowerCase();
  const combined = cat + " " + sub;
  const title = (product.title || "").toLowerCase();

  // Groenten & Fruit EERST checken - voorkomt dat fruit-items als Dranken worden geclassificeerd
  // (bijv. "sap" matcht "aardbeien", "water" matcht "watermeloen")
  if (combined.match(/\b(groente|fruit|aardappel|tomaat|sla|komkommer|paprika|wortel)\b/)) return "Groenten & Fruit";
  if (combined.match(/\bbier\b|wijn|\bdrank|beverage|frisdrank|\bwater\b|\bsap\b|juice|koffie|coffee|\bthee\b|\btea\b|alcohol|spirit|gedistilleerd/)) return "Dranken";
  if (combined.match(/vlees|vis\b|kip\b|varken|rund|kalkoen|zalm|garnaal|krab|tonijn|gehakt|worst|charcuterie|\bham\b|spek|filet/)) return "Vlees & Vis";
  if (combined.match(/zuivel|kaas|melk|yoghurt|roomboter|boter|eieren|room\b|kwark|vla\b|pudding/)) return "Zuivel";
  if (combined.match(/brood|bakker|koek|gebak|snack|chips|crackers|noten|repen|muesli|ontbijt|croissant|cake/)) return "Bakkerij & Snacks";
  if (combined.match(/diepvries|vries/)) return "Diepvries";
  if (combined.match(/pasta|rijst|saus\b|soep|conserven|olie\b|graan|peulvrucht|droogwaren|kruid|specerij|azijn/)) return "Droogwaren";
  if (combined.match(/verzorg|cosmet|schoonheid|shampoo|tandpast|deo|parfum|lotion|huid\b|haar\b|mondverzorging/)) return "Verzorging";
  if (combined.match(/huishoud|schoon|wasmid|papier|keuken|toilet|afwas|reinig|vuilnis/)) return "Huishouden";
  if (combined.match(/huisdier|dieren|\bhond|\bkat\b/)) return "Dier";

  // Fallback: categoriseer op item-naam
  if (title) {
    if (title.match(/\b(aardbeien?|appels?|peer|peren|druiven|frambozen?|mango|ananas|watermeloen|meloen|nectarine|perzik|blauwe bessen|granaatappel|kiwi|avocado|banaan|bananen|sinaasappel|citroen)\b/) && !title.match(/sap|juice|smoothie|siroop|ice tea|thee|tea|drank|drink/)) return "Groenten & Fruit";
    if (title.match(/\b(tonijn|tonijnstukken)\b/)) return "Droogwaren";
    if (title.match(/\b(biscuit|koekjes?|crackers?)\b/)) return "Bakkerij & Snacks";
  }

  return "Overig";
}

function parseBundleQty(mechanism) {
  if (!mechanism) return 1;
  // "2 stapelen tot 50%", "3 voor 5.00", "2e halve prijs", "1+1 gratis"
  let m = mechanism.match(/^(\d+)\s*(stapelen|voor)\b/i);
  if (m) return parseInt(m[1]);
  m = mechanism.match(/^(\d+)\+(\d+)\s*gratis/i);
  if (m) return parseInt(m[1]) + parseInt(m[2]);
  m = mechanism.match(/^(\d+)e\s+halve\s+prijs/i);
  if (m) return parseInt(m[1]);
  return 1;
}

function computeSavings(product) {
  const before = product.priceBeforeBonus;
  if (!before || before <= 0) return 0;

  const current = product.currentPrice;
  if (current && current < before) {
    return Math.round((1 - current / before) * 100);
  }

  for (const label of (product.discountLabels || [])) {
    if (label.percentage) return Math.round(label.percentage);
    if (label.code === "DISCOUNT_X_FOR_Y" && label.count && label.price) {
      return Math.round((1 - (label.price / label.count) / before) * 100);
    }
    if (label.code === "SECOND_HALF_PRICE") return 25;
  }

  return 0;
}

async function getToken() {
  const res = await fetch(`${AH_API}/mobile-auth/v1/auth/token/anonymous`, {
    method: "POST",
    headers: AH_HEADERS,
    body: JSON.stringify({ clientId: "appie" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in response");
  return data.access_token;
}

async function fetchPage(token, page) {
  const res = await fetch(
    `${AH_API}/mobile-services/product/search/v2?sortOn=RELEVANCE&size=500&page=${page}`,
    {
      headers: { ...AH_HEADERS, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (res.status === 400) return null; // pagina buiten bereik
  if (!res.ok) throw new Error(`Search page ${page} failed: ${res.status}`);
  return res.json();
}

async function fetchDeals() {
  const token = await getToken();
  const deals = [];
  const seenIds = new Set();

  // Pagineer door beschikbare producten (max 6 pagina's × 500 = 3000 producten)
  for (let page = 0; page < 10; page++) {
    const data = await fetchPage(token, page);
    if (!data) break; // 400 = buiten bereik
    const products = data.products || [];
    if (products.length === 0) break;

    for (const p of products) {
      if (
        !p.isBonus ||
        p.promotionType !== "NATIONAL" ||
        seenIds.has(p.hqId)
      ) continue;

      seenIds.add(p.hqId);
      const category = categorize(p);
      const savings = computeSavings(p);
      const image = p.images?.find(i => i.width === 400)?.url
        || p.images?.[0]?.url || "";

      // Multi-buy (currentPrice == null): newPrice = pakprijs (× bundleQty).
      // Single-item: newPrice = stukprijs. unitPrice normaliseert altijd naar
      // per-stuk zodat de prijsgeschiedenis consistent is (anders springt de
      // grafiek nep wanneer een product wisselt tussen los en multi-buy).
      const bundleQty = p.currentPrice != null ? 1 : parseBundleQty(p.bonusMechanism);
      const newPrice = p.currentPrice != null
        ? p.currentPrice
        : savings > 0
          ? parseFloat(((p.priceBeforeBonus || 0) * bundleQty * (1 - savings / 100)).toFixed(2))
          : (p.priceBeforeBonus || 0) * bundleQty;

      deals.push({
        id: `ah-${p.hqId}`,
        store: "Albert Heijn",
        shopName: "Albert Heijn",
        storeColor: "#00A0E2",
        storeLogo: "AH",
        emoji: "🛒",
        item: p.title,
        deal: p.bonusMechanism || "Bonus",
        category,
        originalPrice: (p.priceBeforeBonus || 0) * bundleQty,
        newPrice,
        unitPrice: bundleQty > 1 ? parseFloat((newPrice / bundleQty).toFixed(2)) : newPrice,
        savings,
        image,
        hot: savings >= 40,
        validUntil: formatDate(p.bonusEndDate),
        storeLat: 51.0542,
        storeLon: 3.7213,
        // Rijke data (native uit AH mobile-API) — conditioneel, cache-lean.
        ...(/^[a-e]$/i.test(p.nutriscore || "") && { nutriscore: String(p.nutriscore).toLowerCase() }),
        ...(p.brand && { brand: p.brand }),
        ...(p.salesUnitSize && { content: p.salesUnitSize }),
        ...(p.descriptionFull && { description: String(p.descriptionFull).replace(/\n/g, " ").trim().slice(0, 500) }),
      });
    }
  }

  return deals;
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase env vars ontbreken");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "ah", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write mislukt: ${res.status} ${await res.text()}`);
}

export async function scrapeAH() {
  const deals = await fetchDeals();
  if (deals.length === 0) throw new Error("Geen AH deals gevonden");
  await supabaseWrite(deals);
  console.log(`[ah] ${deals.length} deals`);
  return { total: deals.length };
}
