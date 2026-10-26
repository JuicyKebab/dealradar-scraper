// Dillen Groenten & Fruit scraper — publieke WooCommerce Store API v1
// 3 vestigingen: Berlaar (hoofdfarm), Putte, Aarschot
// Elke deal wordt 3x opgeslagen (één per locatie) zodat alle vestigingen op de kaart verschijnen
// Site geeft 403 van datacenter IPs — route via Brightdata residential proxy
import { ProxyAgent, fetch as undiciFetch } from "undici";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BD_HOST = process.env.BRIGHTDATA_HOST;
const BD_USER = process.env.BRIGHTDATA_USER;
const BD_PASS = process.env.BRIGHTDATA_PASS;
const USE_PROXY = !!(BD_HOST && BD_USER && BD_PASS);

const proxyUrl = USE_PROXY
  ? `http://${BD_USER}:${BD_PASS}@${BD_HOST.includes(":") ? BD_HOST : BD_HOST + ":22225"}`
  : null;
const proxyDispatcher = proxyUrl ? new ProxyAgent({
  uri: proxyUrl,
  requestTls: { rejectUnauthorized: false },
  proxyTls: { rejectUnauthorized: false },
}) : null;

const LOCATIONS = [
  { key: "berlaar", shopName: "Dillen (Berlaar)",  lat: 51.1176, lon: 4.6584, city: "Berlaar",  address: "Gangelberg 3, 2590 Berlaar"          },
  { key: "putte",   shopName: "Dillen (Putte)",    lat: 51.0568, lon: 4.6413, city: "Putte",    address: "Mechelbaan 404, 2580 Putte"           },
  { key: "aarschot",shopName: "Dillen (Aarschot)", lat: 51.0011, lon: 4.8283, city: "Aarschot", address: "Herseltsesteenweg 82, 3200 Aarschot"  },
];

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function mapCategory(wcCategories) {
  const names = (wcCategories || []).map(c => (c.name || "").toLowerCase());
  if (!names.length) return "Overig"; // geen categorie = bloemen e.d.
  if (names.some(n => n.includes("groent") || n.includes("fruit") || n.includes("aardappel") || n.includes("ajuin") || n.includes("look"))) return "Groenten & Fruit";
  return "Groenten & Fruit"; // overige producten van een groenten & fruitwinkel
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
    body: JSON.stringify({ key: "dillen", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

export async function scrapeDillen() {
  const fetchFn = USE_PROXY ? undiciFetch : fetch;
  const fetchOpts = {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    ...(USE_PROXY ? { dispatcher: proxyDispatcher } : {}),
  };
  const res = await fetchFn(
    "https://dillen-groentenfruit.be/wp-json/wc/store/v1/products?on_sale=true&per_page=100",
    fetchOpts
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
    const productUrl = p.permalink || null;

    // Eén deal-entry per vestiging
    for (const loc of LOCATIONS) {
      deals.push({
        id: `dillen-${loc.key}-${p.id}`,
        productUrl,
        store: "Groenten & Fruit",
        shopName: loc.shopName,
        storeColor: "#388e3c",
        storeLogo: "DG",
        storeLat: loc.lat,
        storeLon: loc.lon,
        storeCity: loc.city,
        storeAddress: loc.address,
        item: p.name,
        deal: savings > 0 ? `${savings}% korting` : "Promo",
        category,
        originalPrice: regularPrice,
        newPrice: salePrice,
        savings,
        validUntil,
        hot: savings >= 30,
        emoji: category === "Overig" ? "🌸" : "🥦",
        image,
      });
    }
  }

  if (deals.length === 0) throw new Error("Geen deals geparseerd");

  await supabaseWrite(deals);
  console.log(`[Dillen] ${deals.length} deals opgeslagen (${deals.length / LOCATIONS.length} producten x ${LOCATIONS.length} vestigingen)`);
  return { total: deals.length };
}
