// Gebroeders Vercammen scraper — HTML parsing van homepage promo-swiper
// 16 weekaanbiedingen in div.product-promo-card, volledig server-rendered
import { parse as parseHtml } from "node-html-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORE_LAT = 51.159;
const STORE_LON = 4.988;
const STORE_CITY = "Geel";
const STORE_ADDRESS = "Geel (provincie Antwerpen)";

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function mapCategory(siteCategory) {
  const s = (siteCategory || "").toLowerCase();
  if (s === "ijs") return "Diepvries";
  return "Groenten & Fruit";
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
    body: JSON.stringify({ key: "vercammen", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

export async function scrapeVercammen() {
  const res = await fetch("https://gebroedersvercammen.shop/", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();

  const root = parseHtml(html);

  // Zoek de promo swiper-sectie
  const swiper = root.querySelector(".swiper-container-promos");
  if (!swiper) throw new Error(".swiper-container-promos niet gevonden — paginastructuur gewijzigd");

  const cards = swiper.querySelectorAll(".product-promo-card");
  if (!cards.length) throw new Error("Geen .product-promo-card elementen gevonden");

  const validUntil = dutchDate(7);
  const seen = new Set();
  const deals = [];

  for (const card of cards) {
    // Productnaam uit h4 > a
    const nameEl = card.querySelector("h4 a");
    const name = nameEl?.text?.trim();
    if (!name) continue;

    // Slug/ID uit href
    const href = nameEl?.getAttribute("href") || card.querySelector("a")?.getAttribute("href") || "";
    const slugMatch = href.match(/\/product\/([^/?#]+)/);
    const slug = slugMatch?.[1] || slugify(name);
    const id = `vercammen-${slug}`;
    if (seen.has(id)) continue;
    seen.add(id);

    // Categorie
    const cat = card.querySelector(".product-promo-catagory")?.text?.trim() || "";

    // Prijs — "€5", "€3.5", "€13.50" (euro-teken + getal)
    const priceText = card.querySelector(".product-promo-price")?.text || "";
    const priceMatch = priceText.match(/(\d+[.,]\d+|\d+)/);
    const newPrice = priceMatch ? parseFloat(priceMatch[1].replace(",", ".")) : 0;

    // Afbeelding
    const img = card.querySelector("img")?.getAttribute("src") || null;

    deals.push({
      id,
      productUrl: `https://gebroedersvercammen.shop/product/${slug}`,
      store: "Vercammen",
      shopName: "Gebroeders Vercammen",
      storeColor: "#558b2f",
      storeLogo: "GV",
      storeLat: STORE_LAT,
      storeLon: STORE_LON,
      storeCity: STORE_CITY,
      storeAddress: STORE_ADDRESS,
      item: name,
      deal: "Weekaanbieding",
      category: mapCategory(cat),
      originalPrice: 0,
      newPrice,
      savings: 0,
      validUntil,
      hot: false,
      emoji: "🥦",
      image: img,
    });
  }

  if (deals.length === 0) throw new Error("Geen deals geparseerd");

  await supabaseWrite(deals);
  console.log(`[Vercammen] ${deals.length} deals opgeslagen`);
  return { total: deals.length };
}
