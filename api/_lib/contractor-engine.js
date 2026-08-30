// Contractor Navigator's actual analysis engine — the one product (of the
// ten described in the project blueprint) wired up to a real AI pipeline
// end-to-end. See the blueprint, section 7 ("Recommended First Expansion:
// Contractor Navigator") for the exact output this is trying to produce:
// is the price reasonable, are quotes apples-to-apples, what's missing,
// what could become a change order, what to ask, what to negotiate, which
// quote is strongest and why, plus a ready-to-send contractor email.
//
// Called from two places:
//   - api/get-navigator-submission.js, the first time a paid contractor
//     submission is polled with no report yet (lazy trigger — keeps the
//     Stripe webhook itself fast and simple, matching the existing
//     api/stripe-webhook.js style).
//   - api/generate-contractor-report.js, an admin-only endpoint for
//     testing this pipeline before real Stripe Payment Links are wired up.
//
// Requires an ANTHROPIC_API_KEY environment variable (Vercel Project
// Settings -> Environment Variables), the same way STRIPE_SECRET_KEY and
// SUPABASE_SERVICE_ROLE_KEY are already configured for this project. Get a
// key at console.anthropic.com -> API Keys. Nothing here ever sends that
// key to the browser.

const { getSupabaseAdmin } = require('./supabaseAdmin');

const ANTHROPIC_MODEL = 'claude-sonnet-5';

const REPORT_TOOL = {
  name: 'submit_contractor_report',
  description: 'Submit the structured Contractor Navigator report for this estimate (or set of competing estimates).',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Best-fit category for this job.',
        enum: ['HVAC', 'Roofing', 'Windows', 'Plumbing', 'Electrical', 'Other'],
      },
      summary: {
        type: 'string',
        description: 'A 2-4 sentence plain-English summary of the job and the bottom line for the homeowner.',
      },
      quotes: {
        type: 'array',
        description: 'One entry per estimate document provided.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'e.g. "Quote 1" or the contractor/company name if legible.' },
            contractor_name: { type: 'string' },
            total_price: { type: 'string', description: 'e.g. "$8,450" — as written or your best estimate.' },
            scope_summary: { type: 'string', description: 'What this quote actually includes, in plain English.' },
          },
          required: ['label'],
        },
      },
      price_assessment: {
        type: 'object',
        properties: {
          verdict: {
            type: 'string',
            enum: ['reasonable', 'on the high side', 'on the low side (watch for corner-cutting)', 'unclear — needs a local comp'],
          },
          explanation: { type: 'string', description: 'Why, referencing typical ranges for this category and region if known.' },
        },
        required: ['verdict', 'explanation'],
      },
      apples_to_apples: {
        type: 'object',
        description: 'Only meaningful with 2+ quotes — otherwise explain what would be needed to compare.',
        properties: {
          verdict: { type: 'string' },
          explanation: { type: 'string' },
        },
      },
      missing_or_unclear_items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Scope, equipment, warranty, permit, or line-item gaps a homeowner should notice.',
      },
      potential_change_orders: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific things likely to turn into a change order once work starts.',
      },
      questions_to_ask: {
        type: 'array',
        items: { type: 'string' },
      },
      negotiation_points: {
        type: 'array',
        items: { type: 'string' },
      },
      strongest_quote: {
        type: 'object',
        description: 'Only when 2+ quotes were provided.',
        properties: {
          which: { type: 'string' },
          why: { type: 'string' },
        },
      },
      negotiation_email: {
        type: 'string',
        description: 'A complete, ready-to-send email to the contractor(s) — polite but specific, referencing the questions/negotiation points above.',
      },
    },
    required: [
      'category', 'summary', 'price_assessment', 'missing_or_unclear_items',
      'potential_change_orders', 'questions_to_ask', 'negotiation_points', 'negotiation_email',
    ],
  },
};

const SYSTEM_PROMPT = `You are the analysis engine behind Contractor Navigator, a StreamNavigator AI product. \
A homeowner is about to spend real money on a home-repair or home-improvement estimate and has paid for a \
second opinion before signing. You are shown one or more contractor estimate documents (photos or PDFs) plus \
whatever context the homeowner typed in.

Do exactly what a sharp, independent, non-commissioned expert would do:
- Read the actual scope, equipment/materials, labor, and pricing in each document.
- Judge whether the price looks reasonable for the category and (if stated) region — say so plainly, and say \
when you can't be sure without a local comp rather than guessing with false confidence.
- If there are multiple quotes, compare them on an apples-to-apples basis: same scope, same equipment tier, \
same warranty terms — call out where they are NOT comparable.
- Flag anything missing, vague, or likely to become a change order.
- Write specific, homeowner-usable questions and negotiation points — not generic advice.
- Write a complete, ready-to-send email to the contractor(s) that a homeowner could copy and paste as-is.

Be direct and specific. Never invent numbers or contractor names that aren't in the documents — if something \
isn't legible or stated, say so instead of guessing. You have no financial stake in any contractor being \
chosen; your only job is protecting the homeowner from overpaying or being surprised later.

Respond ONLY by calling the submit_contractor_report tool.`;

function guessMediaType(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

async function generateContractorReport(submissionId) {
  const admin = getSupabaseAdmin();

  const { data: submission, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('*')
    .eq('id', submissionId)
    .single();

  if (fetchError || !submission) throw new Error('Submission not found');
  if (submission.product !== 'contractor') throw new Error('Not a contractor submission');

  await admin
    .from('navigator_submissions')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', submissionId);

  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY env var');

    const filePaths = submission.file_paths || [];
    if (!filePaths.length) throw new Error('No estimate files were attached to this submission');

    const contentBlocks = [];
    for (const path of filePaths) {
      const { data: fileBlob, error: downloadError } = await admin.storage
        .from('navigator-uploads')
        .download(path);
      if (downloadError || !fileBlob) continue;
      const arrayBuffer = await fileBlob.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mediaType = guessMediaType(path);
      if (mediaType === 'application/pdf') {
        contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } });
      } else {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
      }
    }
    if (!contentBlocks.length) throw new Error('Could not read any of the attached estimate files');

    const formData = submission.form_data || {};
    const contextLines = [
      formData.category ? `Homeowner-selected category: ${formData.category}` : null,
      formData.description ? `Homeowner's description of the job: ${formData.description}` : null,
      formData.zip ? `Location (ZIP): ${formData.zip}` : null,
      `Number of estimate documents attached: ${contentBlocks.length}`,
    ].filter(Boolean).join('\n');

    contentBlocks.push({ type: 'text', text: contextLines || 'No additional context was provided.' });

    // Occasionally the model's structured tool-call output gets corrupted —
    // observed in testing (on the generalized navigator-engine.js, which
    // shares this exact call pattern) as a stray closing tag / parameter
    // fragment (e.g. "</summary>\n<parameter name=\"key_numbers\">...")
    // leaking into a text field instead of populating the real field. The
    // JSON still parses fine, so a plain JSON.parse check wouldn't catch
    // it — it would silently ship a garbled-looking report to a paying
    // customer. Detect it and retry the whole generation once before
    // giving up.
    const TAG_LEAK_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9_-]*(\s[^>]*)?>/;
    function reportLooksContaminated(value) {
      if (typeof value === 'string') return TAG_LEAK_PATTERN.test(value);
      if (Array.isArray(value)) return value.some(reportLooksContaminated);
      if (value && typeof value === 'object') return Object.values(value).some(reportLooksContaminated);
      return false;
    }

    const MAX_ATTEMPTS = 2;
    let report = null;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !report; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: [REPORT_TOOL],
          tool_choice: { type: 'tool', name: 'submit_contractor_report' },
          messages: [{ role: 'user', content: contentBlocks }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 500)}`);
      }

      const data = await response.json();
      const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_contractor_report');
      if (!toolUse) {
        lastError = new Error('Model did not return a structured report');
        continue;
      }

      if (reportLooksContaminated(toolUse.input)) {
        lastError = new Error('Model output contained malformed/leaked formatting artifacts');
        continue;
      }

      report = toolUse.input;
    }

    if (!report) throw lastError || new Error('Failed to generate a valid report after retrying');

    await admin.from('contractor_reports').insert({
      submission_id: submissionId,
      report_json: report,
      negotiation_email: report.negotiation_email || null,
      model: ANTHROPIC_MODEL,
    });

    await admin
      .from('navigator_submissions')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
      .eq('id', submissionId);

    return report;
  } catch (err) {
    await admin
      .from('navigator_submissions')
      .update({ status: 'failed', error: String(err.message || err).slice(0, 500), updated_at: new Date().toISOString() })
      .eq('id', submissionId);
    throw err;
  }
}

module.exports = { generateContractorReport };
