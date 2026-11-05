// Bio-Planet scraper — directe JSON-API (Colruyt Group BFF), geen browser nodig.
// De promopagina is een Vue-app die productdata laadt via:
//   products:  emec.bioplanet.protected.bffsvc/cg/nl/api/products?inPromo=true
//   korting-%: ictmgmt.emarkecom.promotionretrsvc.v1 (benefitPercentage per techPromoId)
// X-CG-APIKey staat publiek in de pagina-HTML; override via env indien hij ooit roteert.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CG_API_KEY = process.env.BIOPLANET_CG_APIKEY || "f0187bee-04aa-11eb-ba0f-e73e45a3f0f2";
const PLACE_ID = process.env.BIOPLANET_PLACE_ID || "1811";
const BFF_PRODUCTS = "https://apip.bioplanet.be/gateway/emec.bioplanet.protected.bffsvc/cg/nl/api/products";
const PROMO_RETR = "https://apip.bioplanet.be/gateway/ictmgmt.emarkecom.promotionretrsvc.v1/v1/v1/nl/promotion";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const API_HEADERS = { "User-Agent": UA, "X-CG-APIKey": CG_API_KEY, Accept: "application/json" };

const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const _DAYS = ["zo","ma","di","wo","do","vr","za"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

// "17-11-2026" (dd-mm-yyyy) → "di 17 november"; valt terug op +7 dagen bij onbekend formaat.
function formatEndDate(ddmmyyyy) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(ddmmyyyy || "");
  if (!m) return dutchDate(7);
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (isNaN(d)) return dutchDate(7);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function normalizeCategory(raw) {
  if (!raw) return "Overig";
  const s = raw.toLowerCase();
  if (/brood|bakkerij|bakery|ontbijt|gebak|patiss|koek|biscuit|chocolade|snoep|snack|chips|cake|muesli|granola|cereal/.test(s)) return "Bakkerij & Snacks";
  if (/wijn|wine|bier|beer|drank|beverage|frisdrank|water|sap|juice|koffie|coffee|thee|tea|alcohol|spirits|limonade/.test(s)) return "Dranken";
  if (/zuivel|dairy|kaas|cheese|yoghurt|melk|milk|boter|butter|eieren|eggs|room |cream|kwark|margarine|plantaardig/.test(s)) return "Zuivel";
  if (/vlees|meat|vis|fish|charcuterie|bereidingen|veggie|worst|gevogelte|poultry|kip|chicken|varken|rund|beef|zeevruchten|seafood|zalm|ham|vegan/.test(s)) return "Vlees & Vis";
  if (/diepvries|frozen|ijsroom|ijscrème|ice cream/.test(s)) return "Diepvries";
  if (/groenten|groente|vegetable|fruit|aardappel|potato|salade|agf/.test(s)) return "Groenten & Fruit";
  if (/pasta|rijst|rice|droog|kruideniers|saus|sauce|conserven|canned|maaltijd|meal|soep|soup|olie|oil|azijn|kruid|spice|bloem|suiker|jam|noten|nuts/.test(s)) return "Droogwaren";
  if (/hygiëne|hygiene|verzorging|care|beauty|cosmet|parfum|lichaam|body|huid|skin|gezondheid|health|haar|hair|mond|dental|scheer|baby/.test(s)) return "Verzorging";
  if (/huishoud|household|schoonmaak|cleaning|reinig|wasmiddel|detergent|papier|paper|keuken|kitchen|afwas|folie|huisdier|hond|kat/.test(s)) return "Huishouden";
  return "Overig";
}

const CATEGORY_EMOJI = {
  "bakkerij & snacks": "🍞", "dranken": "🥤", "zuivel": "🥛", "vlees & vis": "🥩",
  "droogwaren": "🍝", "diepvries": "🧊", "groenten & fruit": "🥦", "verzorging": "🧴",
  "huishouden": "🧹", "overig": "📦",
};
function categoryToEmoji(cat) {
  return CATEGORY_EMOJI[(cat || "").toLowerCase()] || "🛒";
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "bioplanet", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: API_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 120)}`);
  return res.json();
}

async function fetchAllPromoProducts() {
  const size = 50;
  const products = [];
  for (let page = 1; page <= 40; page++) {
    const url = `${BFF_PRODUCTS}?placeId=${PLACE_ID}&page=${page}&size=${size}&sort=popularity+asc&isAvailable=true&inPromo=true`;
    const d = await fetchJSON(url);
    const batch = d.products || [];
    products.push(...batch);
    if (products.length >= (d.productsFound ?? 0) || batch.length < size) break;
  }
  return products;
}

// techPromoId → { pct, amount, minLimit, limitUnit } (korting-detail per promotie)
async function fetchPromotionBenefits(techPromoIds) {
  const map = {};
  for (let i = 0; i < techPromoIds.length; i += 50) {
    const chunk = techPromoIds.slice(i, i + 50);
    const url = `${PROMO_RETR}?promotionIds=${chunk.join(",")}&clientCode=BIOBE&placeId=${PLACE_ID}`;
    let d;
    try { d = await fetchJSON(url); } catch { continue; } // korting-detail is best-effort
    for (const p of (d.promotion || [])) {
      const b = (p.benefit || [])[0] || {};
      map[p.techPromoId || `${p.commercialPromotionId}COLR`] = {
        pct: b.benefitPercentage ?? null,
        amount: b.benefitAmount ?? null,
        minLimit: b.minLimit ?? 1,
        limitUnit: b.limitUnit || "S",
      };
    }
  }
  return map;
}

function benefitToDeal(basicPrice, benefit) {
  if (!benefit) return { newPrice: basicPrice, originalPrice: basicPrice, savings: 0, text: "Promo" };
  const unit = benefit.limitUnit === "S" ? "st" : (benefit.limitUnit || "").toLowerCase();
  const vanaf = benefit.minLimit > 1 ? ` vanaf ${benefit.minLimit} ${unit}` : "";
  if (benefit.pct != null) {
    const savings = Math.min(99, Math.round(benefit.pct));
    const newPrice = parseFloat((basicPrice * (1 - savings / 100)).toFixed(2));
    return { newPrice, originalPrice: basicPrice, savings, text: `-${savings}%${vanaf}` };
  }
  if (benefit.amount != null) {
    const newPrice = parseFloat(Math.max(0, basicPrice - benefit.amount).toFixed(2));
    const savings = basicPrice > 0 ? Math.min(99, Math.round((benefit.amount / basicPrice) * 100)) : 0;
    return { newPrice, originalPrice: basicPrice, savings, text: `-€${benefit.amount.toFixed(2)}${vanaf}` };
  }
  return { newPrice: basicPrice, originalPrice: basicPrice, savings: 0, text: "Promo" };
}

export async function scrapeBioplanet() {
  const products = await fetchAllPromoProducts();
  if (products.length === 0) {
    throw new Error("Bio-Planet BFF gaf 0 promoproducten terug");
  }

  const techPromoIds = [...new Set(products.flatMap(p => (p.promotion || []).map(pr => pr.techPromoId).filter(Boolean)))];
  const benefits = await fetchPromotionBenefits(techPromoIds);

  const deals = [];
  const seen = new Set();
  for (const p of products) {
    const id = p.productId || p.commercialArticleNumber || p.retailProductNumber;
    const name = p.name || p.LongName;
    const basicPrice = p.price?.basicPrice;
    if (!id || seen.has(id) || !name || !basicPrice) continue;
    seen.add(id);

    const promo = (p.promotion || [])[0];
    const benefit = promo ? benefits[promo.techPromoId] : null;
    const { newPrice, originalPrice, savings, text } = benefitToDeal(basicPrice, benefit);

    const cat = normalizeCategory(p.topCategoryName || (p.categories?.[0]?.name));
    deals.push({
      id: `bioplanet-${id}`,
      store: "Bio-Planet",
      storeColor: "#4caf50",
      storeLogo: "BP",
      emoji: categoryToEmoji(cat),
      item: name,
      deal: text,
      category: cat,
      originalPrice,
      newPrice,
      savings,
      validUntil: formatEndDate(promo?.publicationEndDate),
      hot: savings >= 25,
      image: p.squareImage || p.fullImage || p.thumbNail || null,
    });
  }

  console.log(`[bioplanet] ${deals.length} deals (uit ${products.length} producten)`);
  if (deals.length > 0) await supabaseWrite(deals);
  return { total: deals.length };
}
