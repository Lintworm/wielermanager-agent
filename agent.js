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

const riderNames = squad.riders.map((r) => r.name).join(", ");

// Sleep helper to avoid rate limits between agent calls
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ─── Shared fetch helper ──────────────────────────────────────────────────────

async function callClaude({ system, user, tools = [], maxTokens = 2000 }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      tools,
      messages: [{ role: "user", content: user }],
    }),
  });

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

// ─── Agent 1: Researcher ──────────────────────────────────────────────────────

async function runResearcher(today) {
  console.log("Agent 1 (Researcher) starting...");

  const system = `You are a cycling research agent. Your job is to search the web and return verified, factual data about upcoming races and rider news. Be thorough — search multiple sources. Today is ${today}.

You must return a single valid JSON object and nothing else. No markdown, no explanation, no code fences. Just raw JSON.

The JSON must follow this exact structure:
{
  "races": [
    {
      "name": "race name",
      "date": "day month year",
      "type": "Monument|WorldTour|NonWorldTour"
    }
  ],
  "starters": {
    "race name": ["Rider Name", "Rider Name"]
  },
  "dns": {
    "race name": [
      { "name": "Rider Name", "reason": "injury/illness/etc" }
    ]
  },
  "news": [
    {
      "headline": "short factual headline",
      "detail": "one sentence detail",
      "source": "Sporza/WielerFlits/Cyclingnews/etc",
      "relevance": "why this matters for fantasy"
    }
  ]
}`;

  const user = `Search for:
1. All professional cycling races in the next 10 days — names and dates
2. Official startlists for any races in the next 3 days. Search "[race name] 2026 startlist" and "[race name] 2026 deelnemerslijst".
3. DNS/withdrawal news for these riders specifically: ${riderNames}. Search each key rider + "2026" + upcoming race name.
4. Latest cycling gossip, injuries, form news from Sporza, WielerFlits, Cyclingnews — last 48 hours only. Minimum 4 news items.

Return only the JSON object. No other text.`;

  const raw = await callClaude({
    system,
    user,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    maxTokens: 3000,
  });

  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const data = JSON.parse(clean);
    console.log(`Agent 1 done: ${data.races?.length ?? 0} races, ${data.news?.length ?? 0} news items`);
    return data;
  } catch (e) {
    console.error("Agent 1 JSON parse failed, raw output:", raw);
    throw new Error("Researcher agent returned invalid JSON");
  }
}

// ─── Agent 2: Writer ──────────────────────────────────────────────────────────

async function runWriter(today, research) {
  console.log("Agent 2 (Writer) starting...");

  // Strip allRiders from gamedata passed to writer — only send rules + calendar
  // (squad already has their riders; full 938-rider list would bloat context)
  const { allRiders, ...gamedataForWriter } = gamedata;

  const system = `You are a Sporza Wielermanager briefing writer. You have full knowledge of the game rules, scoring system, race calendar, and transfer mechanics.

## Official Game Rules & Scoring
${JSON.stringify(gamedataForWriter, null, 2)}

## Thomas's current squad
${JSON.stringify(squad, null, 2)}

## Writing rules
- CRITICAL: Only recommend riders confirmed as starting in the next race. If a rider is not in the verified startlist or is listed as DNS, bench them and flag with (DNS) or (startlist unknown — bench as precaution).
- Use the official scoring table to reason about kopman choices — pick whoever has the best chance of a top-6 finish in this specific race type (Monument vs WorldTour vs NonWorldTour).
- For transfer advice: Thomas has used ${squad.transfersUsed} transfers so far. The next transfer costs ${Math.max(0, squad.transfersUsed - 2)}M, the one after ${Math.max(0, squad.transfersUsed - 1)}M, etc. Always state the cost explicitly when recommending a transfer. Weigh the point gain against the budget hit and remaining races.
- Only include gossip items from the research data — never invent news.
- Use rider last names only (except to disambiguate).
- Be direct and punchy. No fluff.
- Format as clean HTML only. Use <h2> for section headers, <ul><li> for lists, <strong> for emphasis.
- Do not use markdown, asterisks, or # symbols anywhere.
- Return only the inner HTML body content — no <html>, <head>, or <body> tags.`;

  const user = `Today is ${today}.

Here is the verified research data from the researcher agent:
${JSON.stringify(research, null, 2)}

Write the daily Wielermanager briefing with these sections:
1. <h2>This Week's Races</h2> — races in next 7 days with dates and point category (Monument/WorldTour/NonWorldTour)
2. <h2>Recommended Lineup (12)</h2> — confirmed starters only, with brief reason per rider including point potential
3. <h2>Bench (8)</h2> — remaining riders, flag any DNS or startlist-unknown clearly
4. <h2>Kopman Pick</h2> — who, why, and what kopman bonus points are realistically on the table
5. <h2>Transfers</h2> — any action needed based on remaining calendar, or confirm to hold. If suggesting a transfer, include the price of the rider to bring in vs out.
6. <h2>News & Gossip</h2> — only items from the research data, with source attribution`;

  const html = await callClaude({
    system,
    user,
    tools: [],
    maxTokens: 3000,
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
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #1a1a1a; background: #fafaf8; }
  h1 { font-size: 22px; border-bottom: 3px solid #e8281e; padding-bottom: 8px; margin-bottom: 4px; }
  .date { color: #666; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 15px; color: #e8281e; margin-top: 28px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  ul { padding-left: 20px; margin: 8px 0; }
  li { margin-bottom: 6px; line-height: 1.5; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #999; }
  .reply-hint { background: #f0f4ff; border-left: 3px solid #4466cc; padding: 10px 14px; margin-top: 24px; font-size: 13px; border-radius: 2px; }
  .race-badge { display: inline-block; background: #e8281e; color: white; font-size: 10px; padding: 2px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle; font-family: sans-serif; }
</style>
</head>
<body>
  <h1>🚴 Wielermanager Daily Briefing <span class="race-badge">${nextRaceType}</span></h1>
  <div class="date">${today}</div>

  ${briefingHtml}

  <div class="reply-hint">
    💬 <strong>Did a transfer?</strong> Reply with what you did — e.g. <em>"Out: Alleno, Kudus — In: Aranburu, Hermans"</em> — and your squad updates automatically.
  </div>

  <div class="footer">
    Wielermanager Agent · squad last updated ${squad.lastUpdated} · next race: ${nextRace}
  </div>
</body>
</html>`;
}

// ─── Send email ───────────────────────────────────────────────────────────────

async function sendEmail(htmlContent) {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long",
  });

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
    console.log("Waiting 15s between agents to avoid rate limits...");
    await sleep(15000);
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
