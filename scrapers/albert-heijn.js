// Albert Heijn Netherlands — JSON API (no browser needed)
const _DDAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _DMONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function isoToDutch(dateStr) {
  if (!dateStr) return dutchDate(7);
  const d = new Date(dateStr);
  if (isNaN(d)) return dutchDate(7);
  return `${_DDAYS[d.getDay()]} ${d.getDate()} ${_DMONTHS[d.getMonth()]}`;
}

function categoryToEmoji(cat) {
  const map = {
    "dranken": "🥤", "zuivel": "🥛", "vlees": "🥩", "brood": "🍞",
    "diepvries": "🧊", "groenten": "🥦", "fruit": "🍎", "koeken": "🍫",
    "chocolade": "🍫", "wijn": "🍷", "bier": "🍺", "snacks": "🍿",
    "kaas": "🧀", "charcuterie": "🥓",
  };
  if (!cat) return "🛒";
  const lower = cat.toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (lower.includes(key)) return emoji;
  }
  return "🛒";
}

let ahTokenCache = null;
let ahTokenExpiry = 0;

async function getAHToken() {
  if (ahTokenCache && Date.now() < ahTokenExpiry) return ahTokenCache;
  const res = await fetch("https://api.ah.nl/mobile-auth/v1/auth/token/anonymous", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Appie/8.22.3 Model/phone Android/7.0",
      "x-application": "AHWEBSHOP",
    },
    body: JSON.stringify({ clientId: "appie" }),
  });
  if (!res.ok) throw new Error(`AH auth failed: ${res.status}`);
  const data = await res.json();
  ahTokenCache = data.access_token;
  ahTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return ahTokenCache;
}

async function scrapeAlbertHeijn(maxResults = 15) {
  const token = await getAHToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Appie/8.22.3 Model/phone Android/7.0",
    "x-application": "AHWEBSHOP",
  };

  // Try direct bonus list endpoint
  const bonusRes = await fetch("https://api.ah.nl/mobile-services/bonuspage/v1/bonus", { headers });
  if (bonusRes.ok) {
    const data = await bonusRes.json();
    const products = data.bonusGroups?.flatMap(g => g.products || []) || data.products || [];
    if (products.length > 0) {
      return products.slice(0, maxResults).map((p, i) => mapAHProduct(p, i));
    }
  }

  // Fallback: try segments via metadata
  const metaRes = await fetch("https://api.ah.nl/mobile-services/bonuspage/v1/metadata", { headers });
  if (!metaRes.ok) throw new Error(`AH metadata failed: ${metaRes.status}`);
  const meta = await metaRes.json();

  const today = new Date().toISOString().split("T")[0];
  const segments = (meta.cortGroups || []).flatMap(g => g.segments || []).slice(0, 5);
  const products = [];

  for (const seg of segments) {
    if (products.length >= maxResults) break;
    try {
      const segRes = await fetch(
        `https://api.ah.nl/mobile-services/bonuspage/v1/segment?date=${today}&segmentId=${seg.id}`,
        { headers }
      );
      if (!segRes.ok) continue;
      const segData = await segRes.json();
      products.push(...(segData.products || []));
    } catch { /* skip */ }
  }

  return products.slice(0, maxResults).map((p, i) => mapAHProduct(p, i));
}

function mapAHProduct(p, i) {
  const currentPrice = p.currentPrice?.amount ?? p.priceLabel?.now ?? 0;
  const previousPrice = p.priceBeforeBonus?.amount ?? p.priceLabel?.was ?? currentPrice;
  const savings = previousPrice > currentPrice ? Math.round((1 - currentPrice / previousPrice) * 100) : 0;
  return {
    id: 3000 + i,
    store: "Albert Heijn", storeColor: "#00A0E2", storeLogo: "AH",
    item: p.title || p.name || "Onbekend product",
    deal: savings > 0 ? `-${savings}%` : (p.bonusMechanism || p.priceLabel?.signalWord || "Bonus"),
    category: p.mainCategory || p.subCategory || "Overig",
    originalPrice: previousPrice, newPrice: currentPrice, savings,
    emoji: categoryToEmoji(p.mainCategory || p.subCategory),
    validUntil: isoToDutch(p.bonusEndDate || p.endDate),
    hot: savings >= 30,
    description: p.descriptionFull || "",
    image: p.images?.[0]?.url || null,
  };
}

module.exports = { scrapeAlbertHeijn };
