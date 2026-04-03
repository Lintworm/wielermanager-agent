import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const squad = JSON.parse(fs.readFileSync(path.join(__dirname, "squad.json"), "utf8"));

const resend = new Resend(process.env.RESEND_API_KEY);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL; // e.g. briefing@yourdomain.com

// ─── 1. Call Claude with web search ──────────────────────────────────────────

async function runAgent() {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const systemPrompt = `You are a Sporza Wielermanager assistant. Sporza Wielermanager is a Belgian fantasy cycling game for the 2026 spring classics season. You send Thomas a daily briefing email in English.

## Game mechanics
- Thomas has a squad of 19 riders. Each race day he picks 12 to score points; the other 8 are on the bench ("bus").
- One rider is designated kopman (captain) and scores double points.
- Transfers happen in windows — burning transfers mid-cobbled-season for marginal gains is bad strategy.
- The season has two phases: cobbled classics (now) → Ardennes. Squad should be optimized per phase.
- Filler riders (cheap riders used to balance transfer budgets) are valid but should be released at the next window.

## Thomas's current squad
${JSON.stringify(squad, null, 2)}

## Your job
Write a daily briefing with these sections:
1. **Today's races / This week's races** — what's happening in the next 7-14 days, with dates -> limited to races that matter in wielermanager
2. **Recommended lineup (12 riders)** — who to play, with brief reasoning per rider
3. **Bench (8 riders)** — who to bus and why
4. **Kopman pick** — who and why
5. **Transfer advice** — any action needed, or confirm to hold
6. **Watchlist - who to monitor during upcoming races that is for now not yet in Thomas' team.
7. **Gossip & news** — 3-5 bullet points of relevant cycling news that can impact wielermanager performance (injuries, form, DNS rumors, team drama). Use web search to find the latest.

Be direct and punchy. No fluff. Use rider last names only (except to disambiguate). Flag DNS risks clearly. Format as clean HTML for an email.`;

  const userMessage = `Today is ${today}. Fetch the latest cycling news and race schedule, then write the daily Wielermanager briefing for Thomas.`;

  console.log("Calling Claude with web search...");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: systemPrompt,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${err}`);
  }

  const data = await response.json();

  // Extract the final text response (Claude may do multiple web searches first)
  const textBlocks = data.content.filter((b) => b.type === "text");
  const briefingHtml = textBlocks.map((b) => b.text).join("\n");

  return briefingHtml;
}

// ─── 2. Wrap in email template ────────────────────────────────────────────────

function wrapEmail(briefingHtml) {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #1a1a1a; background: #fafaf8; }
  h1 { font-size: 22px; border-bottom: 3px solid #e8281e; padding-bottom: 8px; margin-bottom: 4px; }
  .date { color: #666; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 16px; color: #e8281e; margin-top: 28px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; line-height: 1.5; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; color: #999; }
  .reply-hint { background: #f0f4ff; border-left: 3px solid #4466cc; padding: 10px 14px; margin-top: 24px; font-size: 13px; border-radius: 2px; }
</style>
</head>
<body>
  <h1>🚴 Wielermanager Daily Briefing</h1>
  <div class="date">${today}</div>

  ${briefingHtml}

  <div class="reply-hint">
    💬 <strong>Did a transfer?</strong> Reply to this email and describe what you did — e.g. <em>"Transferred out Alleno and Kudus, transferred in Aranburu and Hermans"</em> — and your squad will be updated automatically.
  </div>

  <div class="footer">
    Wielermanager Agent · squad last updated ${squad.lastUpdated}
  </div>
</body>
</html>`;
}

// ─── 3. Send via Resend ───────────────────────────────────────────────────────

async function sendEmail(htmlContent) {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long",
  });

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject: `🚴 Wielermanager Briefing — ${today}`,
    html: htmlContent,
    // reply_to is set so replies go to your inbound webhook email
    reply_to: process.env.INBOUND_EMAIL || TO_EMAIL,
  });

  console.log("Email sent:", result);
  return result;
}

// ─── 4. Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log("Starting Wielermanager agent...");
    const briefing = await runAgent();
    const html = wrapEmail(briefing);
    await sendEmail(html);
    console.log("Done ✓");
  } catch (err) {
    console.error("Agent failed:", err);
    process.exit(1);
  }
}

main();
