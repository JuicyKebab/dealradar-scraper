// Van Asten Babysuperstore scraper — Daisycon XML productfeed
// Geen Playwright/Brightdata nodig — simpele HTTP fetch + XML parse

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEED_URL = "https://daisycon.io/datafeed/?media_id=421678&standard_id=1&language_code=nl&locale_id=2&type=xml&program_id=16830&html_transform=none&rawdata=false&encoding=utf8&general=false";
const MIN_SAVINGS_PCT = 10;

function cdata(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
  return m ? m[1].trim() : "";
}

function categorize(categoryPath, title) {
  const s = (categoryPath + " " + title).toLowerCase();
  if (s.includes("babyfoon") || s.includes("monitor")) return "Elektronica";
  if (s.includes("meubel") || s.includes("babybed") || s.includes("wieg") || s.includes("kinderstoel") || s.includes("matras") || s.includes("deken") || s.includes("slaapzak") || s.includes("commode") || s.includes("kast")) return "Huishouden";
  if (s.includes("speelgoed") || s.includes("speelkled") || s.includes("gym") || s.includes("jumper") || s.includes("schommel")) return "Overig";
  if (s.includes("verlichting") || s.includes("nachtlamp") || s.includes("sfeerverlichting")) return "Verlichting";
  return "Verzorging";
}

async function supabaseWrite(key, data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("supabaseWrite: env vars ontbreken");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) console.error(`supabaseWrite(${key}) failed: ${res.status}`);
}

export async function scrapeVanAsten() {
  console.log("[vanasten] Fetching Daisycon feed...");
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  const xml = await res.text();

  const productRegex = /<product_info>([\s\S]*?)<\/product_info>/g;
  const deals = [];
  let total = 0;
  let match;

  while ((match = productRegex.exec(xml)) !== null) {
    total++;
    const block = match[1];

    if (cdata(block, "discount") !== "true") continue;
    if (cdata(block, "in_stock") !== "true") continue;

    const price = parseFloat(cdata(block, "price"));
    const priceOld = parseFloat(cdata(block, "price_old"));
    if (!price || !priceOld || priceOld <= price) continue;

    const savings = Math.round((priceOld - price) / priceOld * 100);
    if (savings < MIN_SAVINGS_PCT) continue;

    const title = cdata(block, "title");
    const sku = cdata(block, "sku");
    if (!title || !sku) continue;

    const categoryPath = cdata(block, "category_path");
    const link = cdata(block, "link");
    const brand = cdata(block, "brand");

    // Eerste afbeelding met tag "default"
    const imgMatch = block.match(/<image>[\s\S]*?<tag><!\[CDATA\[default\]\]><\/tag>[\s\S]*?<location><!\[CDATA\[(.*?)\]\]><\/location>[\s\S]*?<\/image>/);
    const image = imgMatch ? imgMatch[1] : "";

    const safeLink = link.startsWith("https://") ? link : null;

    deals.push({
      id: `vanasten-${sku}`,
      store: "Van Asten",
      storeColor: "#FFA000",
      storeLogo: "VA",
      item: title.slice(0, 200),
      deal: `Van \u20AC${priceOld.toFixed(2)} voor \u20AC${price.toFixed(2)}`,
      category: categorize(categoryPath, title),
      originalPrice: priceOld,
      newPrice: price,
      savings,
      image,
      hot: savings >= 30,
      affiliateUrl: safeLink,
      brand,
    });
  }

  deals.sort((a, b) => b.savings - a.savings);
  console.log(`[vanasten] Feed: ${total} producten, ${deals.length} deals (>=${MIN_SAVINGS_PCT}% korting)`);

  await supabaseWrite("vanasten", deals);

  return { total: deals.length };
}
