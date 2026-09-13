// Contractor Navigator's analysis pipeline.
//
// Three stages, in this order, and the order is the product:
//
//   1. api/_lib/contractor-extract.js reads the estimates into structured
//      numbers. It judges nothing.
//   2. api/_lib/contractor-audit.js runs a named catalogue of checks over
//      those numbers and the sourced reference data in
//      api/_lib/contractor-reference.js. No model runs in that file. The
//      findings it returns ARE the report.
//   3. A model writes the opening — a headline, a summary, and what to do
//      first — from the findings alone. It never sees the documents at this
//      stage and it cannot add a finding, because it is not given one to add.
//
// The negotiation email is built deterministically too, in
// api/_lib/contractor-emails.js, for the reason that file gives: the customer
// signs their own name to it.
//
// What this replaced, and why.
//
// Until this rewrite the whole product was one Sonnet call: here are the
// documents, is the price fair, what should they negotiate. It was the last
// engine still built that way, months after closing, rental and HOA had all
// moved off it, and it was the one selling the most consequential advice in
// the catalogue — a homeowner repeats this report to a contractor's face and
// then signs or does not sign a five-figure contract.
//
// It could not add up a column of line items. It had no price data, so "the
// price looks high" meant whatever the model recalled that run. It could not
// know a deposit was over a statutory cap, or that a split system was below
// the federal efficiency minimum for that state, or that the tax credit the
// quote was sold on ended on 31 December 2025, because none of that is in the
// document and nothing was looking it up. And the page promised all three.
//
// Two operational holes closed here as well, both of which took money without
// returning anything:
//
//   - Generation only ever ran inside the customer's own browser poll. Pay,
//     see the Stripe receipt, close the tab, and the row sat at 'paid' with
//     nothing scheduled to look at it again. api/generate-paid-navigator.js
//     now sweeps contractor like the other nine products.
//   - No report ever left the database. There was no email, no PDF and no
//     link that worked on a second device; localStorage in the purchasing
//     browser was the only route back to a report the customer had paid for.
//
// Requires ANTHROPIC_API_KEY (Vercel Project Settings -> Environment
// Variables). Nothing here ever sends that key to the browser.

const { getSupabaseAdmin } = require('./supabaseAdmin');
const { sendFailureAlert } = require('./alerts');
const { failurePatch } = require('./provider-outage');
const { extractContractorEstimates } = require('./contractor-extract');
const { runContractorAudit, Severity } = require('./contractor-audit');
const { buildContractorEmails } = require('./contractor-emails');

const WRITEUP_MODEL = 'claude-sonnet-5';

// The promise on the page, expressed as a number.
//
// contractor.html says: if your documents do not let us run at least 60% of
// the checks for your trade, the money goes back automatically and you keep
// whatever we did find. This constant is that sentence, and
// tests/contractor-claims.test.js asserts the page and this file agree.
//
// It exists because of what "we found nothing" means on a thin document. A
// photograph of a handwritten quote with no total on it produces a report made
// entirely of contract-terms findings — true, worth reading, and not what
// somebody paid $49 for. Charging full price for it and hoping they do not
// notice is the kind of thing that works once per customer.
const COVERAGE_FLOOR = 0.6;

const REFUND_STATE_THIN = 'due_thin_result';

const WRITEUP_TOOL = {
  name: 'write_contractor_report_opening',
  description: 'Write the opening of the homeowner\'s report from the audit findings.',
  input_schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: 'One sentence. The bottom line for this homeowner, in plain English. No preamble.',
      },
      summary: {
        type: 'string',
        description: 'Three to five sentences. What the estimates say, what the audit found, and what it means for '
          + 'the decision in front of them. Name the biggest figure if there is one.',
      },
      do_first: {
        type: 'array',
        items: { type: 'string' },
        description: 'Three to six things to do, in order, each one sentence. Drawn only from the findings given.',
      },
    },
    required: ['headline', 'summary', 'do_first'],
  },
};

const WRITEUP_SYSTEM = `You are writing the opening of a Contractor Navigator report for a homeowner who is about \
to sign a home improvement contract.

The findings below were produced by a deterministic audit that ran before you. They are the report. You are \
writing the first page of it and nothing else.

Rules:

1. Add nothing. Every fact, figure and conclusion in what you write must already be in the findings. If a number \
is not in them, it does not go in. You have not seen the documents and you must not write as though you have.

2. Change nothing. Do not soften a finding, do not escalate one, and do not re-rank them. A finding marked as a \
confirmed arithmetic error is proved; a finding marked as outside a published national range is a comparison \
against national cost guides and NOT proof of overcharging. Never blur those two, and never describe a published \
range as though it were a local quote.

3. Say what the coverage number means. You are told how many checks ran out of how many apply to this trade. \
Where coverage is high and little was flagged, say so plainly with the number — that is a clean result on work \
actually done and it is what the customer paid for. Where coverage is LOW, the headline must say that the \
documents, not the contractor, are the limit, and must name what would raise it.

4. Write for someone with a decision to make this week, not for someone reading an audit. Short sentences. No \
throat-clearing, no "in today's market", no "it is important to note". Do not congratulate them for being \
careful.

5. do_first is ordered by what saves the most money or risk first, and each entry must trace to a finding.

Respond only by calling write_contractor_report_opening.`;

function guessMediaType(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

// The model's structured output occasionally comes back with a stray closing
// tag or a parameter fragment leaked into a text field — observed in
// production on the shared engine, where the JSON still parsed cleanly, so a
// plain JSON.parse check would have shipped a garbled report to a paying
// customer. Detect it and retry the write-up once.
const TAG_LEAK_PATTERN = /<\/?[a-zA-Z][a-zA-Z0-9_-]*(\s[^>]*)?>/;

function looksContaminated(value) {
  if (typeof value === 'string') return TAG_LEAK_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(looksContaminated);
  if (value && typeof value === 'object') return Object.values(value).some(looksContaminated);
  return false;
}

// What the write-up model is shown. Flagged and passed go over separately
// because severity order puts within-norms last, and a writer told to
// acknowledge the passed checks will otherwise summarise the tail of one long
// list however firmly it is instructed not to — the same split the closing and
// rental branches of api/_lib/navigator-engine.js make, for the same reason.
function buildWriteupPrompt(audited, extraction, context) {
  const flagged = audited.findings.filter((f) => f.severity !== Severity.WITHIN_NORMS);
  const passed = audited.findings.filter((f) => f.severity === Severity.WITHIN_NORMS);

  const quotes = (extraction.quotes || []).map((q) => ({
    label: q.label,
    contractor: q.contractor_name || null,
    total_price: q.total_price || null,
  }));

  return [
    `TRADE: ${audited.category}`,
    context.state ? `STATE: ${context.state}` : null,
    `ESTIMATES UPLOADED: ${JSON.stringify(quotes)}`,
    '',
    `COVERAGE: ${audited.checksRun} of ${audited.checksTotal} checks that apply to a ${audited.category} estimate `
      + 'ran on these documents. This figure goes in the summary on every report. It is the number that separates '
      + 'two results a customer will otherwise confuse: an estimate that was examined and is fine, and an estimate '
      + 'we could barely examine.',
    audited.checksRun / Math.max(1, audited.checksTotal) < COVERAGE_FLOOR
      ? 'COVERAGE IS BELOW THE LINE WE HOLD OURSELVES TO. This customer is being refunded automatically and keeps '
        + 'this report. Say that plainly in the summary — that the documents were too thin for a full audit, that '
        + 'the refund is already on its way and they do not need to ask for it, and what they could send that would '
        + 'let us run the rest. Do not apologise at length; state it and move on.'
      : null,
    '',
    'FLAGGED FINDINGS — write these up. Do not add to them, do not recompute them, do not re-rank them.',
    JSON.stringify(flagged.map((f) => ({
      check: f.checkId,
      quote: f.quote || null,
      title: f.title,
      severity: f.severity,
      evidence: f.evidence,
      basis: f.basis,
      action: f.recommendedAction || null,
      dollarImpact: f.dollarImpact || null,
      impactKind: f.impactKind || null,
    })), null, 1),
    '',
    passed.length
      ? `CHECKS THAT RAN AND PASSED — ${passed.length} of them: `
        + JSON.stringify(passed.map((f) => f.title))
        + '. Do not list these one by one; the report prints them in full below your section. Refer to them as a '
        + 'count and let the number do the work.'
      : null,
    audited.skipped.length
      ? `CHECKS THAT COULD NOT RUN, with the reason for each: ${audited.skipped.join(' | ')}. Say plainly that they `
        + 'did not run rather than implying they passed, and name any document or answer that would have let them.'
      : null,
    (extraction.unreadable || []).length
      ? `COULD NOT BE READ: ${(extraction.unreadable || []).join(' | ')}`
      : null,
  ].filter(Boolean).join('\n');
}

async function writeOpening(apiKey, audited, extraction, context) {
  const prompt = buildWriteupPrompt(audited, extraction, context);
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: WRITEUP_MODEL,
        max_tokens: 3000,
        system: WRITEUP_SYSTEM,
        tools: [WRITEUP_TOOL],
        tool_choice: { type: 'tool', name: 'write_contractor_report_opening' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = await response.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'write_contractor_report_opening');
    if (!toolUse) {
      lastError = new Error('Model did not return a structured report opening');
      continue;
    }
    if (looksContaminated(toolUse.input)) {
      lastError = new Error('Model output contained malformed/leaked formatting artifacts');
      continue;
    }
    return toolUse.input;
  }

  throw lastError || new Error('Failed to write the report opening after retrying');
}

// The opening is the one part a model writes, so it is the one part that can
// fail on its own. When it does, the customer still gets every finding, every
// figure and every email — written by code that cannot fail differently on a
// second run. A missing headline is a worse report; a missing report is a
// refund. Those are not the same thing and this function is where they part.
function fallbackOpening(audited) {
  const flagged = audited.findings.filter((f) => f.severity !== Severity.WITHIN_NORMS);
  const money = flagged.filter((f) => f.dollarImpact).reduce((s, f) => s + f.dollarImpact, 0);
  return {
    headline: flagged.length
      ? `${flagged.length} thing${flagged.length === 1 ? '' : 's'} to settle before you sign.`
      : `Nothing flagged across ${audited.checksRun} checks.`,
    summary: `${audited.checksRun} of ${audited.checksTotal} checks that apply to a ${audited.category} estimate ran `
      + `on your documents. ${flagged.length} produced a finding`
      + `${money ? `, with ${Math.round(money).toLocaleString('en-US')} dollars of arithmetic, statutory and pricing `
        + 'difference between them' : ''}. Each one is listed below with the figures it rests on.`,
    do_first: flagged.slice(0, 5).map((f) => f.recommendedAction || f.title),
    generated: 'deterministic_fallback',
  };
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
    const context = {
      state: formData.state || null,
      homeSqft: formData.home_sqft || null,
      // Tri-state on purpose. A missing answer is not a "no": the federal
      // cancellation right turns on where the sale happened, and guessing it
      // either way sends the homeowner into an argument on a false premise.
      signedAtHome: formData.quoted_at_home === 'yes' ? true
        : (formData.quoted_at_home === 'no' ? false : null),
      category: formData.category || null,
    };

    contentBlocks.push({
      type: 'text',
      text: [
        context.category ? `Homeowner-selected trade: ${context.category}` : null,
        formData.description ? `Homeowner's description of the job: ${formData.description}` : null,
        context.state ? `Property state: ${context.state}` : null,
        context.homeSqft ? `Approximate home size: ${context.homeSqft} sq ft` : null,
        `Number of estimate documents attached: ${contentBlocks.length}`,
      ].filter(Boolean).join('\n'),
    });

    const extraction = await extractContractorEstimates(ANTHROPIC_API_KEY, contentBlocks);
    if (!extraction || !(extraction.quotes || []).length) {
      throw new Error('No estimate could be read from the uploaded files');
    }

    const audited = runContractorAudit(extraction, context);
    const emails = buildContractorEmails(audited.findings, { quotes: extraction.quotes });

    let opening;
    try {
      opening = await writeOpening(ANTHROPIC_API_KEY, audited, extraction, context);
    } catch (err) {
      console.error(`[contractor] write-up failed for ${submissionId}, falling back:`, err.message);
      opening = fallbackOpening(audited);
    }

    const coverageRatio = audited.checksTotal > 0 ? audited.checksRun / audited.checksTotal : 0;
    const thin = coverageRatio < COVERAGE_FLOOR;

    const report = {
      category: audited.category,
      headline: opening.headline,
      summary: opening.summary,
      do_first: opening.do_first || [],
      coverage: {
        checks_run: audited.checksRun,
        checks_total: audited.checksTotal,
        could_not_run: audited.skipped,
        floor: COVERAGE_FLOOR,
        below_floor: thin,
      },
      quotes: (extraction.quotes || []).map((q) => ({
        label: q.label,
        contractor_name: q.contractor_name || null,
        total_price: q.total_price || null,
        license_number: q.license_number || null,
      })),
      findings: audited.findings,
      emails,
      unreadable: extraction.unreadable || [],
      // Recorded on the report itself so the page can say it without having to
      // read the submission row, and so a support question a month later has
      // one place to look.
      refund: thin
        ? {
          issued: true,
          reason: `Only ${audited.checksRun} of ${audited.checksTotal} checks could run on these documents, `
            + `below the ${Math.round(COVERAGE_FLOOR * 100)}% we hold ourselves to.`,
        }
        : { issued: false },
      generated_at: new Date().toISOString(),
    };

    await admin.from('contractor_reports').insert({
      submission_id: submissionId,
      report_json: report,
      negotiation_email: emails.length ? emails[0].body : null,
      model: WRITEUP_MODEL,
    });

    const patch = { status: 'complete', updated_at: new Date().toISOString() };
    // Only where money was actually taken. A test row or an admin regeneration
    // must never queue a refund for a payment that never happened.
    if (thin && submission.stripe_checkout_session_id) patch.refund_state = REFUND_STATE_THIN;
    await admin.from('navigator_submissions').update(patch).eq('id', submissionId);

    if (thin && submission.stripe_checkout_session_id) {
      try {
        await sendFailureAlert({
          submissionId,
          product: 'contractor',
          error: `Thin result refunded automatically: ${audited.checksRun}/${audited.checksTotal} checks ran`,
          refundQueued: true,
          paused: false,
        });
      } catch (alertError) {
        console.error('[contractor] thin-result alert could not be sent:', alertError.message);
      }
    }

    return report;
  } catch (err) {
    // provider-outage.js decides which kind of failure this is. An account out
    // of credit or a rate limit sends the row back to 'paid' instead, since
    // that says nothing about the submission and refunding it would return
    // money for a report the customer is still going to get — and 'paid' is
    // now a state something actually sweeps for this product.
    const paidForReal = !!submission.stripe_checkout_session_id;
    const { outage, patch } = failurePatch(err, { paidForReal, waitingSince: submission.created_at });

    await admin.from('navigator_submissions').update(patch).eq('id', submissionId);

    // One alert per distinct cause, not one per retry.
    if (submission.error !== patch.error) {
      try {
        await sendFailureAlert({
          submissionId,
          product: 'contractor',
          error: patch.error,
          refundQueued: patch.refund_state === 'due',
          paused: outage,
        });
      } catch (alertError) {
        console.error('[contractor] failure alert could not be sent:', alertError.message);
      }
    }

    throw err;
  }
}

module.exports = {
  generateContractorReport,
  COVERAGE_FLOOR,
  REFUND_STATE_THIN,
  _internal: { buildWriteupPrompt, fallbackOpening, looksContaminated, guessMediaType },
};
