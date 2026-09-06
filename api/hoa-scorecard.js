// Free HOA Reserve Health Check.
//
// Mirrors the free pre-payment scorecard that already fronts Closing
// Navigator (api/closing-scorecard.js): show a real, cited result first, then
// ask for money. The two nearest competitors both give a buyer their first
// report free; this product was asking $79 from an unknown brand before the
// customer had seen anything at all.
//
// WHAT THE FREE CHECK READS: exactly two documents — the reserve study and
// the budget. Not a design compromise, three deliberate reasons:
//
//   * Cost. This endpoint is unauthenticated and pre-payment. A full package
//     is 200+ pages and roughly a dollar of model input per run; two
//     documents is a fraction of that, and the rate limits below bound the
//     rest.
//   * Availability. Those two are in essentially every resale package in
//     every state, so the free check works for everyone rather than only for
//     buyers whose seller was generous.
//   * It teaches. Naming the two documents that matter most is useful to a
//     buyer even if they never pay.
//
// WHAT IT DELIBERATELY WITHHOLDS: per-unit exposure, every concern after the
// first, the questions to send the HOA, and the pre-contingency checklist.
//
// A buyer may attach the rest of their package at the same time. Those files
// are stored on the submission but not read by the free check, which does two
// things: the "we have not read these" line becomes a fact about their actual
// documents rather than a marketing line, and paying converts THIS submission
// rather than starting a new one — so nobody re-uploads a 30MB reserve study
// to buy the report. The Stripe webhook flips this same row to 'paid' and the
// job worker then reads everything attached to it.

'use strict';

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { checkScorecardRateLimit, hashIp, clientIp, LIMITS } = require('./_lib/rate-limit');
const { isStagingPath, MAX_DIRECT_FILE_BYTES } = require('./_lib/upload-limits');
const {
  runToCompletion,
  harvestCitations,
  displayName,
  guessMediaType,
  HOA_MODEL,
  HOA_RUBRIC,
  HONESTY_RULES,
} = require('./_lib/hoa-engine');

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;
const { toFile } = AnthropicSDK;

// Tighter than the Closing scorecard's. A reserve study is a much larger
// document than a Closing Disclosure, so each free HOA check costs several
// times more to run. Worst case at these numbers is a bounded daily spend
// rather than an open tab.
const HOA_SCORECARD_LIMITS = {
  EMAIL_PER_HOUR: 3,
  EMAIL_PER_DAY: 6,
  IP_PER_HOUR: 6,
  IP_PER_DAY: 12,
  GLOBAL_PER_DAY: 80,
};

// One pass, so effort is lower than the paid report's xhigh. The figures it
// produces are arithmetic the code execution tool does exactly, not judgement
// calls, so the depth that matters for the paid analysis is not needed here.
const SCORECARD_EFFORT = 'medium';
const MAX_TOKENS = 16000;
const MAX_DOCS = 2;

// What a resale package is required to contain in Virginia, and largely in
// Maryland and DC. Returned to the customer as a checklist of what to make
// sure they have, which is useful to them whether or not they ever pay.
const RESALE_PACKAGE_ITEMS = [
  'Reserve study',
  'Current budget',
  'Financial statements',
  'Board meeting minutes',
  'Insurance summary or declarations page',
  'Special assessment and capital expenditure disclosure',
  'Litigation disclosure',
  'CC&Rs, bylaws and rules',
];

// Files beyond the two the free check reads are stored on the submission and
// analysed only if the customer buys the report.
const MAX_EXTRA_DOCS = 10;

const SCORECARD_TOOL_NAME = 'submit_reserve_health_check';

const SCORECARD_TOOL = {
  name: SCORECARD_TOOL_NAME,
  description: 'Submit the free reserve health check for this association.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      headline: {
        type: 'string',
        description: 'One sentence a homebuyer would understand, stating the single most important thing these two documents show. No jargon.',
      },
      percent_funded: {
        type: 'string',
        description: 'Reserve balance divided by fully funded balance, as a percentage string like "32%". Empty string if the documents do not support the calculation — never guess it.',
      },
      percent_funded_basis: {
        type: 'string',
        description: 'What that percentage was computed from, or why it cannot be computed. Say explicitly when the fully funded balance is your own calculation rather than stated.',
      },
      band: {
        type: 'string',
        enum: ['Weak', 'Fair', 'Strong', 'Cannot assess'],
        description: 'Below ~30% funded is Weak, ~30-70% Fair, above ~70% Strong.',
      },
      reserve_balance: { type: 'string', description: 'Plain dollar string, or empty.' },
      fully_funded_balance: { type: 'string', description: 'Plain dollar string, or empty.' },
      annual_contribution: { type: 'string', description: 'What the budget actually funds per year, or empty.' },
      recommended_contribution: { type: 'string', description: 'What the reserve study recommends per year, or empty.' },
      funding_gap: {
        type: 'string',
        description: 'The difference between recommended and actual as a plain sentence including the shortfall, or empty if either figure is missing.',
      },
      units: { type: 'string', description: 'Unit count if determinable, else empty.' },
      largest_project: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          year: { type: 'string' },
          cost: { type: 'string' },
          per_unit: { type: 'string', description: 'Cost divided by units, as a bare dollar figure like "$10,682". Do not include the words "per unit" — the page adds that label itself.' },
        },
        required: ['name', 'year', 'cost', 'per_unit'],
      },
      top_concern: {
        type: 'object',
        additionalProperties: false,
        description: 'The single most important concern visible in these two documents. Shown free.',
        properties: {
          concern: { type: 'string' },
          detail: { type: 'string', description: 'Two or three sentences a homebuyer would understand.' },
        },
        required: ['concern', 'detail'],
      },
      further_concern_count: {
        type: 'integer',
        description: 'How many ADDITIONAL concerns you can see in these two documents beyond top_concern. Count honestly — 0 if there genuinely are none. Do not inflate it.',
      },
      quote: {
        type: 'string',
        description: 'One short line copied EXACTLY from one of the documents that most directly supports the percent funded or the funding gap. Checked against the source and discarded if it does not match.',
      },
    },
    required: [
      'headline', 'percent_funded', 'percent_funded_basis', 'band',
      'reserve_balance', 'fully_funded_balance', 'annual_contribution',
      'recommended_contribution', 'funding_gap', 'units', 'largest_project',
      'top_concern', 'further_concern_count', 'quote',
    ],
  },
};

const SYSTEM = `You are producing a FREE reserve health check for a homebuyer who is inside their HOA contingency period — often only three days long. They have given you at most two documents: a reserve study and a budget.

This is a free sample of a paid report. It must be genuinely useful on its own and completely honest. It must never overstate risk to sell the paid version, and it must never manufacture a concern that is not in these documents. If the association looks healthy, say so plainly — that is a real and valuable answer for a buyer.

${HOA_RUBRIC}

${HONESTY_RULES}

WHAT TO DO

Work out the reserve position: percent funded, what the budget actually contributes against what the study recommends, and the largest capital project ahead with its per-unit share. Use the code execution tool for every calculation — do not do arithmetic in your head. If the fully funded balance is not stated, you may derive it, but say that you did.

Then name the single most important concern these two documents show, and count honestly how many further concerns you can see. That count is shown to the customer as a number only.

BEFORE calling the tool, write two or three sentences quoting the exact lines you used for the reserve figures. Citations are enabled on the documents, so quoting attaches a verifiable source to this check — without it the customer has no way to confirm the numbers are real. Then call ${SCORECARD_TOOL_NAME}.`;

function normalize(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  body = body || {};

  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'That email address doesn’t look right.' });
    return;
  }

  const uploadedPaths = Array.isArray(body.uploadedPaths)
    ? body.uploadedPaths.filter((p) => typeof p === 'string').slice(0, MAX_DOCS)
    : [];

  if (!uploadedPaths.length) {
    res.status(400).json({ ok: false, error: 'Attach your reserve study to run the free check.' });
    return;
  }
  if (uploadedPaths.some((p) => !isStagingPath(p))) {
    res.status(400).json({ ok: false, error: 'One of those uploads could not be verified. Please re-attach your files.' });
    return;
  }

  // Stored on the submission, not read by the free check.
  const extraPaths = Array.isArray(body.extraPaths)
    ? body.extraPaths.filter((p) => typeof p === 'string').slice(0, MAX_EXTRA_DOCS)
    : [];
  if (extraPaths.some((p) => !isStagingPath(p))) {
    res.status(400).json({ ok: false, error: 'One of those uploads could not be verified. Please re-attach your files.' });
    return;
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ ok: false, error: 'The free check is temporarily unavailable. Please try again shortly.' });
    return;
  }

  const admin = getSupabaseAdmin();

  // Checked before the row is inserted and before the model is called, so a
  // blocked request costs nothing and leaves no record to inflate the next
  // count.
  const ipHash = hashIp(clientIp(req));
  const limit = await checkScorecardRateLimit(
    admin,
    { email: email || null, ipHash, product: 'hoa' },
    Object.assign({}, LIMITS, HOA_SCORECARD_LIMITS),
  );
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterMinutes * 60));
    res.status(429).json({ ok: false, error: limit.message });
    return;
  }

  const { data: submission, error: insertError } = await admin
    .from('navigator_submissions')
    .insert({
      product: 'hoa',
      email: email || null,
      // stage:'scorecard' keeps this row out of the paid pipeline. The HOA
      // job worker only claims rows at status 'paid', and this row stays at
      // its default, so the cron will never pick it up and bill for it.
      form_data: { stage: 'scorecard', ip_hash: ipHash },
    })
    .select('id, access_token')
    .single();

  if (insertError || !submission) {
    res.status(500).json({ ok: false, error: 'Could not save your submission. Please try again.' });
    return;
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const uploadedFileIds = [];
  const filePaths = [];

  try {
    // Claims a staged upload onto this submission. Everything the customer
    // attached is claimed, including the files the free check will not read —
    // they are what the paid report analyses if this submission is bought.
    async function claim(stagedPath) {
      const objectName = stagedPath.slice(stagedPath.lastIndexOf('/') + 1);
      const originalName = objectName.split('__').slice(1).join('__') || objectName;
      const destination = `hoa/${submission.id}/${Date.now()}-${originalName}`;
      const { error: moveError } = await admin.storage
        .from('navigator-uploads')
        .move(stagedPath, destination);
      if (moveError) return null;
      filePaths.push(destination);
      return { destination, originalName };
    }

    const notAnalysed = [];
    for (const stagedPath of extraPaths) {
      const claimed = await claim(stagedPath);
      if (claimed) notAnalysed.push(displayName(claimed.destination));
    }

    const documentBlocks = [];
    for (const stagedPath of uploadedPaths) {
      const claimed = await claim(stagedPath);
      if (!claimed) continue;
      const { destination, originalName } = claimed;

      const { data: blob, error: downloadError } = await admin.storage
        .from('navigator-uploads')
        .download(destination);
      if (downloadError || !blob) continue;

      const buffer = Buffer.from(await blob.arrayBuffer());
      if (buffer.length > MAX_DIRECT_FILE_BYTES) continue;

      const mediaType = guessMediaType(destination);
      const title = displayName(destination);
      const uploaded = await client.files.upload({
        file: await toFile(buffer, originalName, { type: mediaType }),
      });
      uploadedFileIds.push(uploaded.id);

      documentBlocks.push(
        mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'file', file_id: uploaded.id }, title, citations: { enabled: true } }
          : { type: 'image', source: { type: 'file', file_id: uploaded.id } },
      );
    }

    if (filePaths.length) {
      await admin
        .from('navigator_submissions')
        .update({ file_paths: filePaths, updated_at: new Date().toISOString() })
        .eq('id', submission.id);
    }

    if (!documentBlocks.length) {
      res.status(400).json({ ok: false, error: 'Could not read those documents. Try the original PDF rather than a photo of it.' });
      return;
    }

    const { toolInput, response } = await runToCompletion(client, {
      system: SYSTEM,
      maxTokens: MAX_TOKENS,
      effort: SCORECARD_EFFORT,
      tools: [
        { type: 'code_execution_20260521', name: 'code_execution' },
        SCORECARD_TOOL,
      ],
      expectToolName: SCORECARD_TOOL_NAME,
      messages: [{
        role: 'user',
        content: [
          ...documentBlocks,
          {
            type: 'text',
            text: `Documents provided for this free check: ${filePaths.map(displayName).join(', ')}.`,
          },
        ],
      }],
    });

    const evidence = harvestCitations(response.content);

    // Same guarantee as the paid report: a quote the model wrote is only
    // shown if it appears verbatim in text the citation system returned.
    const scorecard = toolInput || {};
    const haystack = evidence.map((c) => normalize(c.cited_text)).join('   ');
    const needle = normalize(scorecard.quote);
    const quoteVerified = Boolean(needle) && haystack.includes(needle);
    if (!quoteVerified) scorecard.quote = '';

    await admin
      .from('navigator_submissions')
      .update({
        form_data: { stage: 'scorecard', ip_hash: ipHash, scorecard },
        updated_at: new Date().toISOString(),
      })
      .eq('id', submission.id);

    res.status(200).json({
      ok: true,
      id: submission.id,
      token: submission.access_token,
      scorecard,
      evidence: evidence.slice(0, 3),
      quote_verified: quoteVerified,
      documents_analysed: documentBlocks.length,
      not_analysed: notAnalysed,
      resale_package_checklist: RESALE_PACKAGE_ITEMS,
    });
  } catch (err) {
    console.error('[hoa-scorecard]', err.message);
    res.status(500).json({ ok: false, error: 'The free check could not be completed. Please try again in a few minutes.' });
  } finally {
    await Promise.all(uploadedFileIds.map((id) =>
      client.files.delete(id).catch(() => {}),
    ));
  }
};
