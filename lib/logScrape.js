// Identiek aan app/lib/logScrape.js maar zonder Next.js module-aliassen (Railway/Node.js)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL = process.env.ALERT_EMAIL || "hallo@dealoco.be";

export const MIN_DEALS = {
  colruyt: 20,
  Lidl: 20,
  Aldi: 30,
  Delhaize: 50,
  Jumbo: 20,
  bakkersonline: 50,
  slagersonline: 20,
  farmaline: 30,
  drinxit: 3,
  prikentik: 3,
  renmans: 10,
  alvo: 30,
  tanger: 5,
  amazingoriental: 5,
  aula: 3,
  "Albert Heijn": 50,
  action: 10,
  Carrefour: 30,
  OKay: 20,
  "Bio-Planet": 5,
  Callens: 5,
  Vercammen: 5,
  Versleverancier: 5,
  Rechtvantveld: 2,
  Dillen: 5,
  Groentebroer: 5,
  Hubo: 50,
  "Intermarché": 50,
  Bonap: 5,
  Aveve: 10,
  brico: 5,
  coolblue: 200,
  euroshop: 100,
  delitraiteur: 3,
  tomco: 10,
  artencraft: 50,
};

function computeStatus(source, dealCount, emptyOk) {
  const min = MIN_DEALS[source] ?? 5;
  if (min === 0) return "ok";
  // Bron meldt expliciet dat er geen promoties zijn (bijv. Drinxit "geen promoties")
  // → geen scraperfout, dus geen 'failed'/alert.
  if (dealCount === 0 && emptyOk) return "ok";
  if (dealCount === 0) return "failed";
  if (dealCount < min) return "warning";
  return "ok";
}

export async function logScrape({ source, dealCount, errors = [], durationMs, emptyOk = false }) {
  const status = computeStatus(source, dealCount, emptyOk);

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/scrape_logs`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source,
          deal_count: dealCount,
          error_count: errors.length,
          duration_ms: durationMs,
          status,
          errors,
        }),
      });
      if (!res.ok) console.error(`[logScrape] Supabase write failed for ${source}: ${res.status}`);
    } catch (err) {
      console.error(`[logScrape] Failed to write log for ${source}:`, err.message);
    }
  }

  if (status === "failed" && RESEND_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    // Max 1 alert per 24u per source. Als Supabase check faalt → NIET alerteren (fail-safe).
    let shouldAlert = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/scrape_logs?source=eq.${encodeURIComponent(source)}&status=eq.failed&scraped_at=gte.${since}&select=scraped_at&order=scraped_at.asc&limit=1`,
        { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }, signal: controller.signal }
      );
      clearTimeout(timeout);
      if (checkRes.ok) {
        const [oldest] = await checkRes.json();
        if (!oldest || Date.now() - new Date(oldest.scraped_at).getTime() <= 60000) {
          shouldAlert = true;
        }
      }
    } catch {}

    if (shouldAlert) try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "DealRadar <noreply@dealoco.be>",
          to: [ALERT_EMAIL],
          subject: `\uD83D\uDEA8 Scraper gefaald: ${source}`,
          html: `<p><strong>${source}</strong> heeft gefaald (0 deals gevonden).</p>
                 <p>Tijdstip: ${new Date().toISOString()}</p>
                 <p>Duur: ${durationMs}ms</p>
                 ${errors.length > 0 ? `<p>Foutmelding: <code>${errors.join(", ")}</code></p>` : ""}`,
        }),
      });
    } catch (err) {
      console.error(`[logScrape] Failed to send alert email for ${source}:`, err.message);
    }
  }

  return status;
}
