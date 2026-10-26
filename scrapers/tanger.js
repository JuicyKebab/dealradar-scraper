// Tanger Markt scraper — folder JPEG via WordPress + Claude Haiku vision OCR
import Anthropic from "@anthropic-ai/sdk";
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

function fetchUrl(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft === 0) return reject(new Error(`Too many redirects: ${url}`));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "nl-NL,nl;q=0.9",
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(20_000, () => { req.destroy(new Error(`fetchUrl timeout: ${url}`)); });
    req.on("error", reject);
  });
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
    body: JSON.stringify({ key: "tanger", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

export async function scrapeTanger() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("Missing ANTHROPIC_API_KEY");
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // 1. Fetch promo page and extract folder JPEG URL
  const html = (await fetchUrl("https://tangermarkt.nl/promo/")).toString("utf-8");
  const match = html.match(/https:\/\/tangermarkt\.nl\/wp-content\/uploads\/[^"' )]*\.(?:jpe?g|png|webp)/i);
  if (!match) throw new Error("Folder image URL not found in promo page");
  const folderUrl = match[0];
  console.log("[tanger] Folder URL:", folderUrl);

  // 2. Fetch folder image as base64
  const imgBuffer = await fetchUrl(folderUrl);
  const imgBase64 = imgBuffer.toString("base64");
  console.log(`[tanger] Image size: ${Math.round(imgBuffer.length / 1024)}KB`);

  // 3. OCR with Claude Haiku vision
  const validUntil = dutchDate(7);
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: folderUrl.endsWith(".png") ? "image/png" : folderUrl.endsWith(".webp") ? "image/webp" : "image/jpeg", data: imgBase64 } },
        {
          type: "text",
          text: `Belgian supermarket (Tanger Markt) promotional folder. Extract all deals visible.
For each deal return JSON with these fields:
- item: product name (string)
- deal: promotion description e.g. "Promoprijs", "2+1 gratis", "-50%" (string)
- newPrice: action price per package/unit in euros as float (0 if unknown)
- originalPrice: original price per package/unit in euros as float (0 if unknown)
- savings: discount percentage as integer (0 if unknown)
- category: one of: Bakkerij & Snacks, Dranken, Zuivel, Vlees & Vis, Droogwaren, Diepvries, Groenten & Fruit, Verzorging, Huishouden, Overig

IMPORTANT: newPrice and originalPrice must be monetary euro prices only — never use weight/volume quantities (kg, g, l) as prices. Both prices must be for the same package unit.

Return only a JSON array. If no deals are visible, return [].`,
        },
      ],
    }],
  });

  const raw = response.content[0].text.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  const rawDeals = JSON.parse(raw);

  // 4. Normalize and deduplicate
  const seen = new Set();
  const deals = rawDeals
    .filter(d => d.item && d.deal)
    .map(d => {
      const id = `tanger-${slugify(String(d.item))}`;
      if (seen.has(id)) return null;
      seen.add(id);
      const newPrice = parseFloat(d.newPrice) || 0;
      let originalPrice = parseFloat(d.originalPrice) || 0;
      // Sanity check: ignore if originalPrice looks like a weight (>6x newPrice)
      if (originalPrice > 0 && newPrice > 0 && originalPrice > newPrice * 6) originalPrice = 0;
      // Recompute savings from prices — Claude's calculation is often wrong
      let savings;
      if (originalPrice > 0 && newPrice > 0 && originalPrice > newPrice) {
        savings = Math.round((originalPrice - newPrice) / originalPrice * 100);
      } else {
        savings = Math.min(99, Math.max(0, parseInt(d.savings) || 0));
      }
      return {
        id,
        store: "Tanger",
        storeColor: "#e65100",
        storeLogo: "T",
        item: String(d.item),
        deal: String(d.deal),
        category: d.category || "Overig",
        originalPrice,
        newPrice,
        savings,
        validUntil,
        hot: savings >= 30,
      };
    })
    .filter(Boolean);

  await supabaseWrite(deals);
  return { total: deals.length };
}
