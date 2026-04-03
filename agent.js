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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Today's date for calendar cross-referencing
const todayISO = new Date().toISOString().split("T")[0]; // e.g. "2026-04-03"
const todayDisplay = new Date().toLocaleDateString("en-GB", {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
});

// Core squad riders (no fillers) for researcher
const coreRiders = squad.riders
  .filter((r) => r.role === "core")
  .map((r) => r.name)
  .join(", ");

// Upcoming races only (from gamedata calendar, future dates)
const upcomingRaces = gamedata.raceCalendar.filter((r) => {
  // Parse "5-apr" style dates into comparable format
  const months = { jan:0,feb:1,mrt:2,apr:3,mei:4,jun:5,jul:6,aug:7,sep:8,okt:9,nov:10,dec:11 };
  const [day, mon] = r.date.split("-");
  const raceDate = new Date(2026, months[mon], parseInt(day));
  return raceDate >= new Date(todayISO);
});

// Next transfer cost
const nextTransferCost = Math.max(0, squad.transfersUsed - 2);

// Compact rider price list (for Tactician's transfer suggestions)
const riderPriceList = gamedata.allRiders
  .filter((r) => r.price >= 3)
  .map((r) => `${r.name} (${r.price}M, ${r.team})`)
  .join("; ");

// ─── Shared API call with retry ───────────────────────────────────────────────

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
      const wait = attempt * 30000;
      console.log(`Rate limited (attempt ${attempt}). Waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${err}`);
    }

    const data = await response.json();
    return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  throw new Error("Failed after 3 retries due to rate limiting");
}

function extractJSON(raw) {
  let clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in response");
  return JSON.parse(clean.slice(start, end + 1).trim());
}

// ─── AGENT 1: Researcher (Haiku) ─────────────────────────────────────────────
// Pure facts. Calendar-aware. Men's only. Current season only.

async function runResearcher() {
  console.log("Agent 1 (Researcher) starting...");

  const upcomingRaceNames = upcomingRaces.slice(0, 5).map((r) => `${r.name} (${r.date})`).join(", ");

  const system = `You are a cycling research agent. Today is ${todayISO} (${todayDisplay}).

CRITICAL RULES:
- Only return facts about MEN'S professional cycling
- Only return startlist/confirmation facts about UPCOMING races (after today ${todayISO})
- Never include injury or DNS info from previous seasons — current 2026 season only
- If you are not certain a fact is from 2026, do not include it
- Return ONLY a raw JSON object, no markdown, no explanation

Required JSON structure:
{
  "today": "${todayISO}",
  "upcomingRaces": [
    { "name": "...", "date": "YYYY-MM-DD", "type": "Monument|WorldTour|NietWorldTour", "daysAway": 0 }
  ],
  "startlists": {
    "Race Name": {
      "confirmed": ["Rider Name"],
      "withdrawn": [{ "name": "Rider Name", "reason": "..." }],
      "source": "url or site name",
      "confidence": "official|reported|rumoured"
    }
  },
  "riderNews": [
    { "rider": "Name", "news": "...", "type": "injury|form|dns|return", "source": "...", "season": "2026" }
  ],
  "generalNews": [
    { "headline": "...", "detail": "...", "source": "...", "relevance": "..." }
  ]
}`;

  const user = `Today is ${todayISO}. Upcoming races to research: ${upcomingRaceNames}

Search for:
1. Startlists for the next 2 upcoming men's races: search "[race name] 2026 startlist" and "[race name] 2026 deelnemerslijst". Only include riders confirmed AFTER today.
2. Current 2026 season news for these riders: ${coreRiders}. Search "[rider] 2026 [next race name]". Ignore anything from 2025 or earlier.
3. Men's cycling news from last 48h: search "cycling news today 2026" on Sporza and WielerFlits. Minimum 3 items. No women's races.

Return only the JSON object.`;

  const raw = await callClaude({
    system,
    user,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    maxTokens: 2000,
    model: "claude-haiku-4-5-20251001",
  });

  const data = extractJSON(raw);
  console.log(`Agent 1 done: ${data.upcomingRaces?.length ?? 0} upcoming races, ${data.generalNews?.length ?? 0} news items`);
  return data;
}

// ─── AGENT 2: Tactician (Sonnet) ─────────────────────────────────────────────
// Pure decisions. No prose. Outputs structured tactical JSON.

async function runTactician(research) {
  console.log("Agent 2 (Tactician) starting...");

  const squadNames = squad.riders.map((r) => r.name);

  const system = `You are a Sporza Wielermanager tactical analyst. You make optimal decisions based on verified data.

## Scoring system
- Monument: 1st=125, 2nd=100, 3rd=80, 4th=70, 5th=60, 6th=55, 7th=50, 8th=45, 9th=40, 10th=37
- WorldTour: 1st=100, 2nd=80, 3rd=65, 4th=55, 5th=48, 6th=44, 7th=40, 8th=36, 9th=32, 10th=30
- NietWorldTour: 1st=80, 2nd=64, 3rd=52, 4th=44, 5th=38, 6th=35, 7th=32, 8th=29, 9th=26, 10th=24
- Kopman bonus (on top): 1st=+30, 2nd=+25, 3rd=+20, 4th=+15, 5th=+10, 6th=+5
- Teammate of winner: +10 pts regardless of finishing position
- Points scored only by the 12 fielded riders (not bench)

## Race calendar (upcoming only)
${JSON.stringify(upcomingRaces, null, 2)}

## Thomas's squad
${JSON.stringify(squad, null, 2)}

## Transfer state
- Transfers used: ${squad.transfersUsed} (3 free total)
- Next transfer cost: ${nextTransferCost}M, then ${nextTransferCost + 1}M, etc.
- Budget remaining: ${squad.budget}M

## Available riders for transfer (price ≥ 3M, not in squad)
${riderPriceList}

## Decision rules
- Only field riders confirmed in the startlist. Unconfirmed = bench, flagged.
- Kopman must be a realistic top-6 finisher in this specific race. Never waste kopman on a bench rider.
- For transfer advice: weigh cost (in budget millions) vs. point gain over remaining races. Discourage burning transfers for single races.
- Riders to watch: find non-squad riders with high point potential in upcoming races.
- Phase awareness: cobbled phase ends after Parijs-Roubaix (12 apr). Ardennes phase starts 15 apr.

You must return ONLY a raw JSON object. No markdown. No explanation.

Required structure:
{
  "nextRace": { "name": "...", "date": "...", "type": "..." },
  "lineup": [
    { "name": "...", "reason": "...", "expectedPoints": "range e.g. 30-80" }
  ],
  "bench": [
    { "name": "...", "reason": "...", "flag": "DNS|unconfirmed|filler|low-value" }
  ],
  "kopman": { "name": "...", "reason": "...", "maxBonusPossible": 0 },
  "transfers": {
    "recommendation": "hold|act",
    "action": "...",
    "cost": "...",
    "reasoning": "..."
  },
  "ridersToWatch": [
    { "name": "...", "price": 0, "team": "...", "reason": "..." }
  ],
  "seasonOutlook": "one sentence on phase transition or long-term strategy"
}`;

  const user = `Here is today's verified research data:
${JSON.stringify(research, null, 2)}

Make optimal tactical decisions for Thomas's Wielermanager team. Remember:
- Only field riders who appear in research.startlists[nextRace].confirmed
- If startlist confidence is "rumoured", flag the rider as unconfirmed on bench
- Kopman must realistically finish top 6 in a ${research.upcomingRaces?.[0]?.type ?? "race"} race
- Riders to watch should NOT be in Thomas's squad (${squadNames.join(", ")})

Return only the JSON object.`;

  const raw = await callClaude({
    system,
    user,
    tools: [],
    maxTokens: 2000,
    model: "claude-sonnet-4-20250514",
  });

  const data = extractJSON(raw);
  console.log(`Agent 2 done: lineup=${data.lineup?.length ?? 0}, kopman=${data.kopman?.name ?? "?"}, transfer=${data.transfers?.recommendation ?? "?"}`);
  return data;
}

// ─── AGENT 3: Writer (Sonnet) ─────────────────────────────────────────────────
// Pure writing. Receives research + tactics. Produces HTML. No decisions.

async function runWriter(research, tactics) {
  console.log("Agent 3 (Writer) starting...");

  const system = `You are a sharp cycling newsletter writer. You receive pre-made tactical decisions and verified news, and write a clean daily email briefing. You do NOT make decisions — you only present them clearly.

Style: direct, punchy, last names only (except to disambiguate). No fluff.
Format: clean HTML only. Use <h2> for sections, <ul><li> for lists, <strong> for key info.
No markdown, no asterisks, no # symbols. Return inner HTML body content only.`;

  const user = `Today is ${todayDisplay}.

TACTICAL DECISIONS (pre-made, just present these clearly):
${JSON.stringify(tactics, null, 2)}

VERIFIED NEWS (men's cycling only, current season):
${JSON.stringify({ riderNews: research.riderNews, generalNews: research.generalNews }, null, 2)}

Write the briefing with exactly these sections:
1. <h2>This Week's Races</h2> — upcoming races with dates and point category
2. <h2>Recommended Lineup (12)</h2> — from tactics.lineup, with expected points
3. <h2>Bench (8)</h2> — from tactics.bench, clearly flag any DNS/unconfirmed
4. <h2>Kopman Pick</h2> — from tactics.kopman, state max kopman bonus possible
5. <h2>Transfers</h2> — from tactics.transfers, state cost explicitly
6. <h2>Riders to Watch</h2> — from tactics.ridersToWatch, include price and team
7. <h2>Season Outlook</h2> — one line from tactics.seasonOutlook
8. <h2>News & Gossip</h2> — from verified news only, with source, men's races only`;

  const html = await callClaude({
    system,
    user,
    tools: [],
    maxTokens: 2000,
    model: "claude-sonnet-4-20250514",
  });

  console.log("Agent 3 done.");
  return html;
}

// ─── Email wrapper ────────────────────────────────────────────────────────────

function wrapEmail(briefingHtml, tactics) {
  const nextRace = tactics.nextRace?.name ?? "upcoming race";
  const nextRaceType = tactics.nextRace?.type ?? "";

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
  <div class="date">${todayDisplay}</div>
  ${briefingHtml}
  <div class="reply-hint">
    💬 <strong>Did a transfer?</strong> Reply — e.g. <em>"Out: Alleno, Kudus — In: Aranburu, Hermans"</em> — and your squad updates automatically.
  </div>
  <div class="footer">
    Wielermanager Agent · squad updated ${squad.lastUpdated} · transfers used: ${squad.transfersUsed}/3 free · next transfer costs ${nextTransferCost}M · next race: ${nextRace}
  </div>
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
    console.log(`Starting Wielermanager agent — ${todayDisplay}`);

    // Agent 1: Research
    const research = await runResearcher();

    console.log("Waiting 20s before Tactician...");
    await sleep(20000);

    // Agent 2: Tactical decisions
    const tactics = await runTactician(research);

    console.log("Waiting 20s before Writer...");
    await sleep(20000);

    // Agent 3: Write email
    const briefingHtml = await runWriter(research, tactics);

    // Wrap and send
    const email = wrapEmail(briefingHtml, tactics);
    await sendEmail(email);

    console.log("Done ✓");
  } catch (err) {
    console.error("Agent failed:", err);
    process.exit(1);
  }
}

main();
