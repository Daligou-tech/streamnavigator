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

function reportLooksContaminated(value, hits) {
  const TAG_LEAK_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9_-]*(\s[^>]*)?>/g;
  if (typeof value === 'string') {
    const matches = value.match(TAG_LEAK_PATTERN);
    if (matches && hits) hits.push(...matches);
    return !!matches;
  }
  if (Array.isArray(value)) return value.some((v) => reportLooksContaminated(v, hits));
  if (value && typeof value === 'object') return Object.values(value).some((v) => reportLooksContaminated(v, hits));
  return false;
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

async function callAnthropic({ apiKey, system, tools, toolChoice, messages, maxTokens }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens || 4096,
      system,
      tools,
      tool_choice: toolChoice,
      messages,
    }),
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
      maxTokens: 8000,
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
  // bounded follow-up instead of looping indefinitely.
  const followMessages = baseMessages.concat([
    { role: 'assistant', content },
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

async function generatePurchaseReport(submissionId) {
  const admin = getSupabaseAdmin();

  const { data: submission, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('*')
    .eq('id', submissionId)
    .single();

  if (fetchError || !submission) throw new Error('Submission not found');
  if (submission.product !== 'buying') throw new Error('Not a Purchase Navigator submission');

  await admin
    .from('navigator_submissions')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
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

    const MAX_ATTEMPTS = 2;
    let report = null;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !report; attempt++) {
      let candidate;
      try {
        candidate = await runOneAttempt({
          apiKey: ANTHROPIC_API_KEY,
          systemPrompt,
          contentBlocks,
          allowSearch: ENABLE_WEB_SEARCH,
        });
      } catch (err) {
        lastError = err;
        continue;
      }

      const contaminationHits = [];
      if (reportLooksContaminated(candidate, contaminationHits)) {
        lastError = new Error(`Model output contained malformed/leaked formatting artifacts: ${JSON.stringify(contaminationHits.slice(0, 5))}`);
        continue;
      }
      if (!isReportComplete(candidate)) {
        lastError = new Error('Model output was missing one or more of the six required report sections');
        continue;
      }
      report = candidate;
    }

    if (!report) throw lastError || new Error('Failed to generate a complete report after retrying');

    const genericReport = mapToGenericReport(report);

    await admin.from('navigator_reports').insert({
      submission_id: submissionId,
      product: 'buying',
      report_json: genericReport,
      model: ANTHROPIC_MODEL,
    });

    await admin
      .from('navigator_submissions')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
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
    mapToGenericReport,
    reportLooksContaminated,
    runOneAttempt,
    REPORT_TOOL,
    WEB_SEARCH_TOOL,
  },
};
