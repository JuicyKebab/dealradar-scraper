// Art & Craft scraper — Daisycon XML productfeed
// Geen Playwright/Brightdata nodig — simpele HTTP fetch + XML parse

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEED_URL = "https://daisycon.io/datafeed/?media_id=421678&standard_id=1&language_code=nl&locale_id=2&type=xml&program_id=15332&html_transform=none&rawdata=false&encoding=utf8&general=false";
const MIN_SAVINGS_PCT = 5;

function cdata(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
  return m ? m[1].trim() : "";
}

function categorize(category, title) {
  const s = (category + " " + title).toLowerCase();
  if (s.includes("keuken") || s.includes("koken") || s.includes("vaatwas") || s.includes("wasmachine") || s.includes("droger") || s.includes("strijkplank") || s.includes("stofzuiger") || s.includes("broodrooster") || s.includes("waterkoker") || s.includes("wafelijzer") || s.includes("frituur") || s.includes("kledingstomer")) return "Huishouden";
  if (s.includes("huishoud") || s.includes("woning")) return "Huishouden";
  if (s.includes("verzorging") || s.includes("beauty")) return "Verzorging";
  if (s.includes("tuin") || s.includes("outdoor") || s.includes("vuurkorf") || s.includes("barbecue")) return "Tuin";
  // Al het andere is elektronica (beeld & geluid, computer, fotografie, smart home, etc.)
  return "Elektronica";
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

export async function scrapeArtAndCraft() {
  console.log("[artencraft] Fetching Daisycon feed...");
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

    const price = parseFloat(cdata(block, "price"));
    const priceOld = parseFloat(cdata(block, "price_old"));
    if (!price || !priceOld || priceOld <= price) continue;

    const savings = Math.round((priceOld - price) / priceOld * 100);
    if (savings < MIN_SAVINGS_PCT) continue;

    const title = cdata(block, "title").replace(/\s*\|\s*\|.*$/, "").trim();
    const sku = cdata(block, "sku");
    if (!title || !sku) continue;

    const category = cdata(block, "category");
    const link = cdata(block, "link");
    const brand = cdata(block, "brand");

    const imgMatch = block.match(/<image>[\s\S]*?<tag><!\[CDATA\[default\]\]><\/tag>[\s\S]*?<location><!\[CDATA\[(.*?)\]\]><\/location>[\s\S]*?<\/image>/);
    const image = imgMatch ? imgMatch[1] : "";

    const safeLink = link.startsWith("https://") ? link : null;

    deals.push({
      id: `artencraft-${sku}`,
      store: "Art & Craft",
      storeColor: "#1a237e",
      storeLogo: "AR",
      item: title.slice(0, 200),
      deal: `Van \u20AC${priceOld.toFixed(2)} voor \u20AC${price.toFixed(2)}`,
      category: categorize(category, title),
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
  console.log(`[artencraft] Feed: ${total} producten, ${deals.length} deals (>=${MIN_SAVINGS_PCT}% korting)`);

  await supabaseWrite("artencraft", deals);

  return { total: deals.length };
}
