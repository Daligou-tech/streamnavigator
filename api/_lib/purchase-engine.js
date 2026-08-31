// Purchase Navigator's dedicated analysis engine.
//
// Why this exists instead of routing 'buying' through the generic
// api/_lib/navigator-engine.js: this product now makes six specific,
// itemized promises to the customer (see buying.html's "What you get" list)
// and is charged for as a flat $19 fee up front. The generic engine's
// report shape is a free-form `sections[]` array the model curates itself —
// fine for products whose report content varies submission to submission,
// but not strong enough to *guarantee* every one of six named things is
// actually in the output. This engine forces each of the six into its own
// required, non-omittable schema field, then maps that into the same
// generic report shape (headline/summary/key_numbers/sections/
// missing_or_uncertain) that navigator-status.html already knows how to
// render — so no new renderer page was needed, but the content guarantee is
// real and checked in code (see isReportComplete), not just implied by a
// prompt.
//
// This also runs BEHIND buying.html's and api/navigator-intake.js's
// pre-payment sufficiency gate (see navigator-buying-rules.js) — by the
// time this ever runs, the customer has already supplied a price, a
// financing answer, an ownership horizon, a location, and the other fields
// each category requires. That's what makes it safe to promise "all six,
// every time" here: this file is not the place that decides whether there's
// enough to work with, it can assume there is.
//
// Uses Anthropic's server-side web_search tool (when available) to ground
// figures in something more current than the model's training knowledge —
// typical current prices for this size/category, typical current financing
// rates, etc. If the account/key doesn't have that tool enabled, or a
// search-augmented call fails for any reason, this falls back to a
// knowledge-only call rather than failing the whole report — the resulting
// report says plainly (via research_notes / assumptions) whether it was
// able to search or not, rather than silently presenting either as the
// other.

const { getSupabaseAdmin } = require('./supabaseAdmin');
const { fieldsForCategory, CATEGORIES } = require('../../navigator-buying-rules');

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const ENABLE_WEB_SEARCH = process.env.PURCHASE_NAVIGATOR_DISABLE_WEB_SEARCH !== 'true';

const HONESTY_RULES = `
You have access to a web_search tool — use it when it would let you ground the analysis in something more current or specific than your general knowledge (typical current prices for this size/category, typical current financing rates, typical resale patterns). Use your judgment about when a search is worth it; you don't need to search for everything, and a handful of searches is plenty. When you do search and use what you find, say so briefly in research_notes and reflect it in the relevant explanation. When you have not searched, or a search did not turn up anything useful, that's fine — rely on general knowledge instead — but never present a specific current price, rate, or figure as verified when it is really a directional estimate from training knowledge. Ground every specific claim in one of: (a) something you found via web_search in this conversation, (b) the customer's own submitted details, or (c) general knowledge you are genuinely confident is still directionally accurate. Never invent a specific current price, interest rate, or resale percentage presented as verified fact when you are not confident it is both real and current — a clearly-labeled directional estimate is always better than a confident-sounding fabrication.

Every field in submit_purchase_report must be plain natural-language prose (or the specific short-string/number format its description asks for) — nothing else. In particular: never write out tool-call, function-call, or parameter-tag syntax (anything shaped like <tag>, <parameter name="...">, <invoke ...>, or similar) inside any field's value, even as a way of showing your work or thinking through a calculation. If you want to show how a number was derived, just say it in words directly in that field's own "explanation" — e.g. "$38,000 purchase + roughly $6,200 in interest over 60 months = about $44,200" — never by simulating a nested call to another tool or to yourself.
`.trim();

const REPORT_TOOL = {
  name: 'submit_purchase_report',
  description: 'Submit the structured Purchase Navigator total-cost-of-ownership report. Every field is required — if something genuinely cannot be pinned down, say so explicitly inside that field rather than leaving it out. The customer already confirmed sufficient information before paying, so every one of the six sections below must contain real, substantive content — never a placeholder or an "insufficient information" deflection.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'The single most important takeaway as a short, specific, plain-English headline (a dollar figure and/or verdict) — not a generic restatement of the product name.' },
      headline_tag: { type: 'string', description: 'Optional short badge: "Buy", "Wait", "Reconsider", "Below market", "Overpriced". Omit if nothing fits well.' },
      summary: { type: 'string', description: 'A 2-4 sentence plain-English summary of the bottom line and why.' },
      research_notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'If you used web_search, 0-5 short notes on what you found and roughly what kind of source it came from (e.g. "current retail listings show similar 33-inch French door fridges from $1,800-$2,600"). Leave empty if you did not search, or found nothing useful — never fabricate having searched.',
      },
      total_cost_of_ownership: {
        type: 'object',
        description: 'Required. The true total cost over the ownership period the customer gave you, not just the purchase price.',
        properties: {
          estimate_low: { type: 'string', description: 'Low end of the total estimate over the ownership period, e.g. "$3,200".' },
          estimate_high: { type: 'string', description: 'High end of the estimate, e.g. "$4,100".' },
          time_horizon_years: { type: 'number' },
          explanation: { type: 'string', description: 'Required, non-empty. What is included (purchase price, financing cost, running costs, etc.) and how you arrived at these numbers.' },
        },
        required: ['explanation'],
      },
      financing_impact: {
        type: 'object',
        description: 'Required even when the customer is paying cash — say so explicitly rather than omitting this section.',
        properties: {
          applicable: { type: 'boolean', description: 'true if financing changes the cost picture (the customer is financing), false if paying cash.' },
          extra_cost_estimate: { type: 'string', description: 'Estimated total interest/financing cost over the term, when applicable.' },
          explanation: { type: 'string', description: 'Required, non-empty. If not financing, say plainly that the cash price is the cost (optionally note opportunity cost of tying up cash). If financing, explain the estimated extra cost and what drives it.' },
        },
        required: ['applicable', 'explanation'],
      },
      maintenance_running_costs: {
        type: 'object',
        description: 'Required. Expected maintenance and running costs over the ownership period.',
        properties: {
          annual_estimate: { type: 'string', description: 'e.g. "$150-$300/year".' },
          explanation: { type: 'string', description: 'Required, non-empty. What drives these costs for this specific item/category, and how confident you are.' },
        },
        required: ['explanation'],
      },
      depreciation_resale: {
        type: 'object',
        description: 'Required. If this category has essentially no resale market, say so explicitly — that is still a real answer, not a reason to omit the section.',
        properties: {
          expected_resale_note: { type: 'string', description: 'e.g. "roughly 40% of purchase price after 5 years" or "no meaningful resale market for this category".' },
          explanation: { type: 'string', description: 'Required, non-empty.' },
        },
        required: ['explanation'],
      },
      alternative_comparison: {
        type: 'object',
        description: 'Required. At least one realistic, specific alternative, compared directly against what the customer described.',
        properties: {
          alternative_name: { type: 'string', description: 'Required, non-empty. The specific alternative being compared — a different model, tier, or approach.' },
          explanation: { type: 'string', description: 'Required, non-empty. How it compares on price, total cost, and the customer\'s stated must-haves.' },
        },
        required: ['alternative_name', 'explanation'],
      },
      recommendation: {
        type: 'object',
        description: 'Required. The bottom-line call, grounded in the math above.',
        properties: {
          verdict: { type: 'string', enum: ['buy', 'wait', 'reconsider'] },
          reasoning: { type: 'string', description: 'Required, non-empty. Specific to this submission, not generic advice.' },
        },
        required: ['verdict', 'reasoning'],
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required. The specific assumptions you made (e.g. an assumed regional electricity rate, a typical repair cost for this category) so the customer can sanity-check them. Use an empty array only if there truly were none.',
      },
      missing_or_uncertain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required. Secondary caveats or things that would sharpen the numbers further if known. This is NOT a place to say the report as a whole is impossible — sufficiency was already confirmed before payment; use this only for genuine remaining uncertainty (e.g. a specific current price you could not verify).',
      },
    },
    required: [
      'headline', 'summary', 'total_cost_of_ownership', 'financing_impact',
      'maintenance_running_costs', 'depreciation_resale', 'alternative_comparison',
      'recommendation', 'assumptions', 'missing_or_uncertain',
    ],
  },
};

// Restored to 5 (from a temporary 3) now that this function runs on Vercel
// Pro with a 300s ceiling (see vercel.json) instead of Hobby's 60s — the
// earlier trim was a stopgap to fit real, live-verified generations inside
// 60s, which two live tests showed didn't reliably work anyway (see
// MAX_ATTEMPTS below). More search rounds means fresher pricing data for
// the alternative-comparison and depreciation/resale sections.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

function categoryLabel(category) {
  const found = CATEGORIES.filter((c) => c.value === category)[0];
  return found ? found.label : 'Item';
}

// Turns the customer's structured, pre-validated form fields into a
// readable brief for the model — using the same field labels
// navigator-buying-rules.js uses on the page itself, so the model is
// grounded in exactly what the customer was told they were providing.
function buildIntakeBrief(submission) {
  const formData = submission.form_data || {};
  const category = formData.category || 'other';
  const fields = fieldsForCategory(category);
  const lines = [`Purchase category: ${categoryLabel(category)}`];
  fields.forEach((field) => {
    const raw = formData[field.key];
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    lines.push(`${field.label}: ${raw}`);
  });
  return lines.join('\n');
}

function buildSystemPrompt(submission) {
  const brief = buildIntakeBrief(submission);
  return `You are the analysis engine behind Purchase Navigator, a StreamNavigator AI product. A customer paid $19 for a true total-cost-of-ownership analysis on something they're considering buying, and confirmed the details below before paying — treat this as sufficient to work with; do not respond by asking for more information or declaring the input insufficient.

Customer-provided details:
${brief}

Produce a genuinely useful, honest, specific analysis using these details as your foundation. Estimate financing cost impact if relevant, expected maintenance/running costs, and depreciation or resale-value expectations, using web search where it would sharpen a general-knowledge estimate into something more current and specific (typical current prices for this size/category/region, typical current financing rates) — and your own general knowledge of typical patterns for this category otherwise. Compare against at least one realistic, specific alternative that respects any must-have features the customer listed. Give a clear buy/wait/reconsider recommendation grounded in the math, accounting for the customer's stated timeline. Show your reasoning and assumptions plainly so the customer can sanity-check them.

${HONESTY_RULES}

Respond ONLY by calling the submit_purchase_report tool.`;
}

const TAG_LEAK_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9_-]*(\s[^>]*)?>/g;

// `hits`, when passed, collects rich diagnostics (which field, what tags,
// and enough surrounding text to see whether it was an isolated fragment
// or the field's entire content) — plain matched substrings alone (the
// original shape of this function) turned out not to be enough to
// distinguish those two cases without another live round-trip; see the
// 2026-08-31 incident notes on sanitizeReportTags below.
function reportLooksContaminated(value, hits, path) {
  const here = path || [];
  if (typeof value === 'string') {
    const matches = value.match(TAG_LEAK_PATTERN);
    if (matches && hits) {
      hits.push({
        field: here.join('.') || '(root)',
        tags: matches,
        context: value.length > 300 ? `${value.slice(0, 300)}…` : value,
      });
    }
    return !!matches;
  }
  if (Array.isArray(value)) return value.some((v, i) => reportLooksContaminated(v, hits, [...here, i]));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, v]) => reportLooksContaminated(v, hits, [...here, key]));
  }
  return false;
}

// Live production traffic on 2026-08-31 showed the model occasionally
// leaking a stray formatting-tag fragment (observed: literally the text
// `<parameter name="estimate_low">`, matching this report schema's own
// field name — apparently a self-referential artifact of the model
// narrating its own reasoning) into an otherwise-good string field, on 2
// separate real attempts for the same submission. Discarding the whole
// report over one stray tag fragment cost the customer another wait, and
// after MAX_ATTEMPTS, their money with nothing to show for it — so strip
// any HTML/XML-tag-like substrings from every string field first, rather
// than rejecting outright. This is safe here specifically because
// mapToGenericReport's output is rendered as plain text (see
// navigator-status.html), never as raw HTML, so there's no injection risk
// being traded away — only a defense against a customer seeing literal
// tag syntax in their report. If a field is left empty by the strip
// (meaning the tag WAS the entire content, not just a fragment attached to
// real prose), isReportComplete below still correctly catches that and
// this falls back to a retry as before.
function sanitizeReportTags(value) {
  if (typeof value === 'string') {
    return value.replace(TAG_LEAK_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim();
  }
  if (Array.isArray(value)) return value.map(sanitizeReportTags);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = sanitizeReportTags(v);
    return out;
  }
  return value;
}

function nonEmpty(str) {
  return typeof str === 'string' && str.trim().length > 0;
}

// Defense in depth: the tool schema's `required` arrays lean on the model
// to fill every field, but a model can technically satisfy a JSON Schema
// with an empty string. This is the actual guarantee that all six promised
// outputs made it into the report — checked in code, not just implied by a
// prompt — before a customer ever sees it.
function isReportComplete(report) {
  if (!report || typeof report !== 'object') return false;
  if (!nonEmpty(report.headline) || !nonEmpty(report.summary)) return false;

  const tco = report.total_cost_of_ownership;
  if (!tco || !nonEmpty(tco.explanation)) return false;

  const financing = report.financing_impact;
  if (!financing || typeof financing.applicable !== 'boolean' || !nonEmpty(financing.explanation)) return false;

  const maintenance = report.maintenance_running_costs;
  if (!maintenance || !nonEmpty(maintenance.explanation)) return false;

  const depreciation = report.depreciation_resale;
  if (!depreciation || !nonEmpty(depreciation.explanation)) return false;

  const alt = report.alternative_comparison;
  if (!alt || !nonEmpty(alt.alternative_name) || !nonEmpty(alt.explanation)) return false;

  const rec = report.recommendation;
  if (!rec || !['buy', 'wait', 'reconsider'].includes(rec.verdict) || !nonEmpty(rec.reasoning)) return false;

  if (!Array.isArray(report.assumptions) || !Array.isArray(report.missing_or_uncertain)) return false;

  return true;
}

// Diagnostic-only companion to isReportComplete: names the first missing
// field instead of just true/false, so an incomplete-report error message
// says WHICH of the six sections was empty rather than making that a
// mystery every time (this is exactly the gap that made the 2026-08-31
// leaked-tag incident take 3 live rounds to narrow down instead of 1).
function firstIncompleteField(report) {
  if (!report || typeof report !== 'object') return '(no report object)';
  if (!nonEmpty(report.headline)) return 'headline';
  if (!nonEmpty(report.summary)) return 'summary';
  if (!report.total_cost_of_ownership || !nonEmpty(report.total_cost_of_ownership.explanation)) return 'total_cost_of_ownership.explanation';
  if (!report.financing_impact || typeof report.financing_impact.applicable !== 'boolean' || !nonEmpty(report.financing_impact.explanation)) return 'financing_impact.explanation';
  if (!report.maintenance_running_costs || !nonEmpty(report.maintenance_running_costs.explanation)) return 'maintenance_running_costs.explanation';
  if (!report.depreciation_resale || !nonEmpty(report.depreciation_resale.explanation)) return 'depreciation_resale.explanation';
  if (!report.alternative_comparison || !nonEmpty(report.alternative_comparison.alternative_name) || !nonEmpty(report.alternative_comparison.explanation)) return 'alternative_comparison';
  if (!report.recommendation || !['buy', 'wait', 'reconsider'].includes(report.recommendation.verdict) || !nonEmpty(report.recommendation.reasoning)) return 'recommendation';
  if (!Array.isArray(report.assumptions) || !Array.isArray(report.missing_or_uncertain)) return 'assumptions/missing_or_uncertain';
  return '(unknown — isReportComplete said false but firstIncompleteField found nothing; these two have drifted apart)';
}

// Maps the bespoke, guaranteed-complete schema above into the generic
// {headline, summary, key_numbers, sections, missing_or_uncertain} shape
// navigator-status.html already renders — fixed section titles, in a fixed
// order, one per promised output, always populated because isReportComplete
// already verified every source field is non-empty before this ever runs.
function mapToGenericReport(report) {
  const keyNumbers = [];
  const tco = report.total_cost_of_ownership || {};
  if (tco.estimate_low || tco.estimate_high) {
    keyNumbers.push({
      label: `Total cost of ownership${tco.time_horizon_years ? ` (${tco.time_horizon_years}yr)` : ''}`,
      value: [tco.estimate_low, tco.estimate_high].filter(Boolean).join(' – ') || '—',
    });
  }
  if (report.financing_impact && report.financing_impact.applicable && report.financing_impact.extra_cost_estimate) {
    keyNumbers.push({ label: 'Estimated financing cost', value: report.financing_impact.extra_cost_estimate });
  }
  if (report.maintenance_running_costs && report.maintenance_running_costs.annual_estimate) {
    keyNumbers.push({ label: 'Est. annual maintenance/running cost', value: report.maintenance_running_costs.annual_estimate });
  }
  if (report.recommendation && report.recommendation.verdict) {
    keyNumbers.push({ label: 'Recommendation', value: report.recommendation.verdict.toUpperCase() });
  }

  const sections = [
    {
      icon: '💰',
      title: 'True total cost of ownership',
      items: [tco.explanation].filter(Boolean),
    },
    {
      icon: '🏦',
      title: 'Financing cost impact',
      items: [report.financing_impact && report.financing_impact.explanation].filter(Boolean),
    },
    {
      icon: '🔧',
      title: 'Maintenance & running costs',
      items: [report.maintenance_running_costs && report.maintenance_running_costs.explanation].filter(Boolean),
    },
    {
      icon: '📉',
      title: 'Depreciation & resale value',
      items: [
        report.depreciation_resale && report.depreciation_resale.expected_resale_note,
        report.depreciation_resale && report.depreciation_resale.explanation,
      ].filter(Boolean),
    },
    {
      icon: '🔍',
      title: `How it compares: ${(report.alternative_comparison && report.alternative_comparison.alternative_name) || 'a realistic alternative'}`,
      items: [report.alternative_comparison && report.alternative_comparison.explanation].filter(Boolean),
    },
    {
      icon: '✅',
      title: `Recommendation: ${report.recommendation ? report.recommendation.verdict.toUpperCase() : ''}`,
      items: [report.recommendation && report.recommendation.reasoning].filter(Boolean),
    },
  ];

  if (Array.isArray(report.assumptions) && report.assumptions.length) {
    sections.push({ icon: '📐', title: 'Assumptions used in this analysis', items: report.assumptions });
  }
  if (Array.isArray(report.research_notes) && report.research_notes.length) {
    sections.push({ icon: '🌐', title: 'What live research turned up', items: report.research_notes });
  }

  return {
    headline: report.headline,
    headline_tag: report.headline_tag || (report.recommendation ? report.recommendation.verdict : undefined),
    summary: report.summary,
    key_numbers: keyNumbers,
    sections,
    missing_or_uncertain: Array.isArray(report.missing_or_uncertain) ? report.missing_or_uncertain : [],
  };
}

async function callAnthropic({ apiKey, system, tools, toolChoice, messages, maxTokens, thinkingBudget }) {
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens || 4096,
    system,
    tools,
    tool_choice: toolChoice,
    messages,
  };
  // Extended thinking gives the model a dedicated scratch space for
  // multi-step arithmetic (e.g. total-cost-of-ownership, financing-interest
  // math) — worked theory for the 2026-08-31 incident where the model
  // reproducibly (7/7 live attempts) tried to "show its work" for exactly
  // this kind of calculation by emitting a stray simulated tool-call
  // fragment INTO the final answer's explanation field instead of just
  // stating the result. Giving it a real place to work through the
  // arithmetic first, separate from the graded output, is a more direct fix
  // than asking it not to via the system prompt (which did not stop the
  // leak — see the 0005 patch notes). Only valid with tool_choice:'auto'
  // (Anthropic disallows combining it with a forced tool_choice), so this
  // is only passed on the first, non-forced call.
   if (thinkingBudget) 
   { body.thinking = { type: 'adaptive' }; body.output_config = { effort: 'high' }; 
   }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 500)}`);
    err.status = response.status;
    err.body = errText;
    throw err;
  }
  return response.json();
}

function looksLikeUnsupportedToolError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('web_search') || msg.includes('tool') && msg.includes('not') && (msg.includes('support') || msg.includes('enabled') || msg.includes('available'));
}

// One full attempt at getting a report out of the model: an initial call
// that may use web_search, and — only if the model didn't call our submit
// tool on that first turn (e.g. it searched and then just summarized in
// text) — exactly one forced follow-up call so this always terminates in a
// bounded number of requests. Falls back to a no-search call if the
// search-augmented call fails in a way that looks like the tool isn't
// available on this API key, rather than failing the whole report over a
// feature that may simply not be enabled — the resulting report's
// research_notes/assumptions will honestly reflect that no search happened.
async function runOneAttempt({ apiKey, systemPrompt, contentBlocks, allowSearch }) {
  const baseMessages = [{ role: 'user', content: contentBlocks }];
  const tools = allowSearch ? [WEB_SEARCH_TOOL, REPORT_TOOL] : [REPORT_TOOL];

  let data;
  try {
    data = await callAnthropic({
      apiKey,
      system: systemPrompt,
      tools,
      toolChoice: { type: 'auto' },
      messages: baseMessages,
      // max_tokens must exceed thinkingBudget (thinking + final output share
      // this budget) — 4000 for thinking, comfortable headroom left for the
      // actual tool-call JSON on top.
      maxTokens: 12000,
      thinkingBudget: 4000,
    });
  } catch (err) {
    if (allowSearch && looksLikeUnsupportedToolError(err)) {
      return runOneAttempt({ apiKey, systemPrompt, contentBlocks, allowSearch: false });
    }
    throw err;
  }

  const content = data.content || [];
  let toolUse = content.find((b) => b.type === 'tool_use' && b.name === 'submit_purchase_report');
  if (toolUse) return toolUse.input;

  // Model didn't call the submit tool on the first turn — force it on a
  // bounded follow-up instead of looping indefinitely. The follow-up call
  // doesn't itself enable extended thinking (forced tool_choice and
  // thinking can't be combined — see callAnthropic), so strip any
  // thinking/redacted_thinking blocks from the replayed turn rather than
  // risk the API rejecting a thinking block in a request where thinking
  // isn't enabled; the model's own text summary in `content` already
  // carries what the follow-up needs.
  const replayContent = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
  const followMessages = baseMessages.concat([
    { role: 'assistant', content: replayContent },
    { role: 'user', content: 'Now call submit_purchase_report with your complete findings, using anything useful you found above.' },
  ]);
  const followData = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [REPORT_TOOL],
    toolChoice: { type: 'tool', name: 'submit_purchase_report' },
    messages: followMessages,
    maxTokens: 8000,
  });
  toolUse = (followData.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_purchase_report');
  if (!toolUse) throw new Error('Model did not return a structured report after a forced follow-up');
  return toolUse.input;
}

// Raised from 2 to 4 on 2026-08-31: live testing after the Vercel Pro
// upgrade showed the timeout problem was fully solved, but a *separate*,
// still-unresolved issue (the model occasionally leaking a stray tool-call
// fragment into a required field — see sanitizeReportTags and
// reportLooksContaminated above) reproduced on 4 consecutive real attempts
// across 2 different submissions, exhausting MAX_ATTEMPTS=2 every time
// despite a prompt-level mitigation already being in place. Since each
// attempt now comfortably fits inside the 300s budget (see below), more
// attempts costs only a little extra API spend on the rare submissions that
// hit this, in exchange for a real chance at recovering automatically
// instead of failing a customer's report outright while the root cause is
// still being narrowed down.
const MAX_ATTEMPTS = 4;
// Originally written for the Vercel Hobby plan's 60s hard cap on a
// serverless function invocation, which real live-money traffic showed was
// too tight for this report (web_search rounds plus a forced follow-up call
// routinely ran past it) — when the platform kills a function mid-flight it
// does so OUTSIDE this file's try/catch, so the row got stuck at
// status:'processing' forever with no failure message and no way to retry.
// As of 2026-08-31 this project is on Vercel Pro, and vercel.json's
// maxDuration for this function's caller (get-navigator-submission.js) is
// 300s — five times the old ceiling — so a single attempt should have ample
// room to complete normally now. The single-attempt-per-invocation
// architecture and the stuck-processing self-heal below are kept anyway as
// a safety net: they cost nothing when generation succeeds well within
// budget, and they mean a genuinely slow or hung attempt (network issue,
// provider outage, etc.) still resolves to a clean 'failed' instead of
// silently stranding the row, whatever the current plan's ceiling is.
//
// This function makes exactly ONE attempt per call, tracked via
// generation_attempts on the row. A recoverable failure (contamination,
// incomplete, or a normal API error) sets status back to 'paid' so the
// existing 3-second client poll naturally re-invokes this function for the
// next attempt — each with its own fresh budget — instead of stacking
// attempts inside a single request. get-navigator-submission.js also treats
// a submission stuck at 'processing' for longer than the function's own
// maxDuration (i.e. one that got hard-killed by the platform mid-attempt)
// as eligible for the next attempt, so a raw timeout no longer strands the
// row permanently. Only after MAX_ATTEMPTS is truly exhausted does this
// mark the submission 'failed' with a real message, which is what triggers
// the existing regenerate/refund copy on navigator-status.html.
async function generatePurchaseReport(submissionId) {
  const admin = getSupabaseAdmin();

  const { data: submission, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('*')
    .eq('id', submissionId)
    .single();

  if (fetchError || !submission) throw new Error('Submission not found');
  if (submission.product !== 'buying') throw new Error('Not a Purchase Navigator submission');

  // Guards the case where a previous attempt was itself killed by the
  // platform's 60s limit mid-flight (rather than failing inside this file's
  // own try/catch) — without this, a submission that times out on every
  // attempt could get re-triggered indefinitely by the stuck-processing
  // check in get-navigator-submission.js. Once attempts are exhausted this
  // marks the row 'failed' immediately instead of starting another attempt.
  if ((submission.generation_attempts || 0) >= MAX_ATTEMPTS) {
    const admin2 = admin;
    await admin2
      .from('navigator_submissions')
      .update({
        status: 'failed',
        error: `Report generation did not complete within ${MAX_ATTEMPTS} attempts (each attempt is time-limited to fit this deployment's serverless timeout).`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', submissionId);
    throw new Error('Exhausted generation attempts');
  }

  const attemptNumber = (submission.generation_attempts || 0) + 1;

  await admin
    .from('navigator_submissions')
    .update({ status: 'processing', generation_attempts: attemptNumber, updated_at: new Date().toISOString() })
    .eq('id', submissionId);

  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY env var');

    const systemPrompt = buildSystemPrompt(submission);

    const filePaths = submission.file_paths || [];
    const contentBlocks = [];
    for (const path of filePaths) {
      const { data: fileBlob, error: downloadError } = await admin.storage
        .from('navigator-uploads')
        .download(path);
      if (downloadError || !fileBlob) continue;
      const arrayBuffer = await fileBlob.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const ext = String(path).toLowerCase().split('.').pop();
      const mediaType = ext === 'pdf' ? 'application/pdf' : (ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg'));
      if (mediaType === 'application/pdf') {
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } });
      } else {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
      }
    }
    contentBlocks.push({ type: 'text', text: 'Analyze the purchase described in the system prompt and produce the report.' });

    let candidate;
    let recoverableError = null;
    try {
      candidate = await runOneAttempt({
        apiKey: ANTHROPIC_API_KEY,
        systemPrompt,
        contentBlocks,
        allowSearch: ENABLE_WEB_SEARCH,
      });
    } catch (err) {
      recoverableError = err;
    }

    if (candidate && !recoverableError) {
      const preSanitizeHits = [];
      const wasContaminated = reportLooksContaminated(candidate, preSanitizeHits);
      if (wasContaminated) {
        candidate = sanitizeReportTags(candidate);
        // Full field + context detail goes to the function log (Vercel
        // retains this) rather than the DB error column, which stays short
        // for the customer-facing status endpoint. Grep Vercel's logs for
        // this submission id if the leak recurs and needs deeper diagnosis.
        console.warn(
          `[purchase-engine] Stripped leaked formatting artifact(s) from submission ${submissionId} on attempt ${attemptNumber}:`,
          JSON.stringify(preSanitizeHits.slice(0, 5))
        );
      }
      // Re-check after stripping: a genuinely unusual/unhandled artifact
      // that the strip didn't fully clean (defensive — shouldn't happen
      // given the same pattern drives both) still gets caught here rather
      // than shipped to the customer.
      const postSanitizeHits = [];
      if (reportLooksContaminated(candidate, postSanitizeHits)) {
        recoverableError = new Error(`Model output contained malformed/leaked formatting artifacts that survived sanitization in field(s): ${postSanitizeHits.map((h) => h.field).join(', ')}`);
      } else if (!isReportComplete(candidate)) {
        const emptyField = firstIncompleteField(candidate);
        recoverableError = new Error(
          wasContaminated
            ? `Missing required field "${emptyField}" — was emptied by stripping a leaked formatting artifact that was its entire content`
            : `Missing required field "${emptyField}"`
        );
      }
    }

    if (recoverableError) {
      if (attemptNumber < MAX_ATTEMPTS) {
        // Not out of attempts yet — hand back to 'paid' so the next client
        // poll (a few seconds away) triggers a fresh attempt with its own
        // full time budget, rather than retrying inside this same request.
        await admin
          .from('navigator_submissions')
          .update({ status: 'paid', error: String(recoverableError.message || recoverableError).slice(0, 500), updated_at: new Date().toISOString() })
          .eq('id', submissionId);
        return null;
      }
      throw recoverableError;
    }

    const report = candidate;
    const genericReport = mapToGenericReport(report);

    await admin.from('navigator_reports').insert({
      submission_id: submissionId,
      product: 'buying',
      report_json: genericReport,
      model: ANTHROPIC_MODEL,
    });

    await admin
      .from('navigator_submissions')
      .update({ status: 'complete', error: null, updated_at: new Date().toISOString() })
      .eq('id', submissionId);

    return genericReport;
  } catch (err) {
    await admin
      .from('navigator_submissions')
      .update({ status: 'failed', error: String(err.message || err).slice(0, 500), updated_at: new Date().toISOString() })
      .eq('id', submissionId);
    throw err;
  }
}

module.exports = {
  generatePurchaseReport,
  // Exported for unit testing without hitting the network or Supabase.
  __internal: {
    buildSystemPrompt,
    buildIntakeBrief,
    isReportComplete,
    firstIncompleteField,
    mapToGenericReport,
    reportLooksContaminated,
    sanitizeReportTags,
    runOneAttempt,
    REPORT_TOOL,
    WEB_SEARCH_TOOL,
    MAX_ATTEMPTS,
  },
};
