import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const squad = JSON.parse(fs.readFileSync(path.join(__dirname, "squad.json"), "utf8"));
const gamedata = JSON.parse(fs.readFileSync(path.join(__dirname, "gamedata.json"), "utf8"));

const resend = new Resend(process.env.RESEND_API_KEY);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL;

// Only send core riders to researcher (skip fillers, keep it short)
const coreRiders = squad.riders
  .filter((r) => r.role === "core")
  .map((r) => r.name)
  .join(", ");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ─── Shared fetch helper with retry ──────────────────────────────────────────

async function callClaude({ system, user, tools = [], maxTokens = 2000, model = "claude-sonnet-4-20250514" }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        tools,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (response.status === 429) {
      const wait = attempt * 30000; // 30s, 60s, 90s
      console.log(`Rate limited (attempt ${attempt}). Waiting ${wait/1000}s...`);
      await sleep(wait);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${err}`);
    }

    const data = await response.json();
    return data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  throw new Error("Failed after 3 retries due to rate limiting");
}

// ─── Agent 1: Researcher (Haiku) ─────────────────────────────────────────────

async function runResearcher(today) {
  console.log("Agent 1 (Researcher) starting...");

  // Minimal system prompt to save tokens
  const system = `You are a cycling research agent. Today is ${today}. Return ONLY a raw JSON object, no markdown, no explanation.

Required JSON structure:
{"races":[{"name":"...","date":"...","type":"Monument|WorldTour|NietWorldTour"}],"starters":{"race name":["Rider Name"]},"dns":{"race name":[{"name":"...","reason":"..."}]},"news":[{"headline":"...","detail":"...","source":"...","relevance":"..."}]}`;

  const user = `Search for:
1. Pro cycling races in the next 7 days (name, date, type)
2. Startlists for races in next 2 days: search "[race] 2026 startlist"
3. DNS/injury news for: ${coreRiders}
4. Latest cycling news last 24h (min 3 items) from Sporza or WielerFlits

Return only the JSON object.`;

  const raw = await callClaude({
    system,
    user,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    maxTokens: 2000,
    model: "claude-haiku-4-5-20251001",
  });

  // Extract JSON robustly
  let clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Researcher returned no JSON object");
  clean = clean.slice(start, end + 1).trim();

  try {
    const data = JSON.parse(clean);
    console.log(`Agent 1 done: ${data.races?.length ?? 0} races, ${data.news?.length ?? 0} news items`);
    return data;
  } catch (e) {
    console.error("JSON parse failed:", e.message, clean.slice(0, 300));
    throw new Error("Researcher agent returned invalid JSON");
  }
}

// ─── Agent 2: Writer (Sonnet) ─────────────────────────────────────────────────

async function runWriter(today, research) {
  console.log("Agent 2 (Writer) starting...");

  const { allRiders, ...gamedataSlim } = gamedata;
  const nextTransferCost = Math.max(0, squad.transfersUsed - 2);

  const system = `You are a Sporza Wielermanager briefing writer for the 2026 spring classics season.

## Game Rules (key facts)
- Squad: 20 riders. Field 12 per race, 8 on bench.
- Kopman bonus (on top of normal points): 1st=30, 2nd=25, 3rd=20, 4th=15, 5th=10, 6th=5
- Teammate of winner: +10 bonus points
- Points to position 30. Monument win=125pts, WorldTour win=100pts, NietWorldTour win=80pts.
- Free transfers: 3 total. Thomas has used ${squad.transfersUsed}. Next transfer costs ${nextTransferCost}M.
- Max 4 riders per team.

## Race calendar (remaining)
${JSON.stringify(gamedataSlim.raceCalendar, null, 2)}

## Thomas's squad
${JSON.stringify(squad, null, 2)}

## Rules
- ONLY recommend riders confirmed in the verified startlist. If not confirmed, bench them with a note.
- Never invent news — only use items from research data.
- Last names only. Direct and punchy.
- Clean HTML only: <h2> headers, <ul><li> lists, <strong> emphasis. No markdown.
- Return inner HTML only, no <html>/<body> tags.`;

  const user = `Today is ${today}.

Verified research data:
${JSON.stringify(research, null, 2)}

Write the daily briefing:
1. <h2>This Week's Races</h2> — with dates and type
2. <h2>Recommended Lineup (12)</h2> — confirmed starters only, point potential per rider
3. <h2>Bench (8)</h2> — with DNS flags where relevant
4. <h2>Kopman Pick</h2> — who, why, max bonus points possible
5. <h2>Transfers</h2> — cost ${nextTransferCost}M for next transfer. Recommend action or hold.
6. <h2>News & Gossip</h2> — from research only, with source`;

  const html = await callClaude({
    system,
    user,
    tools: [],
    maxTokens: 2000,
    model: "claude-sonnet-4-20250514",
  });

  console.log("Agent 2 done.");
  return html;
}

// ─── Email wrapper ────────────────────────────────────────────────────────────

function wrapEmail(briefingHtml, research) {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const nextRace = research.races?.[0]?.name ?? "upcoming race";
  const nextRaceType = research.races?.[0]?.type ?? "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:24px;color:#1a1a1a;background:#fafaf8}
  h1{font-size:22px;border-bottom:3px solid #e8281e;padding-bottom:8px;margin-bottom:4px}
  .date{color:#666;font-size:13px;margin-bottom:24px}
  h2{font-size:15px;color:#e8281e;margin-top:28px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em}
  ul{padding-left:20px;margin:8px 0}
  li{margin-bottom:6px;line-height:1.5}
  .footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;font-size:12px;color:#999}
  .reply-hint{background:#f0f4ff;border-left:3px solid #4466cc;padding:10px 14px;margin-top:24px;font-size:13px;border-radius:2px}
  .badge{display:inline-block;background:#e8281e;color:white;font-size:10px;padding:2px 6px;border-radius:3px;margin-left:6px;font-family:sans-serif}
</style></head><body>
  <h1>🚴 Wielermanager Daily Briefing <span class="badge">${nextRaceType}</span></h1>
  <div class="date">${today}</div>
  ${briefingHtml}
  <div class="reply-hint">
    💬 <strong>Did a transfer?</strong> Reply — e.g. <em>"Out: Alleno, Kudus — In: Aranburu, Hermans"</em> — and your squad updates automatically.
  </div>
  <div class="footer">Wielermanager Agent · squad last updated ${squad.lastUpdated} · transfers used: ${squad.transfersUsed}/3 free · next race: ${nextRace}</div>
</body></html>`;
}

// ─── Send email ───────────────────────────────────────────────────────────────

async function sendEmail(htmlContent) {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject: `🚴 Wielermanager Briefing — ${today}`,
    html: htmlContent,
    reply_to: process.env.INBOUND_EMAIL || TO_EMAIL,
  });
  console.log("Email sent:", result);
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log("Starting Wielermanager agent...");
    const today = new Date().toLocaleDateString("en-GB", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    const research = await runResearcher(today);
    console.log("Waiting 20s before writer...");
    await sleep(20000);
    const briefingHtml = await runWriter(today, research);
    const email = wrapEmail(briefingHtml, research);
    await sendEmail(email);
    console.log("Done ✓");
  } catch (err) {
    console.error("Agent failed:", err);
    process.exit(1);
  }
}

main();
