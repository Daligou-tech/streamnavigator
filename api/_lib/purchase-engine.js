// Purchase Navigator's dedicated analysis engine.
//
// Why this exists instead of routing 'buying' through the generic
// api/_lib/navigator-engine.js: this product now makes six specific,
// itemized promises to the customer (see buying.html's "What you get" list)
// and is charged for as a flat $39 fee up front. The generic engine's
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
const { sendFailureAlert } = require('./alerts');
const { fieldsForCategory, CATEGORIES } = require('../../navigator-buying-rules');

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const ENABLE_WEB_SEARCH = process.env.PURCHASE_NAVIGATOR_DISABLE_WEB_SEARCH !== 'true';

const WEB_SEARCH_HONESTY_RULE = `
You have access to a web_search tool, and the customer has been told in writing that this analysis uses live web research. Search before you write. At minimum, search for what this item currently sells for and — when the customer is financing — what rates are currently typical for this kind of borrowing; search for current running costs (fuel or energy prices, insurance, typical repair costs) wherever a figure would otherwise be a guess. A handful of searches is plenty, but zero is not acceptable when the tool is available to you. When you do search and use what you find, say so briefly in research_notes and reflect it in the relevant explanation. When you have not searched, or a search did not turn up anything useful, that's fine — rely on general knowledge instead — but never present a specific current price, rate, or figure as verified when it is really a directional estimate from training knowledge. Ground every specific claim in one of: (a) something you found via web_search in this conversation, (b) the customer's own submitted details, or (c) general knowledge you are genuinely confident is still directionally accurate. Never invent a specific current price, interest rate, or resale percentage presented as verified fact when you are not confident it is both real and current — a clearly-labeled directional estimate is always better than a confident-sounding fabrication.
`.trim();

// Parameterized by tool name so this can be reused, correctly, for both
// the main submit_purchase_report call and the smaller submit_field_repair
// follow-up (see buildRepairSystemPrompt) — a hardcoded tool name here was
// itself a bug found via a failing test while fixing the 2026-08-31
// incident: this text used to name submit_purchase_report unconditionally,
// which is factually wrong (and potentially confusing to the model in the
// same way that caused the original leak) when reused verbatim for a
// request that's actually forcing a different tool.
function noLeakRule(toolName) {
  return `Every field in ${toolName} must be plain natural-language prose (or the specific short-string/number format its description asks for) — nothing else. Do not put markup or structured call syntax of any kind inside a field value, even as a way of showing your work. If you want to show how a number was derived, say it in words in that field own explanation — for example "$38,000 purchase plus roughly $6,200 in interest over 60 months is about $44,200".`;
}

// Kept for the main call, which gets both rules.
const HONESTY_RULES = `${WEB_SEARCH_HONESTY_RULE}

${noLeakRule('submit_purchase_report')}`;

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
        description: 'Required. The true total cost over the ownership period the customer gave you, not just the purchase price. Give the LINE ITEMS; the total is computed from them, so do not state a separate total that could disagree with its own parts.',
        properties: {
          cost_breakdown: {
            type: 'array',
            description: 'Required. Every cost that makes up the total, each as its own line item covering the WHOLE ownership period (not per year). At least three items. Include a purchase line always, a financing line whenever the customer is financing, and a running-costs line whenever there are any. These numbers are summed to produce the headline total, so each quantity must appear exactly ONCE across the whole array.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short plain-English name for this cost, e.g. "Fuel" or "Insurance" or "Interest over 60 months".' },
                kind: {
                  type: 'string',
                  enum: ['purchase', 'financing', 'running', 'resale_recovery', 'other'],
                  description: 'purchase = the price paid for the item itself. financing = interest and loan fees. running = fuel/energy, insurance, maintenance, repairs, taxes and fees, everything recurring. resale_recovery = money expected BACK at the end (enter it as a negative number). other = anything genuinely none of the above.',
                },
                low: { type: 'number', description: 'Low end in whole dollars over the entire ownership period. Negative only for a resale_recovery line. On a "running" line this is ignored entirely — write 0 and give per_year_low instead.' },
                high: { type: 'number', description: 'High end in whole dollars over the entire ownership period. Write 0 on a "running" line.' },
                per_year_low: { type: 'number', description: 'Low end of this cost PER YEAR, in whole dollars, on a "running" line. Write 0 on every other kind. The whole-period figure is this multiplied by the ownership period — you are not asked for it and should not work it out. A cost that is lumpy rather than steady (repairs that only start in year 6, say) goes in as its average per year across the whole period.' },
                per_year_high: { type: 'number', description: 'High end of this cost per year on a "running" line. Write 0 on every other kind.' },
                basis: { type: 'string', description: 'One short clause on where this number comes from, e.g. "12,000 mi/yr at 38 mpg and $3.20/gal". Do not restate the figure itself here in different numbers.' },
              },
              required: ['label', 'kind', 'low', 'high', 'per_year_low', 'per_year_high', 'basis'],
            },
          },
          explanation: { type: 'string', description: 'Required, non-empty. What drives the total and how confident you are. Do NOT restate the total or re-derive individual line items here in different numbers — the breakdown above is the single source of truth and this text sits directly beneath it.' },
        },
        required: ['cost_breakdown', 'explanation'],
      },
      financing_impact: {
        type: 'object',
        description: 'Required even when the customer is paying cash — say so explicitly rather than omitting this section.',
        properties: {
          applicable: { type: 'boolean', description: 'true if financing changes the cost picture (the customer is financing), false if paying cash.' },
          explanation: { type: 'string', description: 'Required, non-empty. If not financing, say plainly that the cash price is the cost (optionally note opportunity cost of tying up cash). If financing, explain what drives the interest cost — the figure itself comes from the financing line of cost_breakdown, so do not state a different one here.' },
        },
        required: ['applicable', 'explanation'],
      },
      maintenance_running_costs: {
        type: 'object',
        description: 'Required. Expected maintenance and running costs over the ownership period.',
        properties: {
          annual_low: { type: 'number', description: 'Required. Low end in whole dollars PER YEAR, covering the same things as the running-costs line(s) of cost_breakdown. These must agree: annual_low multiplied by the ownership period is checked against that line.' },
          annual_high: { type: 'number', description: 'Required. High end in whole dollars per year, on the same basis.' },
          explanation: { type: 'string', description: 'Required, non-empty. What drives these costs for this specific item/category, and how confident you are. Do not restate the annual figure in different numbers.' },
        },
        required: ['annual_low', 'annual_high', 'explanation'],
      },
      depreciation_resale: {
        type: 'object',
        description: 'Required. If this category has essentially no resale market, say so explicitly — that is still a real answer, not a reason to omit the section. Enter zero for both figures in that case.',
        properties: {
          resale_low: { type: 'number', description: 'Required. Low end of what the item is worth in whole dollars at the END of the ownership period, as a positive number. This is checked against the resale_recovery line of cost_breakdown, which carries the same figure negated. Zero if there is no meaningful resale market.' },
          resale_high: { type: 'number', description: 'Required. High end of the same figure. Zero if there is no meaningful resale market.' },
          expected_resale_note: { type: 'string', description: 'e.g. "roughly 40% of purchase price after 5 years" or "no meaningful resale market for this category".' },
          explanation: { type: 'string', description: 'Required, non-empty. Do not restate the resale figure in different numbers — it is stated once, above, and shown to the customer from there.' },
        },
        required: ['resale_low', 'resale_high', 'explanation'],
      },
      alternative_comparison: {
        type: 'object',
        description: 'Required. At least one realistic, specific alternative, compared directly against what the customer described.',
        properties: {
          alternative_name: { type: 'string', description: 'Required, non-empty. The specific alternative being compared — a different model, tier, or approach. Everything below and the explanation must be about THIS product. If you want to talk about a differently-configured version instead, name that one here.' },
          alternative_price_low: { type: 'number', description: 'Required. Low end of what this alternative costs to buy, in whole dollars.' },
          alternative_price_high: { type: 'number', description: 'Required. High end of the purchase price.' },
          alternative_total_low: { type: 'number', description: 'Required. Low end of what this alternative costs over the SAME ownership period as the main item, on the same basis. This is what makes it a comparison rather than a mention.' },
          alternative_total_high: { type: 'number', description: 'Required. High end of the same figure.' },
          explanation: { type: 'string', description: 'Required, non-empty. How the alternative named above compares on price, total cost, and the customer\'s stated must-haves. Do not restate the figures in different numbers — they are shown to the customer from the fields above.' },
        },
        required: ['alternative_name', 'alternative_price_low', 'alternative_price_high', 'alternative_total_low', 'alternative_total_high', 'explanation'],
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
        description: 'Required, and never empty — give at least three. Every number in cost_breakdown rests on something assumed (a fuel or electricity price, an interest rate, an insurance premium, an annual usage figure), and the customer cannot sanity-check a total whose inputs are invisible. State each assumption with its value, e.g. "gasoline at $3.10-$3.30/gal" or "an APR of 6.5-7.5% for a used-car loan at this credit tier".',
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

// Back to 3 from 5, because the report call no longer has the invocation to
// itself: verifyMustHaves runs first, in the same 300 seconds, and does its
// own searching. Two live runs were killed at the ceiling with no output at
// all — submission 7d2aa0fb (twice) and 95bd1598, both financed submissions,
// where the rate research is heaviest. Runs that fit did so at around 160-230
// seconds, so the margin was thin rather than comfortable.
//
// Three is a real reduction in research and the honest trade is worth
// stating: a report that completes with three searches is worth more than a
// better-researched one the platform kills. The must-have verification has
// also already looked the product up by the time this runs, so some of what
// the fourth and fifth searches used to buy is now on the table anyway.
// 20260209 is the current server-tool version for Sonnet 5, which is the
// model this engine runs on. It was pinned at 20250305 — the variant that
// predates this model — and a paid report generated 2026-09-07 came back
// with research_notes empty and zero server_tool_use blocks in the
// response, i.e. no search ran at all, while buying.html's FAQ told the
// customer the analysis "uses live web research where it can sharpen a
// figure". LEGACY is kept as a real fallback rather than a straight
// replacement: runOneAttempt now steps 20260209 -> 20250305 -> no search,
// so an account that only has the older variant enabled still searches
// instead of silently dropping to knowledge-only.
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };
const WEB_SEARCH_TOOL_LEGACY = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

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

// Renders the graded must-haves for the report's own system prompt. The
// verification runs first now, so the recommendation is written by a model
// that already knows the answer instead of one guessing at it.
function mustHaveBriefing(checks) {
  if (!Array.isArray(checks) || !checks.length) return '';
  const MARK = { confirmed: 'MET', contradicted: 'NOT MET', unverified: 'NOT ESTABLISHED' };
  const lines = checks
    .map((c) => `  - ${c.requirement} — ${MARK[c.verdict] || 'NOT ESTABLISHED'}. ${c.finding}${nonEmpty(c.source) ? ` (${c.source})` : ''}`)
    .join('\n');
  const failed = checks.filter((c) => c.verdict === 'contradicted');

  return `The customer's must-haves have already been checked against the product's published specification. These findings are established and are shown to the customer above your analysis. Treat them as given: do not re-examine them, do not restate them differently, and never describe a requirement as satisfied when it is listed below as NOT MET or NOT ESTABLISHED.

${lines}
${failed.length ? `
This item FAILS ${failed.length === 1 ? 'something' : 'things'} the customer called a deal-breaker: ${failed.map((c) => `"${c.requirement}"`).join(', ')}. Your recommendation therefore cannot be "buy". Say plainly in your reasoning that it does not meet that requirement, lead with it, and let the rest of the analysis inform what they should do instead — a report that recommends against a purchase on this ground is doing exactly its job, and the money is secondary to it.` : ''}${checks.some((c) => c.verdict === 'unverified') ? `
Where a requirement is NOT ESTABLISHED it is unknown, not met. Do not treat it as satisfied, and tell the customer it is worth confirming before they buy.` : ''}
`;
}

function buildSystemPrompt(submission, mustHaveChecks) {
  const brief = buildIntakeBrief(submission);
  return `You are the analysis engine behind Purchase Navigator, a StreamNavigator AI product. A customer paid $29 for a true total-cost-of-ownership analysis on something they're considering buying, and confirmed the details below before paying — treat this as sufficient to work with; do not respond by asking for more information or declaring the input insufficient.

Customer-provided details:
${brief}

Produce a genuinely useful, honest, specific analysis using these details as your foundation. Estimate financing cost impact if relevant, expected maintenance/running costs, and depreciation or resale-value expectations, using web search where it would sharpen a general-knowledge estimate into something more current and specific (typical current prices for this size/category/region, typical current financing rates) — and your own general knowledge of typical patterns for this category otherwise. Compare against at least one realistic, specific alternative that respects any must-have features the customer listed — cost it out over the same ownership period so the two totals sit side by side, and make sure everything you say about it is about the product you named rather than a differently-configured version of it. Give a clear buy/wait/reconsider recommendation grounded in the math, accounting for the customer's stated timeline. Show your reasoning and assumptions plainly so the customer can sanity-check them.

${mustHaveBriefing(mustHaveChecks) || 'Do not assert that the item does or does not have a given feature — you have not checked its specification.'}

Two rules about the numbers, because this product is bought for its arithmetic:

1. Give the cost breakdown as line items and let the total follow from them. You are not asked for a total anywhere, and you should not state one — it is computed from your line items and printed above your own explanation, so a total you write separately can only ever contradict it.

2. Each quantity gets stated once, in one place. Running costs go in maintenance_running_costs as a per-year figure and in cost_breakdown as a whole-period line; those two are checked against each other in code and the report is sent back to you if they disagree. Do not restate either of them, in different numbers, inside any explanation.

${HONESTY_RULES}

Respond ONLY by calling the submit_purchase_report tool.`;
}

// A separate, minimal system prompt for the targeted-repair follow-up
// (see repairExplanationField below) — NOT the main systemPrompt reused
// verbatim, which was the actual bug found after the first live retest of
// the repair mechanism failed on every attempt. buildSystemPrompt's last
// line explicitly instructs "Respond ONLY by calling the
// submit_purchase_report tool", and the body above it frames the task as
// producing all six report sections — both directly conflict with a
// forced call to a completely different, single-field tool, and plausibly
// primed the same kind of confusion that caused the original leak. This
// keeps the customer grounding and the anti-leak honesty rules the repair
// still needs, without the conflicting framing.
function buildRepairSystemPrompt(submission, mustHaveChecks) {
  const brief = buildIntakeBrief(submission);
  return `You previously analyzed the following purchase for Purchase Navigator, a StreamNavigator AI product:

${brief}

${mustHaveBriefing(mustHaveChecks)}

${noLeakRule('submit_field_repair')}

Respond ONLY by calling the submit_field_repair tool.`;
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

// Narrow, evidence-scoped recovery for the one failure mode actually
// observed in production (2026-08-31): sanitizeReportTags strips a leaked
// artifact that was an entire required "explanation" field's only content,
// leaving that one field empty while the rest of an otherwise-good,
// expensively-produced report (six sections, possibly several web_search
// rounds) is intact. Two earlier mitigations this same day — a prompt
// instruction, and renaming the field the leak kept referencing — both
// failed to stop the leak itself (a live re-test after the rename still
// leaked, just referencing the new name instead — see incident notes).
// Given the leak isn't reliably preventable, the more robust fix is
// cheapening recovery: instead of discarding the whole report and gambling
// on a full fresh attempt (its own web_search round plus full
// regeneration, and one of only MAX_ATTEMPTS chances) to fix one sentence,
// ask for just that one sentence again in a small, tightly-scoped,
// forced-tool-choice follow-up. A narrow "write one plain sentence" ask is
// both far cheaper and, going by the pattern so far, meaningfully less
// likely to trigger the same self-referential-schema leak than a large
// structured call with many nested fields is.
//
// Deliberately narrow: only the four simple, single required "explanation"
// fields nested one level under a known section are eligible — exactly
// the shape this incident recurred on. A top-level field, a compound
// section needing 2+ sub-fields, or multiple fields empty at once all fall
// through to the existing full-retry path below instead, since a repair
// strategy for those hasn't been built or tested against anything real.
const REPAIRABLE_EXPLANATION_FIELDS = {
  'total_cost_of_ownership.explanation': { section: 'total_cost_of_ownership', label: 'total cost of ownership' },
  'financing_impact.explanation': { section: 'financing_impact', label: 'financing impact' },
  'maintenance_running_costs.explanation': { section: 'maintenance_running_costs', label: 'maintenance and running costs' },
  'depreciation_resale.explanation': { section: 'depreciation_resale', label: 'depreciation / resale value' },
};

const FIELD_REPAIR_TOOL = {
  name: 'submit_field_repair',
  description: 'Submit the replacement text for the one field that needs to be rewritten.',
  input_schema: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'Plain natural-language prose only — 2-4 sentences, no tool-call, function-call, or parameter-tag syntax of any kind.' },
    },
    required: ['value'],
  },
};

// One small, cheap, forced-tool-choice call asking for a single field's
// replacement text — no web_search, no thinking, no other required
// sections to juggle. Returns the replacement string, or null if the
// repair itself came back empty, missing, or (rare, but checked
// defensively) leaked the same way the original attempt did — a failed
// repair falls through to the existing full-retry logic rather than
// shipping a still-bad field or looping repair attempts indefinitely.
async function repairExplanationField({ apiKey, systemPrompt, candidate, fieldPath, submissionId }) {
  const meta = REPAIRABLE_EXPLANATION_FIELDS[fieldPath];
  if (!meta) return null;

  const repairPrompt = `Your previous analysis below was almost complete, but the "${meta.label}" explanation was lost to a formatting glitch on our end before it reached us — nothing you need to avoid or worry about this time, just answer plainly.

Please provide ONLY a replacement: 2-4 sentences of plain prose covering the "${meta.label}" explanation, consistent with the rest of your analysis below. Do not include any tool-call, function-call, or parameter-tag syntax (anything shaped like <tag> or <parameter name="...">) — just the plain sentences themselves.

The rest of your analysis, for consistency:
${JSON.stringify({ headline: candidate.headline, summary: candidate.summary, recommendation: candidate.recommendation }, null, 2)}`;

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [FIELD_REPAIR_TOOL],
    toolChoice: { type: 'tool', name: 'submit_field_repair' },
    messages: [{ role: 'user', content: repairPrompt }],
    maxTokens: 1024,
  });
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_field_repair');
  // Every failure path below logs — a silent null return here was exactly
  // the diagnostic gap that made the first live retest of this mechanism
  // (2026-08-31) a dead end: it failed on 4/4 attempts with no way to tell
  // whether repair was even attempted, let alone why it didn't help.
  if (!toolUse) {
    console.warn(
      `[purchase-engine] Repair call for submission ${submissionId} (${fieldPath}) returned no submit_field_repair tool_use. content block types: ${(data.content || []).map((b) => b.type).join(', ') || '(none)'}`
    );
    return null;
  }
  const value = toolUse.input && toolUse.input.value;
  if (typeof value !== 'string' || !nonEmpty(value)) {
    console.warn(`[purchase-engine] Repair call for submission ${submissionId} (${fieldPath}) returned an empty or non-string value.`);
    return null;
  }
  if (value.match(TAG_LEAK_PATTERN)) {
    console.warn(`[purchase-engine] Repair call for submission ${submissionId} (${fieldPath}) itself leaked a tag-like fragment: ${JSON.stringify(value.slice(0, 200))}`);
    return null;
  }
  return value.trim();
}

// Extends the same targeted-repair strategy to the two remaining required
// sections that need MORE than one plain-text field — alternative_comparison
// (a name plus an explanation) and recommendation (an enum verdict plus
// reasoning). These were deliberately left out of the original repair
// mechanism as an unbuilt, untested case; live evidence (2026-09-01) then
// showed alternative_comparison hitting the exact same emptied-by-leak
// failure the four simple explanation fields did, on 4/4 attempts for one
// real submission, with no way to recover it. Given the same failure mode
// clearly isn't confined to single-field sections, extending the working
// mechanism here rather than waiting to rediscover the same gap at
// recommendation too.
const REPAIRABLE_COMPOUND_FIELDS = {
  alternative_comparison: {
    label: 'the realistic alternative comparison',
    fields: {
      alternative_name: { type: 'string', description: 'The specific alternative being compared — a different model, tier, or approach. Plain text only, no tool-call or parameter-tag syntax.' },
      alternative_price_low: { type: 'number', description: 'Low end of what this alternative costs to buy, in whole dollars.' },
      alternative_price_high: { type: 'number', description: 'High end of the purchase price.' },
      alternative_total_low: { type: 'number', description: 'Low end of what it costs over the same ownership period as the main item.' },
      alternative_total_high: { type: 'number', description: 'High end of the same figure.' },
      explanation: { type: 'string', description: 'How the alternative named above compares on price, total cost, and the customer\'s stated must-haves. 2-4 sentences of plain prose, no tool-call or parameter-tag syntax.' },
    },
  },
  recommendation: {
    label: 'the buy/wait/reconsider recommendation',
    fields: {
      verdict: { type: 'string', enum: ['buy', 'wait', 'reconsider'], description: 'One of: buy, wait, reconsider.' },
      reasoning: { type: 'string', description: 'Specific reasoning grounded in the analysis above, not generic advice. 2-4 sentences of plain prose, no tool-call or parameter-tag syntax.' },
    },
  },
};

function compoundRepairTool(sectionKey) {
  const spec = REPAIRABLE_COMPOUND_FIELDS[sectionKey];
  return {
    name: 'submit_field_repair',
    description: `Submit the replacement values for ${spec.label}.`,
    input_schema: {
      type: 'object',
      properties: spec.fields,
      required: Object.keys(spec.fields),
    },
  };
}

// Same shape as repairExplanationField above, generalized to a section
// needing multiple fields at once instead of one. Rejects the whole
// repair (not just the bad sub-field) if ANY expected field comes back
// empty, invalid, or leaked — a partially-repaired compound section is
// still an incomplete report, so there's no partial-credit case worth
// keeping here the way there is for the single-field version.
async function repairCompoundField({ apiKey, systemPrompt, candidate, sectionKey, submissionId }) {
  const spec = REPAIRABLE_COMPOUND_FIELDS[sectionKey];
  if (!spec) return null;
  const fieldNames = Object.keys(spec.fields);

  const repairPrompt = `Your previous analysis below was almost complete, but ${spec.label} was lost to a formatting glitch on our end before it reached us — nothing you need to avoid or worry about this time, just answer plainly.

Please provide ONLY a replacement for that section. Do not include any tool-call, function-call, or parameter-tag syntax (anything shaped like <tag> or <parameter name="...">) — just plain text.

The rest of your analysis, for consistency:
${JSON.stringify({ headline: candidate.headline, summary: candidate.summary }, null, 2)}`;

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [compoundRepairTool(sectionKey)],
    toolChoice: { type: 'tool', name: 'submit_field_repair' },
    messages: [{ role: 'user', content: repairPrompt }],
    maxTokens: 1024,
  });
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_field_repair');
  if (!toolUse || !toolUse.input) {
    console.warn(`[purchase-engine] Compound repair call for submission ${submissionId} (${sectionKey}) returned no usable tool_use.`);
    return null;
  }
  const result = {};
  for (const key of fieldNames) {
    const value = toolUse.input[key];
    if (spec.fields[key].type === 'number') {
      if (!isNum(value)) {
        console.warn(`[purchase-engine] Compound repair call for submission ${submissionId} (${sectionKey}.${key}) returned a non-numeric value.`);
        return null;
      }
      result[key] = value;
      continue;
    }
    if (typeof value !== 'string' || !nonEmpty(value) || value.match(TAG_LEAK_PATTERN)) {
      console.warn(`[purchase-engine] Compound repair call for submission ${submissionId} (${sectionKey}.${key}) returned an empty, invalid, or leaked value.`);
      return null;
    }
    result[key] = value.trim();
  }
  // The tool schema's enum isn't guaranteed any more reliably than any
  // other field has been this whole incident — checked explicitly rather
  // than trusted.
  if (sectionKey === 'recommendation' && !['buy', 'wait', 'reconsider'].includes(result.verdict)) {
    console.warn(`[purchase-engine] Compound repair call for submission ${submissionId} (recommendation.verdict) returned an invalid verdict: ${JSON.stringify(result.verdict)}`);
    return null;
  }
  return result;
}

// --- the cost model -------------------------------------------------------
//
// Everything below exists because of one defect in a real paid report
// (submission 29e81bc7, 2026-09-07, a 2023 RAV4 Hybrid over 7 years). Its
// "true total cost of ownership" section put fuel at $9,000-$11,000 over
// the period. Its "maintenance & running costs" section, three sections
// later, put ALL running costs at $900-$1,100 a year — $6,300-$7,700 over
// the same seven years. The two disagreed by roughly $3,000 on the same
// line item, and the larger of them fed the headline range the customer
// read first.
//
// Nothing was broken in the sense of throwing. Both paragraphs were fluent
// and plausible; they were simply generated as independent prose, each
// free to restate a quantity the other had already fixed. In a product
// whose entire premise is "we did the arithmetic you didn't", that is the
// worst possible failure mode, because it is invisible unless you sit down
// and do the arithmetic yourself.
//
// The fix is structural rather than a prompt asking more nicely for
// consistency. Each quantity now has exactly one home:
//   - the model gives line items (cost_breakdown), never a total;
//   - the TOTAL is summed here, in code, so it cannot disagree with its
//     own parts;
//   - running costs are given once as a per-year number, and the
//     breakdown's running line is checked against annual x years;
//   - the financing figure is read off the breakdown rather than asked
//     for separately.
// A contradiction that survives all that is caught by
// tcoArithmeticProblem below and sent back for a targeted repair, with
// the specific numbers that disagree quoted back to the model.

const COST_KINDS = ['purchase', 'financing', 'running', 'resale_recovery', 'other'];

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function money(n) {
  const rounded = Math.round(Math.abs(n));
  const withCommas = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-$' : '$') + withCommas;
}

function moneyRange(low, high) {
  return Math.round(low) === Math.round(high) ? money(low) : money(low) + ' – ' + money(high);
}

// Returns the validated line items, or null if the breakdown is unusable.
// Deliberately strict: a total summed from items that were never checked
// is a confident-looking number with nothing behind it, which is exactly
// what this whole section exists to stop.
function validBreakdown(tco) {
  if (!tco || !Array.isArray(tco.cost_breakdown) || tco.cost_breakdown.length < 3) return null;
  const years = tco.time_horizon_years;
  for (const item of tco.cost_breakdown) {
    if (!item || typeof item !== 'object') return null;
    if (!nonEmpty(item.label) || !nonEmpty(item.basis)) return null;
    if (!COST_KINDS.includes(item.kind)) return null;
    if (item.kind === 'running') {
      // A recurring cost is given once, per year, and the period figure is
      // worked out from it. See itemRange for why.
      if (!isNum(years) || years <= 0) return null;
      if (!isNum(item.per_year_low) || !isNum(item.per_year_high)) return null;
      if (item.per_year_low < 0 || item.per_year_high < item.per_year_low) return null;
      continue;
    }
    if (!isNum(item.low) || !isNum(item.high) || item.high < item.low) return null;
    // Only money coming back at the end may be negative. A negative fuel
    // cost is not a modelling choice, it is a mistake.
    if (item.kind !== 'resale_recovery' && (item.low < 0 || item.high < 0)) return null;
    if (item.kind === 'resale_recovery' && item.high > 0) return null;
  }
  if (!tco.cost_breakdown.some((i) => i.kind === 'purchase')) return null;
  return tco.cost_breakdown;
}

// The one place a running line's whole-period figure comes from.
//
// It used to be a number the model wrote, alongside a per-year number it
// also wrote, in a "basis" string it also wrote. The appliance report of
// 2026-09-08 put three different electricity figures in those three places:
// a line reading $600-$840 over 12 years, prose reading $120-$180 a year
// (which is $1,440-$2,160), and an assumptions entry giving the fridge's
// EnergyGuide rating and the Dominion rate, which work out to $102-$123 a
// year. The line item — the one the customer's total was built from — was
// the only one of the three that was wrong, and it made the headline total
// roughly $600 too low.
//
// Every previous fix here checked that two written numbers agreed, and each
// time the disagreement simply moved somewhere else. So a running cost is
// now written once, per year, and this multiplies.
function itemRange(item, years) {
  if (item.kind === 'running' && isNum(item.per_year_low) && isNum(item.per_year_high) && isNum(years)) {
    return { low: item.per_year_low * years, high: item.per_year_high * years };
  }
  return { low: item.low, high: item.high };
}

function sumBreakdown(items, years) {
  return items.reduce(
    (acc, i) => {
      const range = itemRange(i, years);
      return { low: acc.low + range.low, high: acc.high + range.high };
    },
    { low: 0, high: 0 }
  );
}

// Ranges are estimates, so this is not an equality test. The slack is the
// greater of 10% or $200 — wide enough that ordinary rounding inside a
// range never trips it, narrow enough that the $3,000 fuel contradiction
// that prompted all this would have been caught on the spot.
function withinTolerance(actual, expected) {
  return Math.abs(actual - expected) <= Math.max(Math.abs(expected) * 0.1, 200);
}

// Prose is judged harder than structure, because the figure it disagrees
// with is printed a couple of inches away. 10% was too generous: the live
// report of 2026-09-08 led with "roughly $51,000–$65,000 in true 7-year
// cost" directly above a summary strip reading $49,280 – $61,880, and the
// check waved it through at 3.5% and 5.0%. Nothing there is a rounding of
// anything; it is a second number for the same thing. 3% still allows an
// honest round — $49,280 shown as "$49,000" is 0.6% — while a figure a
// customer would notice as different gets sent back.
// The $200 absolute floor here came from withinTolerance, where it is
// rounding noise on a $49,000 car. Applied to a per-year figure it is the
// whole quantity: it let a stated $120-$180/yr for electricity match a line
// item of $80-$120/yr, which is how the appliance contradiction survived the
// first attempt at this check. The floor now only guards against dividing
// attention over pocket change.
function withinProseTolerance(actual, expected) {
  // The absolute floor has now been wrong twice in the same direction. It
  // started at $200, which is rounding noise on a $49,000 car and the entire
  // quantity on a $155/yr running cost. It became $25, which is fine against
  // a running total and still the entire quantity against a $100/yr filter
  // line — $40-$60 was accepted as matching $100 on submission 9109cb06.
  // Three percent is the real rule; the floor exists only so that figures of
  // a few dollars do not trip it, and $5 is enough for that.
  return Math.abs(actual - expected) <= Math.max(Math.abs(expected) * 0.03, 5);
}

// Prose quotes a range two ways, and they need judging differently. A range
// ("$51,000–$65,000") is compared end to end. A single figure ("total cost
// around $2,900") is a summary OF the range, so it is right if it lands
// inside it — requiring it to match both ends at once made a perfectly
// honest headline fail, which is how this function came to exist.
function proseFigureMatches(stated, target) {
  if (stated.low !== stated.high) {
    return withinProseTolerance(stated.low, target.low) && withinProseTolerance(stated.high, target.high);
  }
  if (stated.low >= target.low && stated.low <= target.high) return true;
  return withinProseTolerance(stated.low, target.low) || withinProseTolerance(stated.low, target.high);
}

// Returns null when the report is internally consistent, or a plain-English
// description of the contradiction otherwise. The text is written to be
// useful in two places at once: a Vercel log line, and the repair prompt
// handed back to the model, which is why it quotes the actual figures
// rather than just naming the fields.
function tcoArithmeticProblem(report) {
  const tco = report && report.total_cost_of_ownership;
  const items = validBreakdown(tco);
  if (!items) return null; // shape problems are isReportComplete's job, not this one's
  const years = tco.time_horizon_years;
  const maint = report.maintenance_running_costs;
  if (!isNum(years) || years <= 0) return null;
  if (!maint || !isNum(maint.annual_low) || !isNum(maint.annual_high)) return null;

  if (report.financing_impact && report.financing_impact.applicable === true
    && !items.some((i) => i.kind === 'financing')) {
    return 'The customer is financing this purchase, so the financing section has to have a cost behind it, but the cost breakdown contains no line of kind "financing" — the interest is either missing from the total or buried inside another line. Add it as its own line (0 to 0 if the loan genuinely carries no interest).';
  }

  const running = items.filter((i) => i.kind === 'running');
  const expectedLow = maint.annual_low * years;
  const expectedHigh = maint.annual_high * years;

  if (!running.length) {
    if (maint.annual_high <= 0) return null;
    return `The maintenance and running costs section says ${moneyRange(maint.annual_low, maint.annual_high)} a year, which is ${moneyRange(expectedLow, expectedHigh)} over ${years} years, but the cost breakdown contains no line of kind "running" at all — so those costs are missing from the total.`;
  }

  const actual = sumBreakdown(running, years);
  if (!withinTolerance(actual.low, expectedLow) || !withinTolerance(actual.high, expectedHigh)) {
    const labels = running.map((i) => i.label).join(', ');
    return `The running-cost lines in the cost breakdown (${labels}) come to ${moneyRange(actual.low, actual.high)} over ${years} years, but the maintenance and running costs section says ${moneyRange(maint.annual_low, maint.annual_high)} a year, which is ${moneyRange(expectedLow, expectedHigh)} over the same period. Those two describe the same costs and must agree.`;
  }

  return resaleProblem(report, items);
}

// Resale was the last quantity in this schema still living in two places at
// once, and the live report of 2026-09-08 duly put two different numbers in
// them: a resale_recovery line of $6,000-$8,000 in the breakdown (which the
// total was computed from), against "a resale/trade-in value in the ballpark
// of $16,000-$18,000" in the depreciation section a few inches below. Its own
// assumptions list said 22-31% of $32,400, which is $7,100-$10,000 — so the
// breakdown was the honest one and the section a customer reads for exactly
// this number was wrong by a factor of two.
function resaleProblem(report, items) {
  const dep = report.depreciation_resale;
  if (!dep || !isNum(dep.resale_low) || !isNum(dep.resale_high)) return null;
  const recovery = items.filter((i) => i.kind === 'resale_recovery');
  const stated = { low: dep.resale_low, high: dep.resale_high };

  if (!recovery.length) {
    // No line is right only if nothing comes back at the end.
    if (stated.high <= 0) return null;
    return `The depreciation and resale section says the item is worth ${moneyRange(stated.low, stated.high)} at the end of the ownership period, but the cost breakdown has no line of kind "resale_recovery" — so that money is not coming off the total. Add it as a negative line.`;
  }

  // The breakdown carries the figure negated, so compare magnitudes. Note the
  // low/high inversion: the MOST money back is the most negative line.
  const summed = sumBreakdown(recovery, report.total_cost_of_ownership.time_horizon_years);
  const backLow = Math.abs(summed.high);
  const backHigh = Math.abs(summed.low);
  if (withinTolerance(backLow, stated.low) && withinTolerance(backHigh, stated.high)) return null;
  return `The cost breakdown takes ${moneyRange(backLow, backHigh)} off the total as resale value recovered, but the depreciation and resale section says the item will be worth ${moneyRange(stated.low, stated.high)} at the end. Those are the same number and must agree.`;
}

// The single place a total is allowed to come from. Called by
// mapToGenericReport, so the customer-facing total is arithmetic over the
// line items printed directly above it and cannot drift from them.
function deriveNumbers(report) {
  const tco = (report && report.total_cost_of_ownership) || {};
  const items = validBreakdown(tco) || [];
  const years = isNum(tco.time_horizon_years) ? tco.time_horizon_years : null;
  const totals = sumBreakdown(items, years);
  const financing = items.filter((i) => i.kind === 'financing');
  const maint = report.maintenance_running_costs || {};
  return {
    items,
    // Each line paired with the range actually used, so callers never have
    // to know which kinds are per-year and which are whole-period.
    ranges: items.map((i) => ({ item: i, range: itemRange(i, years) })),
    years,
    total: items.length ? totals : null,
    financingCost: financing.length ? sumBreakdown(financing, years) : null,
    annual: isNum(maint.annual_low) && isNum(maint.annual_high)
      ? { low: maint.annual_low, high: maint.annual_high }
      : null,
  };
}


// --- repairing the numbers ------------------------------------------------
//
// The two repair mechanisms above rewrite prose. Neither can fix a total
// that disagrees with its own line items, or a breakdown that never
// arrived, so these two handle the numeric half. Same economics as the
// prose repairs: a small forced call costs a fraction of a full retry, and
// there are only MAX_ATTEMPTS of those before a paying customer gets
// nothing.

const COST_MODEL_REPAIR_TOOL = {
  name: 'submit_field_repair',
  description: 'Submit a corrected cost model: the line items that make up the total, and the per-year running cost, in numbers that agree with each other.',
  input_schema: {
    type: 'object',
    properties: {
      cost_breakdown: {
        type: 'array',
        description: 'At least three line items. A purchase line always, a financing line if the customer is financing, and a running line for each recurring cost. Whole-period figures in low/high, EXCEPT on "running" lines, which give per_year_low/per_year_high instead and have their period figure worked out from that. Each quantity appears exactly once across the array.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            kind: { type: 'string', enum: ['purchase', 'financing', 'running', 'resale_recovery', 'other'] },
            low: { type: 'number', description: 'Whole-period figure. Write 0 on a "running" line — it is ignored there.' },
            high: { type: 'number', description: 'Whole-period figure. Write 0 on a "running" line.' },
            per_year_low: { type: 'number', description: 'The cost PER YEAR on a "running" line; the period figure is worked out from it. Write 0 on every other kind.' },
            per_year_high: { type: 'number', description: 'The cost per year on a "running" line. Write 0 on every other kind.' },
            basis: { type: 'string', description: 'One short clause on where the number comes from.' },
          },
          required: ['label', 'kind', 'low', 'high', 'per_year_low', 'per_year_high', 'basis'],
        },
      },
      annual_low: { type: 'number', description: 'Low end of running costs PER YEAR. Multiplied by the ownership period, this must match the running lines above.' },
      annual_high: { type: 'number', description: 'High end of running costs per year, on the same basis.' },
      resale_low: { type: 'number', description: 'Low end of what the item is worth at the END of the period, as a positive number. Must match the resale_recovery line above, which carries it negated. Zero if there is no resale market.' },
      resale_high: { type: 'number', description: 'High end of the same figure, as a positive number. Zero if there is no resale market.' },
    },
    required: ['cost_breakdown', 'annual_low', 'annual_high', 'resale_low', 'resale_high'],
  },
};

// The `problem` argument is tcoArithmeticProblem's sentence: the specific
// figures that contradict each other, quoted back. Naming the contradiction
// is the difference between "try again" and a correction, because the live
// evidence for this failure mode was two fluent paragraphs, each of which
// looked entirely right on its own.
async function repairCostModel({ apiKey, systemPrompt, candidate, submissionId, problem }) {
  const framing = problem
    ? 'It is internally inconsistent and needs correcting.\n\nThe contradiction: ' + problem
    : 'Its cost breakdown did not reach us in a usable form.';
  const years = (candidate.total_cost_of_ownership || {}).time_horizon_years;
  const repairPrompt = `Your previous analysis of this purchase is below. ${framing}

Please provide ONLY a corrected cost model for a ${years}-year ownership period: the line items making up the total, and the running cost per year. The two must agree — the running lines, over the ownership period, must come to the per-year figure multiplied by the number of years. Give whole dollars. Decide which of the figures is the right one and make everything follow from it; do not split the difference.

Your analysis so far, for context:
${JSON.stringify({
    headline: candidate.headline,
    summary: candidate.summary,
    total_cost_of_ownership: candidate.total_cost_of_ownership,
    maintenance_running_costs: candidate.maintenance_running_costs,
    depreciation_resale: candidate.depreciation_resale,
  }, null, 2)}`;

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [COST_MODEL_REPAIR_TOOL],
    toolChoice: { type: 'tool', name: 'submit_field_repair' },
    messages: [{ role: 'user', content: repairPrompt }],
    maxTokens: 2048,
  });
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_field_repair');
  if (!toolUse || !toolUse.input) {
    console.warn(`[purchase-engine] Cost-model repair for submission ${submissionId} returned no usable tool_use.`);
    return null;
  }
  // Validated against exactly the same rules the report itself must pass,
  // so a repair can never install a breakdown that fails the next check
  // and burns another repair round proving it.
  const patched = {
    ...candidate,
    total_cost_of_ownership: {
      ...candidate.total_cost_of_ownership,
      time_horizon_years: candidate.total_cost_of_ownership && candidate.total_cost_of_ownership.time_horizon_years,
      cost_breakdown: toolUse.input.cost_breakdown,
    },
    maintenance_running_costs: {
      ...candidate.maintenance_running_costs,
      annual_low: toolUse.input.annual_low,
      annual_high: toolUse.input.annual_high,
    },
    depreciation_resale: {
      ...candidate.depreciation_resale,
      resale_low: toolUse.input.resale_low,
      resale_high: toolUse.input.resale_high,
    },
  };
  if (reportLooksContaminated(patched.total_cost_of_ownership)) {
    console.warn(`[purchase-engine] Cost-model repair for submission ${submissionId} came back with a leaked formatting artifact.`);
    return null;
  }
  const horizon = patched.total_cost_of_ownership.time_horizon_years;
  if (!validBreakdown(patched.total_cost_of_ownership) || !isNum(horizon) || horizon <= 0) {
    console.warn(`[purchase-engine] Cost-model repair for submission ${submissionId} returned an unusable breakdown.`);
    return null;
  }
  const dep = patched.depreciation_resale;
  if (!isNum(dep.resale_low) || !isNum(dep.resale_high) || dep.resale_low < 0 || dep.resale_high < dep.resale_low) {
    console.warn(`[purchase-engine] Cost-model repair for submission ${submissionId} returned unusable resale figures.`);
    return null;
  }
  const stillWrong = tcoArithmeticProblem(patched);
  if (stillWrong) {
    console.warn(`[purchase-engine] Cost-model repair for submission ${submissionId} still does not reconcile: ${stillWrong}`);
    return null;
  }
  return patched;
}

const ASSUMPTIONS_REPAIR_TOOL = {
  name: 'submit_field_repair',
  description: 'Submit the list of assumptions the analysis rests on.',
  input_schema: {
    type: 'object',
    properties: {
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Three to six plain sentences, each naming an assumption and its value — a fuel or energy price, an interest rate, an insurance premium, an annual usage level. These must be the values the numbers in the analysis were actually built on.',
      },
    },
    required: ['assumptions'],
  },
};

async function repairAssumptions({ apiKey, systemPrompt, candidate, submissionId }) {
  const repairPrompt = `Your analysis of this purchase is below, but the list of assumptions it rests on did not reach us.

Please provide ONLY that list: three to six plain sentences, each naming one assumption and the value you used for it, consistent with the numbers below. Plain prose, no tool-call or parameter-tag syntax.

${JSON.stringify({
    total_cost_of_ownership: candidate.total_cost_of_ownership,
    maintenance_running_costs: candidate.maintenance_running_costs,
    financing_impact: candidate.financing_impact,
  }, null, 2)}`;

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [ASSUMPTIONS_REPAIR_TOOL],
    toolChoice: { type: 'tool', name: 'submit_field_repair' },
    messages: [{ role: 'user', content: repairPrompt }],
    maxTokens: 1024,
  });
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_field_repair');
  const list = toolUse && toolUse.input && toolUse.input.assumptions;
  if (!Array.isArray(list)) {
    console.warn(`[purchase-engine] Assumptions repair for submission ${submissionId} returned no usable list.`);
    return null;
  }
  const cleaned = list.filter((v) => nonEmpty(v) && !String(v).match(TAG_LEAK_PATTERN)).map((v) => v.trim());
  if (cleaned.length < 2) {
    console.warn(`[purchase-engine] Assumptions repair for submission ${submissionId} returned ${cleaned.length} usable entries, needs at least 2.`);
    return null;
  }
  return cleaned;
}


// --- and the same total, in the prose -------------------------------------
//
// Making the model give line items and summing them here fixed the
// structured half: the strip at the top of the report and the breakdown
// below it are now the same arithmetic. The first live report generated
// against that engine (2026-09-08, the same RAV4) proved it only fixed
// half. Its line items summed to $47,000-$57,700 and its running-cost
// cross-check reconciled exactly — and its headline read:
//
//     ~$52,000-$68,000 total 7-year cost
//
// with the same invented figure repeated in the total-cost explanation,
// the recommendation, and the alternative comparison. The model had been
// told plainly not to state a total. It cannot help it: it writes the
// headline without having added up its own line items, because nothing
// adds them up until this file does.
//
// So the total is checked where the customer actually reads it. These
// fields are prose, which makes a general "is this arithmetic right"
// check hopeless, but the specific claim is narrow and recognisable — a
// dollar figure presented AS the whole-period cost of ownership. The
// exclusions below are each a real sentence from that report that must
// NOT be caught: "$38,000-$39,200 total amount paid over the loan term"
// is a legitimate different quantity, and "$13,000-$14,500 of the total
// cost" is a share of it, not a claim about it.

// $12,000 or $12,000-$15,000 or $12,000 – $15,000.
const MONEY_RE = /\$\s?\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:[–—-]|to)\s*\$?\s?\d+(?:,\d{3})*(?:\.\d+)?)?/g;

// These were 60 and 30, tightened at a point when a field quoting the total
// correctly was still reported as a conflict. That is no longer possible —
// a field containing the right figure is exempt outright (see anyCorrect
// below) — and 60 characters turned out to be nowhere near enough reach. On
// submission 9109cb06 three sections said "$4,900-$6,300" against a computed
// $5,323-$5,995 and every one slipped through, because the phrase that makes
// it a claim sat further back than the window went:
//
//   "over 12 years the total cost of ownership including energy, filters,
//    and repairs would likely land near $4,900-$6,300"
//                                       ^ 103 characters from "total cost"
const LOOK_BEHIND = 150;
const LOOK_AHEAD = 60;

// A whole-period cost claim does not have to contain the word "total".
// This required it, and the live report of 2026-09-08 walked straight
// past: its headline read "becomes roughly $51,000–$65,000 in true 7-year
// cost", which is exactly the claim being policed, phrased without the
// one word the pattern was looking for. The qualifiers below are the ways
// the same sentence gets written — total, true, all-in, or just the
// number of years.
// A whole-period cost claim does not have to contain the word "total", and
// it does not have to contain the word "cost" either. Submission a62f2dd1
// led with "About $5,300-$7,100 total over 12 years" and stated "brings the
// all-in total to about $5,300-$7,100"; both are exactly the claim being
// policed and neither says "cost", so neither was looked at.
const CLAIMS_A_TOTAL = new RegExp(
  [
    String.raw`(?:total|true|all-?in|lifetime|\d+-year)[\s\w-]{0,25}cost`,
    String.raw`cost\s+of\s+ownership`,
    String.raw`\btotal\s+over\s+\d+\s+years?`,
    String.raw`\ball-?in\s+total\b`,
  ].join('|'),
  'i'
);
// Only two kinds of exclusion survive, and both are about the scanned
// fields themselves. An earlier version also excluded loan / interest /
// financ / resale / depreciat, to protect sentences like "$38,000-$39,200
// total amount paid over the loan term" — but those live in fields this
// never looks at, and the words cost a real catch: "pushes 7-year total
// cost slightly above the RAV4's $52,000-$68,000 range once financing and
// running costs are included" was let through purely because the word
// financing sat thirty characters later. Components are already filtered
// out by magnitude; they do not need a vocabulary list as well.
const NOT_THE_TOTAL = new RegExp(
  [
    String.raw`\bof\s+(the\s+)?total\b`, // "$13,000 of the total cost" is a share, not a claim
    String.raw`per\s+year|/\s?year|/\s?yr|annual`, // and a per-year figure is not a whole-period one
  ].join('|'),
  'i'
);

function parseMoneyRange(text) {
  const numbers = String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return null;
  const values = numbers.map(Number).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  return { low: Math.min(...values), high: Math.max(...values) };
}

// The fields a customer reads a headline number out of. depreciation and
// maintenance are deliberately absent: everything they quote is a share or
// a per-year figure, and including them only produced false positives.
const PROSE_TOTAL_FIELDS = {
  headline: { get: (r) => r.headline, label: 'the headline' },
  summary: { get: (r) => r.summary, label: 'the summary' },
  'total_cost_of_ownership.explanation': {
    get: (r) => r.total_cost_of_ownership && r.total_cost_of_ownership.explanation,
    label: 'the total-cost explanation',
  },
  'recommendation.reasoning': {
    get: (r) => r.recommendation && r.recommendation.reasoning,
    label: 'the recommendation',
  },
  'alternative_comparison.explanation': {
    get: (r) => r.alternative_comparison && r.alternative_comparison.explanation,
    label: 'the comparison against the alternative',
    alsoAllows: (r) => {
      const alt = r.alternative_comparison || {};
      return isNum(alt.alternative_total_low) && isNum(alt.alternative_total_high)
        ? [{ low: alt.alternative_total_low, high: alt.alternative_total_high }]
        : [];
    },
  },
  'maintenance_running_costs.explanation': {
    get: (r) => r.maintenance_running_costs && r.maintenance_running_costs.explanation,
    label: 'the maintenance and running costs section',
    // The eighth place a total could be stated, and the last one nothing was
    // watching. On submission 05d61ecb this section closed with "...already
    // folded into the $5,700-$7,800 total-cost-of-ownership estimate above",
    // where the estimate above was $5,943-$7,533 — out by 4.1% and 3.5%. It
    // was checked by proseRunningConflict for per-year and whole-period
    // COMPONENT figures and never for a claim about the whole.
    //
    // Its own business is components, so every line item's figure is set
    // aside first at both scales; what remains is a claim about the total.
    alsoAllows: (r) => lineRanges(r).flatMap((l) => [l.whole, l.perYear].filter(Boolean)),
  },
  'financing_impact.explanation': {
    get: (r) => r.financing_impact && r.financing_impact.explanation,
    label: 'the financing section',
    // Loan totals belong in this section and are not claims about the
    // lifetime cost. Only an explicit one counts here.
    claims: /lifetime[\s\w-]{0,25}cost|cost\s+of\s+ownership|total\s+cost\s+of\s+ownership/i,
  },
};

// Returns [] when nothing in the prose contradicts the computed total, or
// one entry per offending field. Each carries the quoted figure, so the
// repair prompt can name what to replace rather than asking for a rewrite
// and hoping.
function proseTotalConflicts(report) {
  const derived = deriveNumbers(report);
  if (!derived.total) return [];
  const floor = derived.total.low * 0.5;
  const conflicts = [];

  for (const [path, spec] of Object.entries(PROSE_TOTAL_FIELDS)) {
    const text = spec.get(report);
    if (!nonEmpty(text)) continue;

    // Gather every figure in this field that reads as a claim about the
    // whole-period cost, then judge the field as a whole.
    const claims = [];
    MONEY_RE.lastIndex = 0;
    let match;
    while ((match = MONEY_RE.exec(text)) !== null) {
      const claimWindow = text.slice(Math.max(0, match.index - LOOK_BEHIND), match.index + match[0].length + LOOK_AHEAD);
      const attached = text.slice(Math.max(0, match.index - EXCLUSION_LOOK_BEHIND), match.index + match[0].length + EXCLUSION_LOOK_AHEAD);
      if (!(spec.claims || CLAIMS_A_TOTAL).test(claimWindow) || NOT_THE_TOTAL.test(attached)) continue;
      const stated = parseMoneyRange(match[0]);
      if (!stated) continue;
      // A figure far smaller than the computed total is a component being
      // discussed, not a rival claim about the whole.
      if (stated.high < floor) continue;
      claims.push({ stated, quoted: match[0].trim() });
    }
    if (!claims.length) continue;

    // Figures that are correct statements about something else — the
    // alternative's own whole-period cost, in the section written to compare
    // it — are not claims about this item at all, and must be set aside
    // before anything else is judged. Leaving them in let the alternative's
    // correct total excuse a wrong one for this item in the same sentence.
    const elsewhere = spec.alsoAllows ? spec.alsoAllows(report) : [];
    const aboutThisItem = claims.filter(
      (c) => !elsewhere.some((t) => t && proseFigureMatches(c.stated, t))
    );
    if (!aboutThisItem.length) continue;

    // A field that states this item's total correctly is not contradicting
    // anything, and the other large figures near it are something else.
    // Without this, a headline reading "$47,000-$57,700 total 7-year cost
    // — the $32,400 price looks fair" reported the $32,400 as a rival
    // total, purely because it sat close to the words "total cost".
    const anyCorrect = aboutThisItem.some((c) => proseFigureMatches(c.stated, derived.total));
    if (anyCorrect) continue;
    conflicts.push({
      path,
      label: spec.label,
      // Every qualifying figure, not a guess at which one is the claim.
      quoted: aboutThisItem.map((c) => c.quoted).join(' and '),
    });
  }

  const resale = proseResaleConflict(report);
  if (resale) conflicts.push(resale);

  const running = proseRunningConflict(report);
  if (running) conflicts.push(running);

  const component = proseComponentConflict(report);
  if (component) conflicts.push(component);

  // A field can trip more than one of these — a total-cost explanation that
  // invents a total is also quoting a figure no line item carries. The repair
  // rewrites a field once, so it should be asked once, and the earlier
  // diagnosis is the more specific one.
  const seen = new Set();
  return conflicts.filter((c) => {
    if (seen.has(c.path)) return false;
    seen.add(c.path);
    return true;
  });
}

// The resale figure has the same shape of problem as the total and needs
// its own vocabulary: it is never called a "total", so CLAIMS_A_TOTAL
// cannot see it. On 2026-09-08 the depreciation section said "a
// resale/trade-in value in the ballpark of $16,000-$18,000" while the
// breakdown took $6,000-$8,000 off the total and the assumptions list said
// 22-31% of $32,400. Two of the three agreed; the one written in prose,
// in the section titled for exactly this number, did not.
// Deliberately short. The depreciation section quotes percentages, the
// purchase price and a resale figure within a sentence of each other, so the
// exclusions below only tell them apart at close range.
const RESALE_LOOK_BEHIND = 60;
const RESALE_LOOK_AHEAD = 30;

// The words that make a figure a claim can sit a sentence away, so
// CLAIMS_A_TOTAL is tested against 150 characters. The words that DISQUALIFY
// one are attached to it — "$1,100/year", "$13,000 of the total" — so they
// are tested against a few characters either side.
//
// Sharing the wide window let an unrelated phrase silence a real claim. On
// submission a9655d25 the alternative section said
//
//   "...roughly $90-$120/year in electricity) total cost lands around
//    $3,400-$3,900, versus an estimated $4,900-$5,900 for the LRFXC2416S"
//
// and that "/year", 90 characters away and attached to a different figure,
// excluded a rival total for the reviewed product that was 17% out at the top
// end. Widening the claim window to 150 is what made this likely: the fix for
// one miss created the conditions for another.
const EXCLUSION_LOOK_BEHIND = 25;
const EXCLUSION_LOOK_AHEAD = 25;

const CLAIMS_A_RESALE = /resale|trade-?in|worth|retain|residual/i;

// Percentages and per-year figures are not the resale figure, and the
// purchase price appears constantly in this section as the thing being
// depreciated from.
const NOT_THE_RESALE = /%|per\s+year|\/\s?year|\/\s?yr|annual|purchase price|paid|sticker|original/i;

function proseResaleConflict(report) {
  const dep = report && report.depreciation_resale;
  if (!dep || !isNum(dep.resale_low) || !isNum(dep.resale_high)) return null;
  if (dep.resale_high <= 0) return null; // nothing comes back; nothing to contradict

  for (const [field, text] of [['expected_resale_note', dep.expected_resale_note], ['explanation', dep.explanation]]) {
    if (!nonEmpty(text)) continue;
    const claims = [];
    MONEY_RE.lastIndex = 0;
    let match;
    while ((match = MONEY_RE.exec(text)) !== null) {
      const window = text.slice(Math.max(0, match.index - RESALE_LOOK_BEHIND), match.index + match[0].length + RESALE_LOOK_AHEAD);
      if (!CLAIMS_A_RESALE.test(window) || NOT_THE_RESALE.test(window)) continue;
      const stated = parseMoneyRange(match[0]);
      if (!stated) continue;
      claims.push({ stated, quoted: match[0].trim() });
    }
    if (!claims.length) continue;
    const anyCorrect = claims.some((c) => proseFigureMatches(c.stated, { low: dep.resale_low, high: dep.resale_high }));
    if (anyCorrect) continue;
    return {
      path: 'depreciation_resale.' + field,
      label: 'the depreciation and resale section',
      quoted: claims[0].quoted,
      correct: moneyRange(dep.resale_low, dep.resale_high),
    };
  }
  return null;
}

// A money figure carrying an explicit scale: per year, or across the whole
// ownership period. Figures with no scale attached ("$150-$600 per incident",
// "$50 each") are not claims about a line item and are left alone.
const PER_YEAR_MONEY_RE = new RegExp(
  MONEY_RE.source + String.raw`\s*(?:/\s?yr\b|/\s?year\b|per\s+year|a\s+year|annually|each\s+year)`,
  'gi'
);
const WHOLE_PERIOD_MONEY_RE = new RegExp(
  MONEY_RE.source + String.raw`\s*(?:over|across|during)\s+(?:the\s+)?(?:full\s+|entire\s+)?\d+[\s-]*year`,
  'gi'
);

// Which line item is this figure describing?
//
// The check used to ask only "is this per-year figure one the report uses
// anywhere", and that is how "$40-$60 a year" for water filters passed on
// submission 9109cb06: the filter line says $100/yr flat, but $40-$60 is
// near enough the ELECTRICITY line's $60-$75 to satisfy set membership. A
// number can be right about the wrong thing and still clear a check that
// only looks at the set of numbers.
// A line label may contain a unit of time — "Interest on 39-month
// financing", "Resale value recovered at 6 years" — and those words then
// match the scale marker on a completely different figure. "$44/month" for
// the All-Access membership was attributed to the financing line on exactly
// that, because "month" sat one character away. A word that describes when
// a cost falls is not evidence of which cost it is.
const LABEL_TIME_WORDS = new Set(['month', 'months', 'year', 'years', 'annual', 'annually', 'monthly', 'yearly']);

function nearestNamedLine(text, at, lines) {
  const lower = text.toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const line of lines) {
    for (const word of meaningfulWords(line.label)) {
      if (LABEL_TIME_WORDS.has(word)) continue;
      const needle = word.replace(/s$/, '');
      if (needle.length < 4) continue;
      for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
        // A label after the figure is still a label, just weaker evidence.
        const distance = i <= at ? at - i : (i - at) * 1.5;
        if (distance < bestDistance && distance <= 140) {
          bestDistance = distance;
          best = line;
        }
      }
    }
  }
  return best;
}

// The running lines each state a cost per year, and the maintenance section
// talks about the same costs in prose. On 2026-09-08 that section said
// "$10-$15/month in electricity (about $120-$180/year)" while the
// electricity line said $50-$70 a year. Both were about the same fridge.
//
// So every scaled figure in that section has to agree with the line it is
// describing — matched by label, falling back to "any line, or the total"
// only when the sentence names none of them.
function proseRunningConflict(report) {
  const maint = report && report.maintenance_running_costs;
  if (!maint || !nonEmpty(maint.explanation)) return null;
  if (!isNum(maint.annual_low) || !isNum(maint.annual_high)) return null;
  const items = validBreakdown(report.total_cost_of_ownership);
  if (!items) return null;
  const years = report.total_cost_of_ownership.time_horizon_years;
  if (!isNum(years) || years <= 0) return null;

  const runningLines = items
    .filter((i) => i.kind === 'running' && isNum(i.per_year_low) && isNum(i.per_year_high))
    .map((i) => ({ label: i.label, low: i.per_year_low, high: i.per_year_high }));
  if (!runningLines.length) return null;
  const aggregate = { label: 'all running costs together', low: maint.annual_low, high: maint.annual_high };

  const text = maint.explanation;
  for (const [re, scale] of [[PER_YEAR_MONEY_RE, 1], [WHOLE_PERIOD_MONEY_RE, years]]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const moneyOnly = String(match[0]).match(new RegExp(MONEY_RE.source));
      const stated = parseMoneyRange(moneyOnly ? moneyOnly[0] : match[0]);
      if (!stated) continue;
      const named = nearestNamedLine(text, match.index, runningLines);
      const targets = named ? [named] : runningLines.concat([aggregate]);
      const scaled = targets.map((t) => ({ label: t.label, low: t.low * scale, high: t.high * scale }));
      if (scaled.some((t) => proseFigureMatches(stated, t))) continue;
      const should = scaled[0];
      return {
        path: 'maintenance_running_costs.explanation',
        label: 'the maintenance and running costs section',
        quoted: match[0].trim(),
        correct: `${moneyRange(should.low, should.high)}${scale === 1 ? '/yr' : ` over ${years} years`}, which is what the "${should.label}" line says`,
      };
    }
  }
  return null;
}

const PROSE_REPAIR_TOOL_FIELDS = {
  headline: 'A short, specific, plain-English headline. Lead with the correct total.',
  summary: 'Two to four sentences on the bottom line and why.',
  'total_cost_of_ownership.explanation': 'Two to four sentences on what drives the total and how confident you are.',
  'recommendation.reasoning': 'Two to four sentences, specific to this purchase.',
  'alternative_comparison.explanation': 'Two to four sentences on how the alternative compares.',
  'depreciation_resale.expected_resale_note': 'One short phrase, e.g. "roughly 40% of purchase price after 5 years".',
  'depreciation_resale.explanation': 'Two to four sentences on how this item holds its value.',
  'financing_impact.explanation': 'Two to four sentences on what financing costs and what drives it.',
  'maintenance_running_costs.explanation': 'Two to four sentences on what drives these costs. Any per-year figure must be one the report already uses.',
  'total_cost_of_ownership.explanation': 'Two to four sentences on what drives the total. Any figure naming a line item must be that line item\'s figure.',
};

function proseRepairTool(conflicts) {
  const properties = {};
  for (const c of conflicts) {
    properties[c.path.replace(/\./g, '__')] = { type: 'string', description: PROSE_REPAIR_TOOL_FIELDS[c.path] };
  }
  return {
    name: 'submit_field_repair',
    description: 'Rewrite these fields so the total they quote is the correct one.',
    input_schema: { type: 'object', properties, required: Object.keys(properties) },
  };
}

// The model could not have got this right the first time: it wrote the
// headline before anything had added up its line items. So this hands it
// the computed figure and asks only for the sentences that quoted a
// different one.
async function repairProseTotals({ apiKey, systemPrompt, candidate, submissionId, conflicts }) {
  const derived = deriveNumbers(candidate);
  if (!derived.total || !conflicts.length) return null;
  const correct = moneyRange(derived.total.low, derived.total.high);

  const quoted = conflicts
    .map((c) => `- ${c.label} quotes ${c.quoted}; the right figure is ${c.correct || correct}`)
    .join('\n');
  const repairPrompt = `Your cost breakdown for this purchase adds up to ${correct} over ${derived.years} years. That figure is arithmetic over your own line items and is the one the customer is shown, so it is the only total that may appear anywhere in the report.

These parts of your write-up quote a figure that disagrees with your own numbers:
${quoted}

Please rewrite just those. Where a field quotes more than one figure, only the one being presented as the whole-period total is wrong — correct that and leave the others exactly as they are. Keep your reasoning, your emphasis and everything else you said; only the number changes. Plain prose, no tool-call or parameter-tag syntax.

Your line items, for reference:
${JSON.stringify(derived.items, null, 2)}`;

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [proseRepairTool(conflicts)],
    toolChoice: { type: 'tool', name: 'submit_field_repair' },
    messages: [{ role: 'user', content: repairPrompt }],
    maxTokens: 2048,
  });
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_field_repair');
  if (!toolUse || !toolUse.input) {
    console.warn(`[purchase-engine] Prose-total repair for submission ${submissionId} returned no usable tool_use.`);
    return null;
  }

  const patched = JSON.parse(JSON.stringify(candidate));
  for (const c of conflicts) {
    const value = toolUse.input[c.path.replace(/\./g, '__')];
    if (!nonEmpty(value) || String(value).match(TAG_LEAK_PATTERN)) {
      console.warn(`[purchase-engine] Prose-total repair for submission ${submissionId} returned an empty or leaked value for ${c.path}.`);
      return null;
    }
    const parts = c.path.split('.');
    if (parts.length === 1) patched[parts[0]] = value.trim();
    else patched[parts[0]] = { ...patched[parts[0]], [parts[1]]: value.trim() };
  }

  const stillWrong = proseTotalConflicts(patched);
  if (stillWrong.length) {
    console.warn(
      `[purchase-engine] Prose-total repair for submission ${submissionId} still quotes a wrong total in: ${stillWrong.map((c) => c.path).join(', ')}`
    );
    return null;
  }
  return patched;
}


const RESEARCH_NOTES_REPAIR_TOOL = {
  name: 'submit_field_repair',
  description: 'Submit short notes on what the web research turned up.',
  input_schema: {
    type: 'object',
    properties: {
      found_nothing_usable: {
        type: 'boolean',
        description: 'true if the searches did not turn up anything you actually relied on, so your figures came from general knowledge instead. That is a perfectly good answer — set this and leave research_notes empty rather than describing findings you are not confident of.',
      },
      research_notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Empty when found_nothing_usable is true. Otherwise two to five short notes, each saying what you found and roughly where it came from, e.g. "Experian Q1 2026 puts the average used-car loan APR at 11.43%". Only things you actually looked up and used.',
      },
    },
    required: ['found_nothing_usable', 'research_notes'],
  },
};

// buying.html sells "live web research". The appliance report of 2026-09-08
// searched — its assumptions cite Dominion Energy territory, the 2026-27
// Virginia rate case, the fridge's EnergyGuide rating and LG's own filter
// guidance — and then returned an empty research_notes, so the customer's
// report carried no research section at all. The work was done and paid for
// and thrown away on the way out.
//
// Only ever called when the response actually contained web_search rounds,
// so this asks the model to write down what it already found rather than
// inviting it to invent having searched. A failure here does not fail the
// report: an absent research section is a lesser wrong than losing a
// customer's whole analysis over it.
async function repairResearchNotes({ apiKey, systemPrompt, candidate, submissionId, searchRounds }) {
  const repairPrompt = `${searchRounds} web search${searchRounds === 1 ? '' : 'es'} ran while you produced the analysis below, but no notes on them reached us, so the customer's report currently shows nothing about the research.

Two answers are equally acceptable and you should give whichever is true:

  - If those searches turned up things you actually relied on, write two to five short lines saying what you found and roughly what kind of source it came from, and leave found_nothing_usable false.
  - If they did not turn up anything usable, and your figures really came from general knowledge, set found_nothing_usable to true and leave the notes empty. Do NOT reconstruct findings you are not confident you actually saw. An honest "the search did not help" is worth more here than a plausible-sounding list.

Your analysis, for reference:
${JSON.stringify({
    total_cost_of_ownership: candidate.total_cost_of_ownership,
    assumptions: candidate.assumptions,
  }, null, 2)}`;

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [RESEARCH_NOTES_REPAIR_TOOL],
    toolChoice: { type: 'tool', name: 'submit_field_repair' },
    messages: [{ role: 'user', content: repairPrompt }],
    maxTokens: 1024,
  });
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_field_repair');
  const input = (toolUse && toolUse.input) || {};
  if (input.found_nothing_usable === true) {
    console.warn(`[purchase-engine] Submission ${submissionId} searched ${searchRounds} time(s) and reported finding nothing it relied on.`);
    return { foundNothing: true };
  }
  if (!Array.isArray(input.research_notes)) {
    console.warn(`[purchase-engine] Research-notes repair for submission ${submissionId} returned no usable list.`);
    return null;
  }
  const cleaned = input.research_notes.filter((v) => nonEmpty(v) && !String(v).match(TAG_LEAK_PATTERN)).map((v) => v.trim());
  return cleaned.length ? { notes: cleaned } : null;
}




// The must-have verification, cached on the submission row.
//
// job_state is the jsonb column the HOA worker already uses for its own
// per-job bookkeeping; a submission belongs to one product, so there is no
// collision. Stored under its own key so anything else that lands there
// later is unaffected.
//
// This exists for the timeout. An attempt gets 300 seconds; a second attempt
// gets a fresh 300, and it should spend them on the report rather than on
// re-establishing a specification that has not changed since the attempt
// that ran out of time.
function readCachedVerification(submission) {
  const cached = ((submission && submission.job_state) || {}).must_have_verification;
  if (!cached || !Array.isArray(cached.checks)) return null;
  return { checks: cached.checks, searchRounds: Number(cached.searchRounds) || 0 };
}

async function cacheVerification(admin, submission, verification) {
  try {
    const jobState = { ...(submission.job_state || {}), must_have_verification: verification };
    await admin
      .from('navigator_submissions')
      .update({ job_state: jobState, updated_at: new Date().toISOString() })
      .eq('id', submission.id);
    submission.job_state = jobState;
  } catch (err) {
    // Losing the cache costs a repeated lookup on the next attempt, which is
    // the situation this was written to improve, not one it can make worse.
    console.warn(`[purchase-engine] Could not cache the must-have verification for submission ${submission.id}: ${String((err && err.message) || err)}`);
  }
}

// --- components restated in prose -----------------------------------------
//
// The Peloton report (submission 95bd1598, the first run of the "other"
// category) had an exact strip and an exact total, and its total-cost
// explanation contradicted its own line items four times over:
//
//   interest      prose $150-$300   | line $0-$670
//   maintenance   prose $200-$400   | line $360-$1,080
//   resale        prose $600-$900   | line $200-$450
//
// Nothing looked at any of them. The resale check reads only the
// depreciation section, the per-year check reads only the maintenance
// section, and the total check reads the total. A component restated inside
// the total-cost explanation was in none of those.
//
// This is the same check as proseRunningConflict, generalised: find which
// line a figure is talking about, and hold it to that line.

// Every line item with the ranges it can legitimately be quoted at.
// resale_recovery is stored negative and spoken about positive, so its
// magnitude is what prose is compared against.
function lineRanges(report) {
  const tco = (report && report.total_cost_of_ownership) || {};
  const items = validBreakdown(tco);
  const years = tco.time_horizon_years;
  if (!items || !isNum(years) || years <= 0) return [];
  return items.map((item) => {
    if (item.kind === 'running') {
      return {
        label: item.label,
        whole: { low: item.per_year_low * years, high: item.per_year_high * years },
        perYear: { low: item.per_year_low, high: item.per_year_high },
      };
    }
    if (item.kind === 'resale_recovery') {
      return {
        label: item.label,
        whole: { low: Math.abs(item.high), high: Math.abs(item.low) },
        perYear: null,
      };
    }
    return { label: item.label, whole: { low: item.low, high: item.high }, perYear: null };
  });
}

// Whether the figure says per year, per month, or across the period. A figure
// with no scale attached could be either, and is accepted at either.
function scaleAfter(text, at) {
  const tail = text.slice(at, at + 30);
  if (/\/\s?mo\b|\/\s?month|per\s+month|a\s+month|monthly/i.test(tail)) return 'month';
  if (/\/\s?yr\b|\/\s?year|per\s+year|a\s+year|annually|each\s+year/i.test(tail)) return 'year';
  if (/(over|across|during)\s+(the\s+)?(full\s+|entire\s+)?\d+[\s-]*year/i.test(tail)) return 'period';
  return null;
}

const COMPONENT_FIELDS = {
  'total_cost_of_ownership.explanation': {
    get: (r) => r.total_cost_of_ownership && r.total_cost_of_ownership.explanation,
    label: 'the total-cost explanation',
  },
  // financing_impact is deliberately absent. It talks about quantities that
  // are real and are not line items — the amount paid over a loan term, the
  // all-in cost of the item plus its interest — and a membership test would
  // report every one of them. Whole-life claims made there are already
  // covered by the total check.
};

function proseComponentConflict(report) {
  const lines = lineRanges(report);
  if (!lines.length) return null;
  const years = report.total_cost_of_ownership.time_horizon_years;
  const derived = deriveNumbers(report);

  for (const [path, spec] of Object.entries(COMPONENT_FIELDS)) {
    const text = spec.get(report);
    if (!nonEmpty(text)) continue;
    MONEY_RE.lastIndex = 0;
    let match;
    while ((match = MONEY_RE.exec(text)) !== null) {
      const stated = parseMoneyRange(match[0]);
      if (!stated) continue;
      // The total is this field's business too, and has its own check.
      if (derived.total && proseFigureMatches(stated, derived.total)) continue;

      // Every figure any line in this report can legitimately be quoted at,
      // rather than an attempt to work out which line this sentence means.
      //
      // The defect being caught is a figure that belongs to NO line — the
      // Peloton report's "$150-$300 in interest" against a $0-$670 line,
      // "$200-$400" maintenance against $360-$1,080, "$600-$900" resale
      // against $200-$450. None of those is any line's figure at any scale,
      // and none needs a parser to see that.
      //
      // The cost of membership over attribution is that a figure matching the
      // WRONG line still passes. That is a weaker guarantee, and it is the one
      // worth having here: the line items are printed directly above this
      // paragraph, so a figure drawn from them is at least a real number from
      // this report, whereas the alternative is a heuristic that has now been
      // wrong three different ways on three real sentences.
      const scale = scaleAfter(text, match.index + match[0].length);
      const allowed = [];
      for (const line of lines) {
        const perYear = line.perYear || { low: line.whole.low / years, high: line.whole.high / years };
        if (scale === 'year') allowed.push(perYear);
        else if (scale === 'month') allowed.push({ low: perYear.low / 12, high: perYear.high / 12 });
        else if (scale === 'period') allowed.push(line.whole);
        else { allowed.push(line.whole); allowed.push(perYear); }
      }
      if (allowed.some((a) => proseFigureMatches(stated, a))) continue;

      const nearest = nearestNamedLine(text, match.index, lines);
      return {
        path,
        label: spec.label,
        quoted: match[0].trim(),
        correct: nearest
          ? `a figure this report actually uses — the "${nearest.label}" line says ${moneyRange(nearest.whole.low, nearest.whole.high)} over ${years} years`
          : 'a figure this report actually uses; none of its line items carries this one',
      };
    }
  }
  return null;
}

// --- the must-haves -------------------------------------------------------
//
// Three runs of the same appliance submission (an LG LRFXC2416S, whose
// must-haves included "no external door dispenser") produced three
// different verdicts. One returned WAIT over the fridge's height, one
// returned RECONSIDER having found the external dispenser, and one returned
// BUY — asserting in its recommendation that the model has "no external
// dispenser" and "already matches your must-haves".
//
// That last one is the reason this exists. LG's own product page lists a
// Tall Ice & Water Dispenser on that model, so the report told a customer
// their deal-breaker was satisfied when it was not, as a reason to buy. It
// was internally consistent, its arithmetic reconciled perfectly, and every
// numeric check in this file passed it. No amount of further validation
// would have caught it, because the defect was not a contradiction — it was
// a confident memory.
//
// So compliance stops being an aside in prose and becomes one graded verdict
// per requirement, each having to name what it rests on. And a verdict may
// only be "confirmed" or "contradicted" if research actually ran this
// attempt (see the searchRounds downgrade at the call site) — recalling that
// a model has a feature is not checking that it does.

// Splits the customer's free-text must-haves into the individual things they
// asked for. Deliberately generous about separators: people write these as
// "AWD, Apple CarPlay and roof rails" as often as a clean list.
function mustHaveFragments(submission) {
  const raw = ((submission && submission.form_data) || {}).must_have_features;
  if (!nonEmpty(raw)) return [];
  return String(raw)
    .split(/[,;\n]|\band\b|\bplus\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
}

// Same idea as the token matching in closing-audit.js: single characters and
// filler words carry no signal, so a fragment counts as covered when the
// words that actually mean something are present.
const FILLER = new Set(['must', 'have', 'has', 'with', 'the', 'a', 'an', 'no', 'not', 'and', 'or', 'of', 'for', 'be', 'is', 'it', 'that', 'this', 'any', 'all', 'my', 'i', 'want', 'need', 'needs', 'deal', 'breaker', 'dealbreaker', 'fit', 'fits']);

function meaningfulWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));
}

function fragmentCovered(fragment, checks) {
  const wanted = meaningfulWords(fragment);
  if (!wanted.length) return true;
  return checks.some((c) => {
    const got = new Set(meaningfulWords(c.requirement));
    const hits = wanted.filter((w) => got.has(w)).length;
    return hits >= Math.max(1, Math.ceil(wanted.length / 2));
  });
}

// Returns null when the must-have section is sound, or a sentence naming
// what is wrong with it — used both as the log line and as the repair prompt.
function mustHaveProblem(report, submission) {
  if (!submission) return null;
  const fragments = mustHaveFragments(submission);
  const checks = report && report.must_have_checks;
  if (!Array.isArray(checks)) return 'The must-have checks are missing entirely.';
  if (!fragments.length) return null;

  if (!checks.length) {
    return `The customer named ${fragments.length} must-have${fragments.length === 1 ? '' : 's'} (${fragments.join('; ')}) and the report checks none of them.`;
  }

  for (const check of checks) {
    if (!check || typeof check !== 'object') return 'A must-have check is not a usable entry.';
    if (!nonEmpty(check.requirement) || !nonEmpty(check.finding) || !nonEmpty(check.source)) {
      return `The must-have check for "${(check && check.requirement) || '(unnamed)'}" is missing its finding or its source.`;
    }
    // A verdict about a specification has to quote the specification. A
    // paraphrase is where "compact 4' x 2' footprint" and "59 inches long"
    // stop being distinguishable.
    if (check.verdict !== 'unverified' && !nonEmpty(check.published_value)) {
      return `The must-have check for "${check.requirement}" says "${check.verdict}" without quoting the published figure it rests on.`;
    }
    if (!['confirmed', 'contradicted', 'unverified'].includes(check.verdict)) {
      return `The must-have check for "${check.requirement}" has no usable verdict.`;
    }
    // A verdict about a specification has to say where the specification was
    // read. "not checked" is the honest answer and is allowed, but only
    // alongside the unverified verdict.
    if (check.verdict !== 'unverified' && /^\s*(not checked|n\/?a|none|unknown|general knowledge|training data)\s*$/i.test(check.source)) {
      return `The must-have check for "${check.requirement}" says "${check.verdict}" but names no source it was checked against.`;
    }
  }

  const uncovered = fragments.filter((f) => !fragmentCovered(f, checks));
  if (uncovered.length) {
    return `The customer asked for "${uncovered.join('" and "')}" and the report never says whether the item has ${uncovered.length === 1 ? 'it' : 'them'}.`;
  }

  // The failure that prompted all this, in its final form: a report that
  // recommends buying something it has just said does not meet a stated
  // deal-breaker.
  const broken = checks.filter((c) => c.verdict === 'contradicted');
  if (broken.length && report.recommendation && report.recommendation.verdict === 'buy') {
    return `The report says the item fails "${broken[0].requirement}" and then recommends buying it. A contradicted deal-breaker means wait or reconsider.`;
  }
  return null;
}



// A size requirement is arithmetic, so it is not left as a judgement.
//
// Two Peloton runs on the same submission disagreed about the same fact.
// The requirement was "must fit a 4ft by 2ft floor space". One run answered
// CONFIRMED, citing Peloton's shop page and its "compact 4' x 2' footprint";
// the other answered NOT MET. Both had read Peloton. The Bike+ is 59 inches
// long, which is 4.9 feet, so the marketing line and the spec sheet describe
// the same object and only one of them answers the question.
//
// The same shape appeared on the LG fridge, where runs disagreed about an
// external door dispenser, and it is the largest remaining source of
// variance in this product: the numbers have been stable for a while, the
// spec judgements have not.
//
// So when the model hands back a measurement, the verdict is computed from
// it. That does not make the lookup reliable — a wrong published figure is
// still wrong — but it removes the step where the same two numbers produce
// different answers on different days.
function verdictFromMeasurement(measurement) {
  if (!measurement || typeof measurement !== 'object') return null;
  const { value, limit, comparison } = measurement;
  if (!isNum(value) || !isNum(limit)) return null;
  if (comparison !== 'at_most' && comparison !== 'at_least') return null;
  return comparison === 'at_most'
    ? (value <= limit ? 'confirmed' : 'contradicted')
    : (value >= limit ? 'confirmed' : 'contradicted');
}

// Applies those computed verdicts in place, and says so when one disagrees
// with what the model concluded — that disagreement is the whole point, and
// it should be visible in the logs rather than silently corrected.
function applyMeasuredVerdicts(checks, submissionId) {
  if (!Array.isArray(checks)) return checks;
  for (const check of checks) {
    if (!check || typeof check !== 'object') continue;
    const computed = verdictFromMeasurement(check.measurement);
    if (!computed) continue;
    const { value, limit, unit, comparison } = check.measurement;
    const relation = comparison === 'at_most' ? 'must be at most' : 'must be at least';
    if (check.verdict !== computed) {
      console.warn(
        `[purchase-engine] Submission ${submissionId}: "${check.requirement}" was graded ${check.verdict} but its own figures say ${computed} (${value} ${unit} against a limit of ${limit}); using the figures.`
      );
    }
    check.verdict = computed;
    // The customer sees the comparison, not just the answer.
    const arithmetic = `${value} ${unit} against ${limit} ${unit} — it ${relation} ${limit}.`;
    if (!String(check.finding || '').includes(String(value))) {
      check.finding = `${arithmetic} ${check.finding || ''}`.trim();
    }
  }
  return checks;
}

const MUST_HAVE_REPAIR_TOOL = {
  name: 'submit_field_repair',
  description: 'Submit one verdict for each must-have the customer named.',
  input_schema: {
    type: 'object',
    properties: {
      must_have_checks: {
        type: 'array',
        description: 'One entry per must-have, in the customer\'s words.',
        items: {
          type: 'object',
          properties: {
            requirement: { type: 'string' },
            verdict: { type: 'string', enum: ['confirmed', 'contradicted', 'unverified'] },
            finding: { type: 'string', description: 'What the specification actually says, in one sentence.' },
            source: { type: 'string', description: 'Where you read it. "not checked" when unverified. Never a source you did not read.' },
          },
          required: ['requirement', 'verdict', 'finding', 'source'],
        },
      },
      verdict: { type: 'string', enum: ['buy', 'wait', 'reconsider'], description: 'The buy/wait/reconsider call, restated. If any must-have came back contradicted this cannot be "buy".' },
      reasoning: { type: 'string', description: 'Required. The reasoning for that verdict, rewritten to match it. Two to four sentences. If a requirement came back contradicted, lead with the fact that the item does not meet it — never describe it as satisfied.' },
    },
    required: ['must_have_checks', 'verdict', 'reasoning'],
  },
};

// Takes the recommendation as well as the checks, because the two are not
// separable: the failure this exists for was a report that graded a
// deal-breaker and then recommended buying anyway. Repairing the grades
// without letting the verdict move would just produce the same conflict.
async function repairMustHaveChecks({ apiKey, systemPrompt, candidate, submission, submissionId, problem }) {
  const fragments = mustHaveFragments(submission);
  const repairPrompt = `The customer named these as must-haves or deal-breakers:

${fragments.map((f) => '  - ' + f).join('\n')}

${problem ? 'Something is wrong with how the report answers them: ' + problem : 'The report does not answer them.'}

Give one entry per item above. For each, say what the product's actual specification says and where you read it. If you did not look it up, the verdict is "unverified" and the source is "not checked" — that is an honest, useful answer, and far better than a confident guess: a customer told their deal-breaker is satisfied will buy the thing.

Then give the buy/wait/reconsider call AND the reasoning for it, rewritten to match. If any item comes back contradicted the verdict cannot be "buy", and the reasoning must lead with the fact that the item does not meet that requirement — a verdict that says one thing while its reasoning says another is worse than either alone.

What was already established about each, which you should keep unless you
have a reason to change it:
${JSON.stringify(candidate.must_have_checks || [], null, 2)}

Your analysis, for reference:
${JSON.stringify({ headline: candidate.headline, recommendation: candidate.recommendation }, null, 2)}`;

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    tools: [MUST_HAVE_REPAIR_TOOL],
    toolChoice: { type: 'tool', name: 'submit_field_repair' },
    messages: [{ role: 'user', content: repairPrompt }],
    maxTokens: 2048,
  });
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_field_repair');
  if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.must_have_checks)) {
    console.warn(`[purchase-engine] Must-have repair for submission ${submissionId} returned no usable checks.`);
    return null;
  }
  if (reportLooksContaminated(toolUse.input.must_have_checks) || reportLooksContaminated(toolUse.input.reasoning)) {
    console.warn(`[purchase-engine] Must-have repair for submission ${submissionId} came back with a leaked formatting artifact.`);
    return null;
  }
  if (!nonEmpty(toolUse.input.reasoning)) {
    console.warn(`[purchase-engine] Must-have repair for submission ${submissionId} returned a verdict with no reasoning to match it.`);
    return null;
  }
  const patched = {
    ...candidate,
    must_have_checks: applyMeasuredVerdicts(toolUse.input.must_have_checks, submissionId),
    recommendation: {
      ...candidate.recommendation,
      verdict: toolUse.input.verdict,
      reasoning: toolUse.input.reasoning.trim(),
    },
  };
  // Checked against the same rule the report has to pass, so a repair can
  // never install something that fails the next round and burns it.
  const stillWrong = mustHaveProblem(patched, submission);
  if (stillWrong) {
    console.warn(`[purchase-engine] Must-have repair for submission ${submissionId} still does not answer them: ${stillWrong}`);
    return null;
  }
  return patched;
}


const MUST_HAVE_TOOL = {
  name: 'submit_must_have_checks',
  description: 'Submit one graded verdict for each must-have the customer named.',
  input_schema: {
    type: 'object',
    properties: {
      must_have_checks: {
        type: 'array',
        description: 'Exactly one entry per requirement listed, in the customer\'s words.',
        items: {
          type: 'object',
          properties: {
            requirement: { type: 'string', description: 'The must-have or deal-breaker as the customer stated it.' },
            verdict: {
              type: 'string',
              enum: ['confirmed', 'contradicted', 'unverified'],
              description: 'confirmed = you looked the specification up and the item has this. contradicted = you looked it up and it does NOT, or it has the thing they called a deal-breaker. unverified = you could not establish it. Recalling that a model has a feature is NOT checking; if you did not look it up in this conversation, the honest answer is unverified.',
            },
            finding: { type: 'string', description: 'What the specification actually says, in one sentence. For unverified, what you were unable to establish.' },
            published_value: { type: 'string', description: 'Required. The published figure or wording your verdict rests on, quoted rather than paraphrased — "59.0 in D x 22.0 in W", "Tall Ice & Water Dispenser with Measured Fill", "Dual Ice Maker". Write "not found" when the verdict is unverified. A marketing summary is not a published value: if a page says "compact 4\' x 2\' footprint" and the spec sheet says 59 inches long, quote the spec sheet.' },
            measurement: {
              type: 'object',
              description: 'ONLY for a requirement that is a size, weight or capacity limit — a width that must fit an opening, a footprint, a height clearance. Leave it out entirely otherwise. When you give it, the verdict is worked out from these numbers rather than taken from your verdict field, so put the published figure in value and the customer\'s limit in limit, both in the same unit.',
              properties: {
                value: { type: 'number', description: 'The item\'s published figure, e.g. 59 for a 59-inch length.' },
                limit: { type: 'number', description: 'The customer\'s stated limit in the same unit, e.g. 48 for a 4-foot space.' },
                unit: { type: 'string', description: 'The unit both are in, e.g. "inches".' },
                comparison: { type: 'string', enum: ['at_most', 'at_least'], description: 'at_most when the item must not exceed the limit (fitting an opening); at_least when it must meet or beat it.' },
              },
              required: ['value', 'limit', 'unit', 'comparison'],
            },
            source: { type: 'string', description: 'Where you read it — the manufacturer page, a retailer listing, the spec sheet. "not checked" when unverified. Never a source you did not actually read.' },
          },
          required: ['requirement', 'verdict', 'finding', 'published_value', 'source'],
        },
      },
    },
    required: ['must_have_checks'],
  },
};

// Its own request, with its own search budget and one job. Returns the
// graded checks and — separately — how many searches actually ran, because
// the caller downgrades every verdict when the answer is none.
async function verifyMustHaves({ apiKey, submission, submissionId, allowSearch }) {
  const fragments = mustHaveFragments(submission);
  if (!fragments.length) return { checks: [], searchRounds: 0 };

  const formData = submission.form_data || {};
  const system = `You check whether one specific product meets a buyer's stated requirements, for StreamNavigator AI. You do one thing: look up what the product actually is, and grade each requirement against it.

The product, as the buyer described it: ${formData.item_description || '(not given)'}
${formData.configuration ? `Configuration they want: ${formData.configuration}\n` : ''}${formData.size_constraints ? `Size constraints: ${formData.size_constraints}\n` : ''}
Search for the product's published specification before answering. Do not answer from memory about what a given model has or does not have — that is the single most damaging thing you can get wrong, because a buyer told their deal-breaker is satisfied will go and buy the thing. If a search does not settle it, "unverified" is the right answer and costs the buyer nothing; a confident wrong answer costs them the purchase.

Prefer the specification sheet to the marketing copy, and quote what you found rather than summarising it. Manufacturers round in their own favour: a page describing a "compact 4' x 2' footprint" alongside a spec sheet listing 59 inches of length is describing the same object twice, and only one of those two answers whether it fits a four-foot space. Where a requirement is a size, give the numbers and let the comparison be done for you.

${noLeakRule('submit_must_have_checks')}

Respond ONLY by calling the submit_must_have_checks tool.`;

  const userText = `Grade each of these requirements against the product's actual specification:

${fragments.map((f) => '  - ' + f).join('\n')}

Give exactly one entry per line above, using the buyer's own wording for the requirement.`;

  const messages = [{ role: 'user', content: userText }];
  const searchTool = { ...WEB_SEARCH_TOOL, max_uses: 3 };

  let data;
  try {
    data = await callAnthropic({
      apiKey,
      system,
      tools: allowSearch ? [searchTool, MUST_HAVE_TOOL] : [MUST_HAVE_TOOL],
      toolChoice: { type: 'auto' },
      messages,
      maxTokens: 3000,
    });
  } catch (err) {
    if (allowSearch && looksLikeUnsupportedToolError(err)) {
      return verifyMustHaves({ apiKey, submission, submissionId, allowSearch: false });
    }
    // A failed verification must not cost the customer their report. The
    // caller falls back to unverified entries, which is honest and still
    // tells them what to go and check.
    console.warn(`[purchase-engine] Must-have verification for submission ${submissionId} failed: ${String((err && err.message) || err)}`);
    return null;
  }

  const searchRounds = countSearchRounds(data);
  let toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_must_have_checks');
  if (!toolUse) {
    const replay = (data.content || []).filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    const followData = await callAnthropic({
      apiKey,
      system,
      tools: [MUST_HAVE_TOOL],
      toolChoice: { type: 'tool', name: 'submit_must_have_checks' },
      messages: messages.concat([
        { role: 'assistant', content: replay },
        { role: 'user', content: 'Now call submit_must_have_checks with one entry per requirement, using anything you found above.' },
      ]),
      maxTokens: 2000,
    });
    toolUse = (followData.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_must_have_checks');
  }
  if (!toolUse || !Array.isArray(toolUse.input && toolUse.input.must_have_checks)) {
    console.warn(`[purchase-engine] Must-have verification for submission ${submissionId} returned no usable checks.`);
    return null;
  }
  return {
    checks: applyMeasuredVerdicts(sanitizeReportTags(toolUse.input.must_have_checks), submissionId),
    searchRounds,
  };
}

// What the report carries when verification could not run at all: the
// requirements the customer typed, each honestly marked as unchecked. A
// customer who is told "we could not confirm this, go and look" is far
// better served than one shown nothing, and immeasurably better served
// than one told it is fine.
function unverifiedChecks(submission) {
  return mustHaveFragments(submission).map((requirement) => ({
    requirement,
    verdict: 'unverified',
    finding: 'This could not be checked against the product specification for this report.',
    source: 'not checked',
  }));
}


// The ownership period, taken from the customer rather than the model.
//
// It was a required field of the report schema, which meant asking the model
// to repeat a number the intake form already collects and the pre-payment
// gate already requires for every category. Every quantity in this file has
// been moved to having one source of truth; this one had two, and the second
// was the more likely to be wrong.
function horizonYears(submission) {
  const raw = ((submission && submission.form_data) || {}).ownership_years;
  const years = Number(raw);
  return Number.isFinite(years) && years > 0 ? years : null;
}

const OBJECT_VALUED_FIELDS = [
  'total_cost_of_ownership',
  'financing_impact',
  'maintenance_running_costs',
  'depreciation_resale',
  'alternative_comparison',
  'recommendation',
];

// Recovers a nested object the model serialised as a flat string.
//
// The leak first seen on 2026-08-31 has settled into one reproducible shape:
// total_cost_of_ownership arrives not as an object but as the string
//
//     "\n<parameter name=\"time_horizon_years\">12"
//
// — the model writing the nested object out in tool-call syntax instead of
// as JSON. It hit four of six appliance runs and none of three vehicle ones.
//
// Two earlier attempts to stop it — a prompt instruction, then renaming the
// field it kept referencing — both failed, and the rename simply moved the
// leak to the new name. So this does not try to prevent it a third time. It
// bounds the damage instead: pull out whatever fragments are recoverable,
// hand the rest to the repair machinery that already knows how to rebuild a
// cost model, and let the attempt finish. Before this, sanitizeReportTags
// reduced the string to "12", the explanation repair spread a string into an
// object ({0:'1',1:'2'}), and the attempt was spent discovering that.
function salvageLeakedObject(value) {
  if (typeof value !== 'string') return null;
  const out = {};
  const fragments = /<parameter\s+name="([^"]+)"\s*>([^<]*)/g;
  let match;
  while ((match = fragments.exec(value)) !== null) {
    const key = match[1];
    const raw = match[2].trim();
    if (!raw) continue;
    const asNumber = Number(raw.replace(/[$,]/g, ''));
    out[key] = /^[$\s,\d.]+$/.test(raw) && Number.isFinite(asNumber) ? asNumber : raw;
  }
  return out;
}

// Defense in depth: the tool schema's `required` arrays lean on the model
// to fill every field, but a model can technically satisfy a JSON Schema
// with an empty string. This is the actual guarantee that all six promised
// outputs made it into the report — checked in code, not just implied by a
// prompt — before a customer ever sees it.
function isReportComplete(report, submission) {
  if (!report || typeof report !== 'object') return false;
  if (!nonEmpty(report.headline) || !nonEmpty(report.summary)) return false;

  const tco = report.total_cost_of_ownership;
  if (!tco || !nonEmpty(tco.explanation)) return false;
  if (!isNum(tco.time_horizon_years) || tco.time_horizon_years <= 0) return false;
  if (!validBreakdown(tco)) return false;

  const financing = report.financing_impact;
  if (!financing || typeof financing.applicable !== 'boolean' || !nonEmpty(financing.explanation)) return false;

  const maintenance = report.maintenance_running_costs;
  if (!maintenance || !nonEmpty(maintenance.explanation)) return false;
  if (!isNum(maintenance.annual_low) || !isNum(maintenance.annual_high)) return false;
  if (maintenance.annual_low < 0 || maintenance.annual_high < maintenance.annual_low) return false;

  const depreciation = report.depreciation_resale;
  if (!depreciation || !nonEmpty(depreciation.explanation)) return false;
  if (!isNum(depreciation.resale_low) || !isNum(depreciation.resale_high)) return false;
  if (depreciation.resale_low < 0 || depreciation.resale_high < depreciation.resale_low) return false;

  const alt = report.alternative_comparison;
  if (!alt || !nonEmpty(alt.alternative_name) || !nonEmpty(alt.explanation)) return false;
  if (!isNum(alt.alternative_price_low) || !isNum(alt.alternative_price_high)) return false;
  if (!isNum(alt.alternative_total_low) || !isNum(alt.alternative_total_high)) return false;
  if (alt.alternative_price_low < 0 || alt.alternative_price_high < alt.alternative_price_low) return false;
  if (alt.alternative_total_low < alt.alternative_price_low) return false;
  if (alt.alternative_total_high < alt.alternative_total_low) return false;

  const rec = report.recommendation;
  if (!rec || !['buy', 'wait', 'reconsider'].includes(rec.verdict) || !nonEmpty(rec.reasoning)) return false;

  if (!Array.isArray(report.missing_or_uncertain)) return false;
  // Two, not zero. An empty assumptions list used to pass here, on the
  // reasoning that "there truly were none" is sometimes an honest answer.
  // For this product it never is: every figure in the cost breakdown rests
  // on an assumed fuel or energy price, an assumed rate, an assumed usage
  // level. A paid report on 2026-09-07 came back with the list empty, so a
  // customer was shown a seven-year total with none of its inputs stated
  // and no way to sanity-check any of it.
  if (!Array.isArray(report.assumptions) || report.assumptions.filter(nonEmpty).length < 2) return false;

  // Last: the two sections must not contradict each other on the same
  // costs. See tcoArithmeticProblem for the incident this comes from.
  if (tcoArithmeticProblem(report)) return false;
  // And the prose must not quote a total the line items do not support.
  if (proseTotalConflicts(report).length) return false;
  // And every must-have the customer named has to have been answered.
  if (submission && mustHaveProblem(report, submission)) return false;

  return true;
}

// Diagnostic-only companion to isReportComplete: names the first missing
// field instead of just true/false, so an incomplete-report error message
// says WHICH of the six sections was empty rather than making that a
// mystery every time (this is exactly the gap that made the 2026-08-31
// leaked-tag incident take 3 live rounds to narrow down instead of 1).
function firstIncompleteField(report, submission) {
  if (!report || typeof report !== 'object') return '(no report object)';
  if (!nonEmpty(report.headline)) return 'headline';
  if (!nonEmpty(report.summary)) return 'summary';
  if (!report.total_cost_of_ownership || !nonEmpty(report.total_cost_of_ownership.explanation)) return 'total_cost_of_ownership.explanation';
  if (!isNum(report.total_cost_of_ownership.time_horizon_years) || report.total_cost_of_ownership.time_horizon_years <= 0) return 'total_cost_of_ownership.cost_model';
  if (!validBreakdown(report.total_cost_of_ownership)) return 'total_cost_of_ownership.cost_model';
  // Split into two distinct checks/labels (was one combined check under a
  // single label) — a real bug found via live evidence (2026-09-01): when
  // financing_impact.applicable was missing or not a proper boolean (not a
  // leaked-tag problem at all), this used to report the SAME label,
  // 'financing_impact.explanation', as when explanation itself was empty.
  // The repair mechanism only knows how to rewrite explanation text, so it
  // kept "successfully" repairing explanation over and over — 3 wasted
  // repair calls in one real attempt — while the actual defect (a missing
  // boolean, which no amount of rewriting a sentence fixes) went
  // unaddressed, until the repair-round budget ran out and the whole
  // report still fell through to a full retry anyway. Reporting a
  // distinct label here (one that REPAIRABLE_EXPLANATION_FIELDS doesn't
  // recognize) makes the repair loop correctly bail out immediately
  // instead of wasting attempts on a fix that can't possibly work.
  if (!report.financing_impact || typeof report.financing_impact.applicable !== 'boolean') return 'financing_impact.applicable';
  if (!nonEmpty(report.financing_impact.explanation)) return 'financing_impact.explanation';
  if (!report.maintenance_running_costs || !nonEmpty(report.maintenance_running_costs.explanation)) return 'maintenance_running_costs.explanation';
  if (!isNum(report.maintenance_running_costs.annual_low) || !isNum(report.maintenance_running_costs.annual_high)
    || report.maintenance_running_costs.annual_low < 0
    || report.maintenance_running_costs.annual_high < report.maintenance_running_costs.annual_low) return 'total_cost_of_ownership.cost_model';
  if (!report.depreciation_resale || !nonEmpty(report.depreciation_resale.explanation)) return 'depreciation_resale.explanation';
  if (!isNum(report.depreciation_resale.resale_low) || !isNum(report.depreciation_resale.resale_high)
    || report.depreciation_resale.resale_low < 0
    || report.depreciation_resale.resale_high < report.depreciation_resale.resale_low) return 'total_cost_of_ownership.cost_model';
  if (!report.alternative_comparison || !nonEmpty(report.alternative_comparison.alternative_name) || !nonEmpty(report.alternative_comparison.explanation)) return 'alternative_comparison';
  {
    const a = report.alternative_comparison;
    if (!isNum(a.alternative_price_low) || !isNum(a.alternative_price_high) || !isNum(a.alternative_total_low) || !isNum(a.alternative_total_high)
      || a.alternative_price_low < 0 || a.alternative_price_high < a.alternative_price_low
      || a.alternative_total_low < a.alternative_price_low || a.alternative_total_high < a.alternative_total_low) return 'alternative_comparison';
  }
  if (!report.recommendation || !['buy', 'wait', 'reconsider'].includes(report.recommendation.verdict) || !nonEmpty(report.recommendation.reasoning)) return 'recommendation';
  if (!Array.isArray(report.missing_or_uncertain)) return 'missing_or_uncertain';
  if (!Array.isArray(report.assumptions) || report.assumptions.filter(nonEmpty).length < 2) return 'assumptions';
  // Reported last, and under its own label, so it can never be confused
  // with a merely-empty field: the report is structurally complete and
  // still says two different things about the same money.
  if (tcoArithmeticProblem(report)) return 'total_cost_of_ownership.arithmetic';
  if (proseTotalConflicts(report).length) return 'total_cost_of_ownership.prose';
  if (submission && mustHaveProblem(report, submission)) return 'must_have_checks';
  return '(unknown — isReportComplete said false but firstIncompleteField found nothing; these two have drifted apart)';
}

// Maps the bespoke, guaranteed-complete schema above into the generic
// {headline, summary, key_numbers, sections, missing_or_uncertain} shape
// navigator-status.html already renders — fixed section titles, in a fixed
// order, one per promised output, always populated because isReportComplete
// already verified every source field is non-empty before this ever runs.
function mapToGenericReport(report) {
  const keyNumbers = [];
  // Built up here so it can sit in the strip beside the money; the section
  // itself is assembled further down.
  const allChecks = Array.isArray(report.must_have_checks) ? report.must_have_checks : [];
  const failed = allChecks.filter((c) => c && c.verdict === 'contradicted').length;
  const confirmed = allChecks.filter((c) => c && c.verdict === 'confirmed').length;
  const checksSummary = allChecks.length
    ? {
      label: 'Your must-haves',
      value: failed
        ? `${failed} of ${allChecks.length} NOT met`
        : `${confirmed} of ${allChecks.length} confirmed`,
    }
    : null;
  const tco = report.total_cost_of_ownership || {};
  // Every figure here is computed from the cost breakdown rather than read
  // off a field the model filled in separately. That is the whole point:
  // the strip at the top of the report and the line items below it are the
  // same arithmetic, so they cannot disagree.
  //
  // The old version read low_end/high_end, extra_cost_estimate and
  // annual_estimate — all optional strings. On the paid report of
  // 2026-09-07 the model wrote its numbers into the prose and left every
  // one of those blank, so this loop produced a summary strip containing a
  // single entry, the word "BUY", above a report whose prose talked about
  // $55,000-$66,000. Nothing failed; the most-read part of the page was
  // just empty.
  const derived = deriveNumbers(report);
  if (derived.total) {
    keyNumbers.push({
      label: `Total cost of ownership${derived.years ? ` (${derived.years}yr)` : ''}`,
      value: moneyRange(derived.total.low, derived.total.high),
    });
  }
  if (report.financing_impact && report.financing_impact.applicable && derived.financingCost) {
    keyNumbers.push({
      label: 'Interest and financing cost',
      value: moneyRange(derived.financingCost.low, derived.financingCost.high),
    });
  }
  if (derived.annual) {
    keyNumbers.push({
      label: 'Running cost per year',
      value: moneyRange(derived.annual.low, derived.annual.high) + '/yr',
    });
  }
  const dep = report.depreciation_resale;
  if (dep && isNum(dep.resale_low) && isNum(dep.resale_high) && dep.resale_high > 0) {
    keyNumbers.push({
      label: `Worth at year ${derived.years || '?'}`,
      value: moneyRange(dep.resale_low, dep.resale_high),
    });
  }
  if (checksSummary) keyNumbers.push(checksSummary);
  if (report.recommendation && report.recommendation.verdict) {
    keyNumbers.push({ label: 'Recommendation', value: report.recommendation.verdict.toUpperCase() });
  }

  const checks = Array.isArray(report.must_have_checks) ? report.must_have_checks : [];
  const MARK = { confirmed: '✓', contradicted: '✗', unverified: '?' };

  const sections = [];
  // First, above the money. A deal-breaker the item fails is the most
  // important thing in the report and used to be a clause inside a
  // paragraph three screens down.
  if (checks.length) {
    sections.push({
      icon: '📋',
      title: 'Your must-haves, checked against the actual specification',
      items: checks.map((c) => `${MARK[c.verdict] || '?'} ${c.requirement} — ${c.finding}${
        nonEmpty(c.published_value) && c.verdict !== 'unverified' ? ` [published: ${c.published_value}]` : ''
      }${nonEmpty(c.source) ? ` (${c.source})` : ''}`),
    });
  }
  sections.push(
    {
      icon: '💰',
      title: 'True total cost of ownership',
      // Line items first, then the total they add up to, then the prose.
      // A customer who reads nothing else can still check the sum.
      items: derived.ranges
        .map(({ item: i, range }) => `${i.label} — ${moneyRange(range.low, range.high)}${
          i.kind === 'running' && derived.years ? ` (${moneyRange(i.per_year_low, i.per_year_high)}/yr)` : ''
        }${nonEmpty(i.basis) ? ` · ${i.basis}` : ''}`)
        .concat(derived.total
          ? [`Total over ${derived.years} year${derived.years === 1 ? '' : 's'} — ${moneyRange(derived.total.low, derived.total.high)}`]
          : [])
        .concat([tco.explanation].filter(Boolean)),
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
      // Its price and its total first, against the same numbers for the main
      // item, so the two are actually side by side.
      items: (() => {
        const alt = report.alternative_comparison || {};
        const rows = [];
        if (isNum(alt.alternative_price_low) && isNum(alt.alternative_price_high)) {
          rows.push(`Price — ${moneyRange(alt.alternative_price_low, alt.alternative_price_high)}`);
        }
        if (isNum(alt.alternative_total_low) && isNum(alt.alternative_total_high)) {
          rows.push(`Total over ${derived.years || '?'} year${derived.years === 1 ? '' : 's'} — ${moneyRange(alt.alternative_total_low, alt.alternative_total_high)}${
            derived.total ? ` (this one: ${moneyRange(derived.total.low, derived.total.high)})` : ''
          }`);
        }
        return rows.concat([alt.explanation].filter(Boolean));
      })(),
    },
    {
      icon: '✅',
      title: `Recommendation: ${report.recommendation ? report.recommendation.verdict.toUpperCase() : ''}`,
      items: [report.recommendation && report.recommendation.reasoning].filter(Boolean),
    }
  );

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

// The one trustworthy answer to "did research actually happen". Reads the
// response's own record of server-side tool calls rather than asking the
// model to report on itself.
function countSearchRounds(data) {
  const blocks = ((data && data.content) || []).filter(
    (b) => b && b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;
  const usage = data && data.usage && data.usage.server_tool_use;
  const reported = usage && isNum(usage.web_search_requests) ? usage.web_search_requests : 0;
  return Math.max(blocks, reported);
}

function looksLikeUnsupportedToolError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('web_search') || msg.includes('tool') && msg.includes('not') && (msg.includes('support') || msg.includes('enabled') || msg.includes('available'));
}

// One full attempt at getting a report out of the model: an initial call
// that may use web_search, and — only if the model didn't call our submit
// tool on that first turn (e.g. it searched and then just summarized in
// text) — exactly one forced follow-up call so this always terminates in a
// bounded number of requests. If the search-augmented call fails in a way that
// looks like the tool isn't available on this API key, this steps down —
// current tool version, then the legacy one, then no search at all —
// rather than failing the whole report over a feature that may simply not
// be enabled on the account.
//
// Returns the number of searches that actually ran alongside the report,
// because the model's own research_notes are not evidence: an empty list
// is equally consistent with "searched and found nothing worth noting" and
// with "never searched", and those need different handling from the
// caller. server_tool_use blocks in the response are the real signal.
async function runOneAttempt({ apiKey, systemPrompt, contentBlocks, allowSearch, searchTool }) {
  const baseMessages = [{ role: 'user', content: contentBlocks }];
  const activeSearchTool = searchTool || WEB_SEARCH_TOOL;
  const tools = allowSearch ? [activeSearchTool, REPORT_TOOL] : [REPORT_TOOL];

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
      if (activeSearchTool.type !== WEB_SEARCH_TOOL_LEGACY.type) {
        console.warn(
          `[purchase-engine] The ${activeSearchTool.type} server tool was rejected; retrying with ${WEB_SEARCH_TOOL_LEGACY.type} before giving up on live research. (${String((err && err.message) || err).slice(0, 200)})`
        );
        return runOneAttempt({ apiKey, systemPrompt, contentBlocks, allowSearch: true, searchTool: WEB_SEARCH_TOOL_LEGACY });
      }
      // Loud on purpose. buying.html tells the customer this analysis uses
      // live web research; dropping to knowledge-only is a downgrade of
      // what was sold, not a routine fallback, and it used to happen
      // without leaving a trace anywhere.
      console.warn(
        `[purchase-engine] No web_search variant is available on this API key — falling back to a knowledge-only report, which is less than buying.html promises. (${String((err && err.message) || err).slice(0, 200)})`
      );
      return runOneAttempt({ apiKey, systemPrompt, contentBlocks, allowSearch: false });
    }
    throw err;
  }

  const content = data.content || [];
  const searchRounds = countSearchRounds(data);
  let toolUse = content.find((b) => b.type === 'tool_use' && b.name === 'submit_purchase_report');
  if (toolUse) return { report: toolUse.input, searchRounds };

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
  // The follow-up carries no search tool, so any research came from the
  // first turn — count it from there.
  return { report: toolUse.input, searchRounds };
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
// How many whole-response malformations are forgiven without costing one of
// those attempts.
//
// One, not two. A forgiven retry is free of ATTEMPTS and not of money: it is
// still a full generation with extended thinking and its own searches. At two,
// a troubled submission made up to six paid calls instead of four, and on the
// night this was written that helped drain the account mid-run — 27 report
// attempts produced 8 reports and the balance ran out with three submissions
// unfinished. Forgiving one absorbs a single bad response without turning a
// bad night into a bill.
const MAX_MALFORMED_RETRIES = 1;
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
  //
  // The alert only fires if this submission already got its one automatic
  // background retry (see api/retry-failed-buying.js) and STILL failed —
  // not on this first, ordinary exhaustion. The customer doesn't need the
  // site owner paged for something the system is about to try fixing on
  // its own within minutes; paging them for something that's already
  // survived one full extra attempt and is genuinely stuck is the case
  // that actually needs a human.
  if ((submission.generation_attempts || 0) >= MAX_ATTEMPTS) {
    const admin2 = admin;
    const exhaustedError = `Report generation did not complete within ${MAX_ATTEMPTS} attempts (each attempt is time-limited to fit this deployment's serverless timeout).`;
    await admin2
      .from('navigator_submissions')
      .update({
        status: 'failed',
        error: exhaustedError,
        updated_at: new Date().toISOString(),
      })
      .eq('id', submissionId);
    if (submission.auto_recovery_attempted) {
      await sendFailureAlert({ submissionId, product: 'buying', error: exhaustedError });
    }
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

    // Before the report, not after it. The recommendation and its reasoning
    // depend on whether the item meets the customer's requirements, so a
    // report written first can only ever have that patched into it
    // afterwards — which is exactly what happened on submission a62f2dd1:
    // the verdict was corrected from "buy" to "reconsider" while the
    // reasoning underneath went on listing the failed deal-breaker as
    // satisfied and telling the customer to proceed. Ordering it this way
    // removes that whole class rather than repairing it.
    //
    // It is also cached on the row. Each attempt is its own invocation with
    // its own 300 seconds, and re-checking a specification that has not
    // changed spends part of that budget rediscovering the same answer — on
    // an attempt that only exists because the previous one ran out of time.
    let verificationIsFresh = false;
    let verification = readCachedVerification(submission);
    if (verification) {
      console.warn(
        `[purchase-engine] Reusing the must-have verification stored on submission ${submissionId} (${verification.checks.length} check(s), ${verification.searchRounds} search round(s)) rather than running it again.`
      );
    } else {
      try {
        verification = await verifyMustHaves({
          apiKey: ANTHROPIC_API_KEY,
          submission,
          submissionId,
          allowSearch: ENABLE_WEB_SEARCH,
        });
      } catch (err) {
        console.warn(`[purchase-engine] Must-have verification for submission ${submissionId} threw: ${String((err && err.message) || err)}`);
      }
      if (verification) {
        await cacheVerification(admin, submission, verification);
        // Set HERE, not by re-reading the cache afterwards — cacheVerification
        // has just written it, so a later read always says it was already
        // there and the hand-back below never fires.
        verificationIsFresh = true;
      }
    }
    const mustHaveChecks = (verification && verification.checks) || unverifiedChecks(submission);

    // A spec verdict is only as good as the lookup behind it. With no
    // searches on the verification call there was no lookup — whatever the
    // model believes about the product, it is remembering rather than
    // checking. Downgrading cannot invent a problem; it can only stop one
    // being ruled out on nothing.
    if (!verification || !verification.searchRounds) {
      const graded = mustHaveChecks.filter((c) => c && c.verdict !== 'unverified');
      if (graded.length) {
        console.warn(
          `[purchase-engine] Submission ${submissionId} graded ${graded.length} must-have(s) with no web_search behind them; downgrading to unverified.`
        );
        for (const check of graded) {
          check.verdict = 'unverified';
          check.source = 'not checked — no live lookup ran for this report';
          // The figures go with it. Leaving a measurement on a downgraded
          // check would let a later pass recompute the verdict this line
          // exists to take away.
          delete check.measurement;
          delete check.published_value;
        }
      }
    }
    if (mustHaveChecks.some((c) => c.verdict === 'contradicted')) {
      console.warn(
        `[purchase-engine] Submission ${submissionId} fails ${mustHaveChecks.filter((c) => c.verdict === 'contradicted').length} stated must-have(s); the report is being written with that as a given.`
      );
    }

    // Fresh verification means this invocation has already spent time on a
    // separate request. Hand back rather than start the report inside what is
    // left of the budget: the next poll is three seconds away and gets its own.
    // Only when it SUCCEEDED. A failed verification caches nothing, so
    // handing back would run it again on the next attempt, fail again, and
    // hand back again — the customer would poll forever. It cost little
    // when it failed, so the report proceeds here with the requirements
    // marked unchecked.
    if (verification && verificationIsFresh && mustHaveFragments(submission).length) {
      console.warn(
        `[purchase-engine] Verified ${mustHaveChecks.length} must-have(s) for submission ${submissionId}; handing back so the report gets an invocation of its own.`
      );
      await admin
        .from('navigator_submissions')
        .update({
          status: 'paid',
          // Not a failed attempt — nothing was attempted. Giving this one
          // back keeps MAX_ATTEMPTS meaning four tries at the report.
          generation_attempts: Math.max(0, attemptNumber - 1),
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', submissionId);
      return null;
    }

    const systemPrompt = buildSystemPrompt(submission, mustHaveChecks);

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
    let searchRounds = 0;
    let recoverableError = null;
    try {
      const attempt = await runOneAttempt({
        apiKey: ANTHROPIC_API_KEY,
        systemPrompt,
        contentBlocks,
        allowSearch: ENABLE_WEB_SEARCH,
      });
      candidate = attempt.report;
      searchRounds = attempt.searchRounds;
    } catch (err) {
      recoverableError = err;
    }

    if (candidate && !recoverableError) {
      // A nested object that arrived as a string is turned back into an
      // object here, before anything else reads it — otherwise the repairs
      // below spread a string and produce {0:'1',1:'2'}.
      const leakedKeys = [];
      for (const key of OBJECT_VALUED_FIELDS) {
        if (candidate[key] === undefined || candidate[key] === null) continue;
        if (typeof candidate[key] === 'object' && !Array.isArray(candidate[key])) continue;
        const salvaged = salvageLeakedObject(candidate[key]) || {};
        leakedKeys.push(key);
        console.warn(
          `[purchase-engine] ${key} arrived as a ${typeof candidate[key]} rather than an object for submission ${submissionId} on attempt ${attemptNumber}; recovered ${Object.keys(salvaged).length} field(s).`
        );
        candidate[key] = salvaged;
      }

      // One leaked object is a field to repair. Several at once is a
      // response that came back in tool-call syntax instead of JSON, and
      // there is nothing in it to repair: submission 87e1bc2b had all six
      // arrive as strings carrying one fragment each, so the salvage
      // recovered a sixth of each section and the repairs then spent two
      // more requests establishing that what was left was unusable. The
      // report took four attempts and twelve minutes.
      //
      // Asking again is the only move, so it is made immediately — and it
      // does not cost an attempt, because nothing was attempted. Bounded by
      // a counter on the row so a model stuck in this mode still terminates.
      if (leakedKeys.length >= 2) {
        const malformed = ((submission.job_state || {}).malformed_responses || 0) + 1;
        const spare = malformed <= MAX_MALFORMED_RETRIES;
        console.warn(
          `[purchase-engine] Submission ${submissionId} attempt ${attemptNumber}: ${leakedKeys.length} of ${OBJECT_VALUED_FIELDS.length} sections came back as tag text (${leakedKeys.join(', ')}). Nothing to repair; asking again${spare ? ' without spending an attempt' : ''}.`
        );
        await admin
          .from('navigator_submissions')
          .update({
            status: 'paid',
            generation_attempts: spare ? Math.max(0, attemptNumber - 1) : attemptNumber,
            job_state: { ...(submission.job_state || {}), malformed_responses: malformed },
            error: `The model returned ${leakedKeys.length} sections as tool-call text rather than a report; retrying.`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', submissionId);
        return null;
      }

      // The ownership period comes from the customer, not the model. Set
      // before any check reads it, and after the salvage so it survives one.
      if (!candidate.total_cost_of_ownership || typeof candidate.total_cost_of_ownership !== 'object') {
        candidate.total_cost_of_ownership = {};
      }
      candidate.total_cost_of_ownership.time_horizon_years = horizonYears(submission);

      // Always ensure a financing_impact object exists — even if the model
      // dropped the whole section, not just the applicable flag — so the
      // deterministic override below can run unconditionally. Real live
      // evidence (2026-09-01) showed the model sometimes omitting
      // financing_impact ENTIRELY (not just a bad applicable value within
      // an otherwise-present object), and the previous version of this
      // override only handled the latter case — it skipped entirely when
      // the whole section was missing, which meant every one of those
      // attempts fell straight to a full retry even though the ONLY
      // genuinely-model-dependent piece (the explanation sentence) is
      // exactly the kind of thing the repair mechanism above already
      // knows how to generate cheaply. Constructing the object here (with
      // applicable already correct) means a wholly-missing section is now
      // correctly reported as needing just 'financing_impact.explanation'
      // — a repairable field — instead of being misreported as an
      // unrepairable applicable problem.
      if (!candidate.financing_impact || typeof candidate.financing_impact !== 'object') {
        candidate.financing_impact = {};
      }
      candidate.financing_impact.applicable = !!(submission.form_data && submission.form_data.financing === 'financing');

      // assumptions and missing_or_uncertain are both explicitly allowed
      // to be genuinely empty (the schema permits `[]` when there's
      // nothing to add) — the completeness check only cares that they're
      // arrays at all, not that they contain anything. Live evidence
      // (2026-09-01) showed these occasionally coming back malformed as
      // part of the same broader leak pattern, on an attempt that had six
      // other fields corrupted at once. Since an empty array is always a
      // valid, honest answer for both, coercing a malformed value to []
      // needs no model call at all — cheaper and more reliable than the
      // API-based repair mechanism above, and closes the one remaining
      // required field it didn't cover.
      if (!Array.isArray(candidate.assumptions)) candidate.assumptions = [];
      if (!Array.isArray(candidate.missing_or_uncertain)) candidate.missing_or_uncertain = [];
      // Established before the report was written; carried onto it here.
      candidate.must_have_checks = mustHaveChecks;
      // The array shape is coerced here as before, but an EMPTY assumptions
      // list is no longer treated as a valid answer — see isReportComplete.
      // It now routes to repairAssumptions instead of shipping a total whose
      // inputs the customer cannot see.

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
      } else if (!isReportComplete(candidate, submission)) {
        // A LOOP, not a single check: live evidence (2026-08-31/09-01)
        // showed a single response can have several repairable problems
        // at once — up to four explanation fields empty in the same
        // attempt, plus (separately) the compound alternative_comparison/
        // recommendation sections hitting the identical failure mode.
        // Repairing only the first found field left the report still
        // incomplete and fell through to a full retry even when every
        // problem was individually repairable. Bounded by the total
        // number of known repairable fields, so this can never loop
        // indefinitely — each successful repair fixes a specific,
        // different field, so the loop can only run that many times
        // before either completing or hitting something it can't repair.
        // +2 for the two numeric repairs (cost model, assumptions), which
        // are labelled by firstIncompleteField rather than living in either
        // of the two REPAIRABLE_* maps.
        const maxRepairRounds = Object.keys(REPAIRABLE_EXPLANATION_FIELDS).length + Object.keys(REPAIRABLE_COMPOUND_FIELDS).length + 4;
        for (let round = 0; round < maxRepairRounds && !isReportComplete(candidate, submission); round++) {
          const emptyField = firstIncompleteField(candidate, submission);
          if (emptyField === 'total_cost_of_ownership.cost_model' || emptyField === 'total_cost_of_ownership.arithmetic') {
            const problem = tcoArithmeticProblem(candidate);
            let patched = null;
            try {
              patched = await repairCostModel({ apiKey: ANTHROPIC_API_KEY, systemPrompt: buildRepairSystemPrompt(submission, mustHaveChecks), candidate, submissionId, problem });
            } catch (err) {
              console.warn(`[purchase-engine] Cost-model repair for submission ${submissionId} threw: ${String((err && err.message) || err)}`);
              patched = null;
            }
            if (!patched) break;
            candidate = patched;
            console.warn(
              `[purchase-engine] Rebuilt the cost model for submission ${submissionId} on attempt ${attemptNumber}${problem ? ` — the report contradicted itself: ${problem}` : ' — the breakdown was unusable'}`
            );
            continue;
          }
          if (emptyField === 'total_cost_of_ownership.prose') {
            const conflicts = proseTotalConflicts(candidate);
            let patched = null;
            try {
              patched = await repairProseTotals({ apiKey: ANTHROPIC_API_KEY, systemPrompt: buildRepairSystemPrompt(submission, mustHaveChecks), candidate, submissionId, conflicts });
            } catch (err) {
              console.warn(`[purchase-engine] Prose-total repair for submission ${submissionId} threw: ${String((err && err.message) || err)}`);
              patched = null;
            }
            if (!patched) break;
            candidate = patched;
            console.warn(
              `[purchase-engine] Corrected a total quoted in prose for submission ${submissionId} on attempt ${attemptNumber}: ${conflicts.map((c) => c.label + ' said ' + c.quoted).join('; ')}`
            );
            continue;
          }
          if (emptyField === 'must_have_checks') {
            const problem = mustHaveProblem(candidate, submission);
            let patched = null;
            try {
              patched = await repairMustHaveChecks({ apiKey: ANTHROPIC_API_KEY, systemPrompt: buildRepairSystemPrompt(submission, mustHaveChecks), candidate, submission, submissionId, problem });
            } catch (err) {
              console.warn(`[purchase-engine] Must-have repair for submission ${submissionId} threw: ${String((err && err.message) || err)}`);
              patched = null;
            }
            if (!patched) break;
            candidate = patched;
            console.warn(`[purchase-engine] Re-checked the customer's must-haves for submission ${submissionId} on attempt ${attemptNumber}: ${problem}`);
            continue;
          }
          if (emptyField === 'assumptions') {
            let repairedList = null;
            try {
              repairedList = await repairAssumptions({ apiKey: ANTHROPIC_API_KEY, systemPrompt: buildRepairSystemPrompt(submission, mustHaveChecks), candidate, submissionId });
            } catch (err) {
              console.warn(`[purchase-engine] Assumptions repair for submission ${submissionId} threw: ${String((err && err.message) || err)}`);
              repairedList = null;
            }
            if (!repairedList) break;
            candidate.assumptions = repairedList;
            console.warn(`[purchase-engine] Refilled an empty assumptions list for submission ${submissionId} on attempt ${attemptNumber}.`);
            continue;
          }
          if (REPAIRABLE_COMPOUND_FIELDS[emptyField]) {
            let repaired = null;
            try {
              repaired = await repairCompoundField({ apiKey: ANTHROPIC_API_KEY, systemPrompt: buildRepairSystemPrompt(submission, mustHaveChecks), candidate, sectionKey: emptyField, submissionId });
            } catch (err) {
              console.warn(`[purchase-engine] Compound repair call for submission ${submissionId} (${emptyField}) threw: ${String((err && err.message) || err)}`);
              repaired = null;
            }
            if (!repaired) break; // a failed repair stops the loop — falls through to a full retry below
            candidate[emptyField] = { ...candidate[emptyField], ...repaired };
            console.warn(
              `[purchase-engine] Repaired empty field "${emptyField}" for submission ${submissionId} on attempt ${attemptNumber} via a targeted follow-up instead of spending a full retry.`
            );
            continue;
          }
          const meta = REPAIRABLE_EXPLANATION_FIELDS[emptyField];
          if (!meta) break; // not a field this mechanism knows how to repair
          let repairedValue = null;
          try {
            repairedValue = await repairExplanationField({ apiKey: ANTHROPIC_API_KEY, systemPrompt: buildRepairSystemPrompt(submission, mustHaveChecks), candidate, fieldPath: emptyField, submissionId });
          } catch (err) {
            console.warn(`[purchase-engine] Repair call for submission ${submissionId} (${emptyField}) threw: ${String((err && err.message) || err)}`);
            repairedValue = null;
          }
          if (!repairedValue) break; // a failed repair stops the loop — falls through to a full retry below
          candidate[meta.section] = { ...candidate[meta.section], explanation: repairedValue };
          console.warn(
            `[purchase-engine] Repaired empty field "${emptyField}" for submission ${submissionId} on attempt ${attemptNumber} via a targeted follow-up instead of spending a full retry.`
          );
        }
        if (!isReportComplete(candidate, submission)) {
          const emptyField = firstIncompleteField(candidate, submission);
          recoverableError = new Error(
            wasContaminated
              ? `Missing required field "${emptyField}" — was emptied by stripping a leaked formatting artifact that was its entire content`
              : `Missing required field "${emptyField}"`
          );
        }
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

    // buying.html's FAQ tells the customer this analysis "uses live web
    // research where it can sharpen a figure". When none ran, the report
    // says so instead of leaving the customer to assume it did — and any
    // research_notes the model wrote anyway are dropped, since with zero
    // server_tool_use blocks in the response they cannot describe research
    // that happened.
    //
    // searchRounds counts the REPORT call's searches only. The must-have
    // verification is a separate request with its own searching, and on
    // submission 2a2b3a24 it succeeded — the spec checks cite Peloton's own
    // product pages three times — while the report call searched seven times,
    // hit its usage limit and reported finding nothing it relied on. Both
    // things were true, and the disclaimer said "the web searches run for
    // this report did not turn up anything", which reads as covering the
    // whole page including the citations directly above it. It is scoped to
    // the figures it actually describes now, and says so when the
    // specification was looked up separately.
    const specWasLookedUp = (mustHaveChecks || []).some((c) => c && c.verdict !== 'unverified');
    const specNote = specWasLookedUp
      ? ' Your must-haves were checked separately and cite what they were checked against.'
      : '';
    if (!searchRounds) {
      console.warn(
        `[purchase-engine] Submission ${submissionId} produced a report with zero web_search rounds${ENABLE_WEB_SEARCH ? '' : ' (search disabled by PURCHASE_NAVIGATOR_DISABLE_WEB_SEARCH)'}.`
      );
      report.research_notes = [];
      const note = 'No live research ran behind the cost figures in this report, so they are directional estimates built from general knowledge and the details you supplied rather than verified current prices or rates.' + specNote;
      if (!report.missing_or_uncertain.includes(note)) report.missing_or_uncertain.unshift(note);
    } else if (!Array.isArray(report.research_notes) || !report.research_notes.length) {
      console.warn(
        `[purchase-engine] Submission ${submissionId} ran ${searchRounds} web_search round(s) but returned no research_notes; asking for them rather than dropping the research section.`
      );
      let notes = null;
      try {
        notes = await repairResearchNotes({ apiKey: ANTHROPIC_API_KEY, systemPrompt: buildRepairSystemPrompt(submission, mustHaveChecks), candidate: report, submissionId, searchRounds });
      } catch (err) {
        console.warn(`[purchase-engine] Research-notes repair for submission ${submissionId} threw: ${String((err && err.message) || err)}`);
      }
      if (notes && notes.notes) {
        report.research_notes = notes.notes;
      } else if (notes && notes.foundNothing) {
        // The searches ran and came back empty-handed. Say that, rather
        // than either inventing a research section or silently implying
        // the figures are better sourced than they are.
        report.missing_or_uncertain.unshift(
          'The searches run for the cost figures did not turn up anything that sharpened them, so those numbers rest on general knowledge and the details you supplied rather than verified current listings.' + specNote
        );
      } else {
        // Not a reason to fail an otherwise-good report, but the customer
        // should not be left assuming a section they paid for is missing
        // because nothing was found.
        report.missing_or_uncertain.push('The research behind the cost figures could not be summarised for this report. The numbers were researched; the notes on what was found did not survive.' + specNote);
      }
    }

    const unverified = (report.must_have_checks || []).filter((c) => c && c.verdict === 'unverified');
    for (const check of unverified) {
      report.missing_or_uncertain.push(
        `Whether this item meets "${check.requirement}" could not be verified here — check the manufacturer's specification before buying.`
      );
    }

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
    const errorMessage = String(err.message || err).slice(0, 500);
    await admin
      .from('navigator_submissions')
      .update({ status: 'failed', error: errorMessage, updated_at: new Date().toISOString() })
      .eq('id', submissionId);
    if (submission.auto_recovery_attempted) {
      await sendFailureAlert({ submissionId, product: 'buying', error: errorMessage });
    }
    throw err;
  }
}

module.exports = {
  generatePurchaseReport,
  // Exported for unit testing without hitting the network or Supabase.
  __internal: {
    buildSystemPrompt,
    buildRepairSystemPrompt,
    buildIntakeBrief,
    isReportComplete,
    firstIncompleteField,
    mapToGenericReport,
    reportLooksContaminated,
    sanitizeReportTags,
    repairExplanationField,
    REPAIRABLE_EXPLANATION_FIELDS,
    FIELD_REPAIR_TOOL,
    repairCompoundField,
    REPAIRABLE_COMPOUND_FIELDS,
    runOneAttempt,
    countSearchRounds,
    validBreakdown,
    sumBreakdown,
    tcoArithmeticProblem,
    resaleProblem,
    proseTotalConflicts,
    proseResaleConflict,
    proseRunningConflict,
    proseComponentConflict,
    lineRanges,
    itemRange,
    proseFigureMatches,
    repairProseTotals,
    deriveNumbers,
    money,
    moneyRange,
    repairCostModel,
    repairAssumptions,
    repairResearchNotes,
    repairMustHaveChecks,
    verdictFromMeasurement,
    applyMeasuredVerdicts,
    MAX_MALFORMED_RETRIES,
    verifyMustHaves,
    readCachedVerification,
    unverifiedChecks,
    salvageLeakedObject,
    horizonYears,
    MUST_HAVE_TOOL,
    mustHaveProblem,
    mustHaveFragments,
    MUST_HAVE_REPAIR_TOOL,
    COST_MODEL_REPAIR_TOOL,
    ASSUMPTIONS_REPAIR_TOOL,
    REPORT_TOOL,
    WEB_SEARCH_TOOL,
    WEB_SEARCH_TOOL_LEGACY,
    MAX_ATTEMPTS,
  },
};
