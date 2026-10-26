// Versleverancier scraper — publieke WooCommerce Store API v1
// GET /wp-json/wc/store/v1/products?on_sale=true — geen auth vereist

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORE_LAT = 51.037;
const STORE_LON = 3.622;
const STORE_CITY = "Gent";
const STORE_ADDRESS = "Antoon Catriestraat 39H, 9031 Gent";

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function mapCategory(wcCategories) {
  const names = (wcCategories || []).map(c => (c.name || "").toUpperCase());
  if (names.some(n => n.includes("SAP") || n.includes("SOEP"))) return "Dranken";
  return "Groenten & Fruit";
}

async function supabaseWrite(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "versleverancier", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

export async function scrapeVersleverancier() {
  const res = await fetch(
    "https://www.versleverancier.be/wp-json/wc/store/v1/products?on_sale=true&per_page=100",
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const products = await res.json();
  if (!Array.isArray(products)) throw new Error("Onverwacht API-formaat");

  const divisor = 100; // currency_minor_unit = 2 (EUR)
  const validUntil = dutchDate(7);
  const deals = [];

  for (const p of products) {
    const regularPrice = parseInt(p.prices?.regular_price || "0") / divisor;
    const salePrice    = parseInt(p.prices?.sale_price    || "0") / divisor;
    if (!salePrice || salePrice <= 0) continue;
    if (!p.name) continue;

    const savings = regularPrice > 0
      ? Math.round((1 - salePrice / regularPrice) * 100)
      : 0;

    const category = mapCategory(p.categories);
    const image    = Array.isArray(p.images) && p.images.length ? p.images[0].src : null;

    deals.push({
      id: `versleverancier-${p.id}`,
      productUrl: p.permalink || null,
      store: "Versleverancier",
      shopName: "Versleverancier",
      storeColor: "#4e8020",
      storeLogo: "VL",
      storeLat: STORE_LAT,
      storeLon: STORE_LON,
      storeCity: STORE_CITY,
      storeAddress: STORE_ADDRESS,
      item: p.name,
      deal: savings > 0 ? `${savings}% korting` : "Promo",
      category,
      originalPrice: regularPrice,
      newPrice: salePrice,
      savings,
      validUntil,
      hot: savings >= 30,
      emoji: category === "Dranken" ? "🥤" : "🥦",
      image,
    });
  }

  if (deals.length === 0) throw new Error("Geen deals geparseerd");

  await supabaseWrite(deals);
  console.log(`[Versleverancier] ${deals.length} deals opgeslagen`);
  return { total: deals.length };
}
