// Prik&Tik scraper — chain-wide promos via Magento 2 GraphQL
// Geen auth, geen anti-bot. Category ID 544 = "Promo's".
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GQL_URL = "https://www.prikentik.be/graphql";
const CATEGORY_ID = "544";

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

// Parse bundle savings uit productnaam, bv. "Cornet Oaked (4+2)" -> 33%
// of "Porto CRUZ Ruby 1l (33% gratis)" -> 33%
function parseSavingsFromName(name, percentOff) {
  if (percentOff && percentOff > 0) return { savings: Math.round(percentOff), isBundleDeal: false };

  // "(N+M)" clip pattern -> M/(N+M) korting
  const clipMatch = name.match(/\((\d+)\s*\+\s*(\d+)\)/);
  if (clipMatch) {
    const buy = parseInt(clipMatch[1]);
    const free = parseInt(clipMatch[2]);
    return { savings: Math.round(free / (buy + free) * 100), isBundleDeal: true };
  }

  // "X% gratis" in naam
  const gratisMatch = name.match(/(\d+)\s*%\s*gratis/i);
  if (gratisMatch) {
    return { savings: parseInt(gratisMatch[1]), isBundleDeal: true };
  }

  return { savings: 0, isBundleDeal: false };
}

// Maak een leesbare deal-beschrijving
function buildDealText(name, savings, _isBundleDeal, _percentOff) {
  const clipMatch = name.match(/\((\d+)\s*\+\s*(\d+)\)/);
  if (clipMatch) return `${clipMatch[1]}+${clipMatch[2]} gratis`;
  const gratisMatch = name.match(/(\d+)\s*%\s*gratis/i);
  if (gratisMatch) return `${gratisMatch[1]}% gratis`;
  if (savings > 0) return `-${savings}% korting`;
  return name;
}

async function fetchDeals() {
  const query = `{
    products(filter: { category_id: { eq: "${CATEGORY_ID}" } }, pageSize: 100, currentPage: 1) {
      total_count
      items {
        id
        name
        sku
        small_image { url }
        short_description { html }
        price_range {
          minimum_price {
            regular_price { value }
            final_price { value }
            discount { amount_off percent_off }
          }
        }
        categories { name url_key }
      }
    }
  }`;

  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`Prik&Tik GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Prik&Tik GraphQL fout: ${json.errors[0].message}`);

  const items = json.data?.products?.items || [];
  const deals = [];

  for (const item of items) {
    const price = item.price_range?.minimum_price;
    const regularPrice = price?.regular_price?.value || 0;
    const finalPrice = price?.final_price?.value || 0;
    const percentOff = price?.discount?.percent_off || 0;

    const { savings, isBundleDeal } = parseSavingsFromName(item.name, percentOff);
    if (savings === 0) continue; // geen herkenbare korting

    const dealText = buildDealText(item.name, savings, isBundleDeal, percentOff);
    const originalPrice = isBundleDeal ? 0 : (regularPrice || 0);
    const newPrice = finalPrice || regularPrice || 0;

    deals.push({
      id: `prikentik-${item.id}`,
      store: "Drankenhandels",
      storeColor: "#e8320a",
      storeLogo: "PT",
      emoji: "🍺",
      item: item.name,
      deal: dealText,
      category: "Dranken",
      originalPrice,
      newPrice,
      savings,
      image: item.small_image?.url || "",
      hot: savings >= 30,
      validUntil: dutchDate(7),
    });
  }

  return deals;
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("[Prikentik] Supabase env vars ontbreken");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "prikentik", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write mislukt: ${res.status} ${await res.text()}`);
}

export async function scrapeAllPrikentik() {
  const deals = await fetchDeals();
  console.log(`[Prikentik] ${deals.length} deals gevonden`);
  if (deals.length === 0) {
    console.warn("[Prikentik] 0 deals gevonden — Supabase niet overschreven");
    return { count: 0 };
  }
  await supabaseWrite(deals);
  return { count: deals.length };
}
