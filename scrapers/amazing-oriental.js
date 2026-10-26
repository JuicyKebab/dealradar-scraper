// Amazing Oriental scraper — HTML parsing, geen Playwright nodig
import https from "https";
import http from "http";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "nl-NL,nl;q=0.9",
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

const TABS = [
  { slug: "weekly-specials",  deal: "Weekly Deal",    category: null },
  { slug: "amazingdeals",     deal: "Amazing Deal",   category: null },
  { slug: "40-jaar-jubileum", deal: "Jubileum Deal",  category: null },
  { slug: "vis-en-vlees",     deal: "Vis & Vlees",    category: "Vlees & Vis" },
];

function guessCategory(name, brand) {
  const n = (name + " " + brand).toLowerCase();
  if (/garnaal|shrimp|prawn|vis |fish|zalm|salmon|vlees|meat|kip|chicken|pork|pork|beef|rund|varken|eel|aal|kreeft|inkt/.test(n)) return "Vlees & Vis";
  if (/groente|vegetable|fruit|aubergine|mushroom|paddenstoel|knoflook|gember|ui |sjalot|peer |eddo|loquat|choi|bok choy/.test(n)) return "Groenten & Fruit";
  if (/noodle|noedel|rijst|pasta|saus|sauce|soup|soep|curry|seasoning|spice|olie|oil|noten|nut|peanut|sesam|tofu|miso|soja/.test(n)) return "Droogwaren";
  if (/drank|drink|bier|beer|wijn|wine|sap|juice|water|koffie|thee|tea/.test(n)) return "Dranken";
  if (/ijs|ice cream|frozen|diepvries/.test(n)) return "Diepvries";
  if (/koek|biscuit|cake|snack|chips|chocolade|candy|snoep|wafer/.test(n)) return "Bakkerij & Snacks";
  return "Droogwaren"; // default voor Aziatische supermarkt
}

function parseItems(html, tabDeal, tabCategory) {
  const results = [];
  const blocks = html.split('<div class="item">').slice(1);
  for (const block of blocks) {
    const name = (block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) || [])[1]
      ?.replace(/<[^>]+>/g, "").trim();
    if (!name) continue;

    const brand = (block.match(/class="brand"[^>]*>([\s\S]*?)<\/span>/) || [])[1]
      ?.replace(/<[^>]+>/g, "").trim() || "";

    const newPriceStr = (block.match(/class="new-price"[^>]*>([\d,.]+)</) || [])[1];
    const origPriceStr = (block.match(/class="original-price[^"]*"[^>]*>([\d,.]+)</) || [])[1];
    const label = (block.match(/class="label"[^>]*>([\s\S]*?)<\/span>/) || [])[1]
      ?.replace(/<[^>]+>/g, "").trim() || "";
    const image = (block.match(/data-bg="(https:\/\/amazingoriental\.com\/wp-content[^"]+\.(?:webp|jpg|png))"/) || [])[1] || "";

    const newPrice = newPriceStr ? parseFloat(newPriceStr.replace(",", ".")) : 0;
    const origPrice = origPriceStr ? parseFloat(origPriceStr.replace(",", ".")) : 0;

    // Sanity check: skip if looks like kg/weight confusion
    let finalOrigPrice = origPrice;
    if (finalOrigPrice > 0 && newPrice > 0 && finalOrigPrice > newPrice * 6) finalOrigPrice = 0;

    const savings = (finalOrigPrice > 0 && newPrice > 0 && finalOrigPrice > newPrice)
      ? Math.round((finalOrigPrice - newPrice) / finalOrigPrice * 100)
      : 0;

    const dealLabel = label ? `${tabDeal} · ${label}` : tabDeal;
    const category = tabCategory || guessCategory(name, brand);

    results.push({ name, brand, newPrice, origPrice: finalOrigPrice, savings, dealLabel, category, image });
  }
  return results;
}

async function supabaseWrite(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "amazingoriental", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

export async function scrapeAmazingOriental() {
  const validUntil = dutchDate(7);
  const seen = new Set();
  const deals = [];

  // All tab URLs return the same full HTML — fetch once and split by items-wrap section.
  // Tab order in HTML matches TABS array order.
  let html;
  try {
    html = await fetchHtml("https://amazingoriental.com/aanbiedingen/?offer=weekly-specials");
  } catch (err) {
    console.error("[amazingoriental] Failed to fetch page:", err.message);
    return { total: 0 };
  }

  // Split into per-tab sections
  const sections = html.split('<div class="items-wrap cf">').slice(1);
  console.log(`[amazingoriental] Found ${sections.length} sections`);

  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    const sectionHtml = sections[i] || "";

    const items = parseItems(sectionHtml, tab.deal, tab.category);
    console.log(`[amazingoriental] Tab ${tab.slug}: ${items.length} items`);

    for (const item of items) {
      const idBase = slugify((item.brand + "-" + item.name).slice(0, 60));
      const id = `amazingoriental-${idBase}`;
      if (seen.has(id)) continue;
      seen.add(id);

      deals.push({
        id,
        store: "Amazing Oriental",
        storeColor: "#c62828",
        storeLogo: "O",
        item: item.brand ? `${item.brand} ${item.name}` : item.name,
        deal: item.dealLabel,
        category: item.category,
        originalPrice: item.origPrice,
        newPrice: item.newPrice,
        savings: item.savings,
        validUntil,
        hot: item.savings >= 30,
        ...(item.image && { image: item.image }),
      });
    }
  }

  await supabaseWrite(deals);
  return { total: deals.length };
}
