// Generic analysis engine for the 11 Navigator products that previously had
// NO report-generation code at all (property-tax, home-savings, rental,
// subscriptions, government-money, home-maintenance, landlord, insurance,
// buying, hoa, closing). Before this file existed, a customer could pay for
// any of these, the Stripe webhook would correctly mark the submission
// "paid" — and then nothing would ever happen: no code path moved the
// status past "paid" or produced a report. That was found and fixed as
// part of closing out defect D-03/D-12 in the QA audit.
//
// Contractor Navigator is deliberately NOT included here — it already has
// its own working, more elaborately-rendered pipeline (api/_lib/contractor-
// engine.js + contractor-report.html) and this file doesn't touch it.
//
// Design: one shared, generic report shape (headline / key numbers /
// labeled sections / an honest "what I couldn't verify" list / an optional
// closing block for an email or checklist) rendered generically by
// navigator-status.html, instead of writing 11 bespoke schemas and 11
// bespoke renderer pages. Each product gets its own system prompt grounded
// in exactly what that product's page promises — see PRODUCT_CONFIGS below.
//
// Requires the same ANTHROPIC_API_KEY environment variable contractor-
// engine.js already depends on. Nothing here ever sends that key to the
// browser.

const { getSupabaseAdmin } = require('./supabaseAdmin');
const {
  runClosingAudit, extractLoanEstimate, toLoanEstimateRecord,
} = require('./closing-extract');

const ANTHROPIC_MODEL = 'claude-sonnet-5';

// Shared discipline for every product: this is a plain text-completion call
// with no live web/database access, so it must never present a fabricated
// specific real-world fact (a comparable property, a named government
// program and dollar amount, a statute citation, a current price) as if it
// were verified. Getting this wrong is the single biggest way a product
// like this could actively mislead a paying customer.
const HONESTY_RULES = `
You have no live internet, database, or document-lookup access beyond what is given to you in this message — only your own general knowledge, which has a training cutoff and is not guaranteed current. Ground every specific claim in either (a) the documents/description actually provided to you, or (b) general knowledge you are genuinely confident is still accurate and not overly specific to a particular current price, program, or law. Never invent a specific real-world fact you cannot verify — a comparable property's address or sale price, the name and current dollar amount of a specific government program, a specific statute or ordinance citation, a specific current fee or interest rate — if you are not confident it is both real and currently accurate. When the task calls for that kind of specific lookup and you don't have reliable, current information, say so explicitly (use the missing_or_uncertain field) and give general, methodologically sound guidance instead — what kind of evidence to gather, what to ask, what type of authority to verify with — rather than presenting a plausible-sounding but unverified specific fact as settled. It is always better to be honestly general than confidently wrong. Never invent numbers, names, or figures that aren't in what you were given or clearly labeled as a general estimate.
`.trim();

// One shared tool schema for all 11 products. Deliberately generic (a
// headline, a few key numbers, labeled bulleted sections, an honest
// uncertainty list, an optional closing block) so it can represent an HOA
// risk score, a property tax appeal estimate, a subscription keep/cancel
// list, a compliance checklist, etc. equally well, and so there's exactly
// one renderer to build and maintain instead of 11.
const REPORT_TOOL = {
  name: 'submit_navigator_report',
  description: 'Submit the structured Navigator report for this submission.',
  input_schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: 'The single most important takeaway, as a short, specific, plain-English headline (a verdict, a dollar estimate, a risk level, a recommendation) — not a generic restatement of the product name.',
      },
      headline_tag: {
        type: 'string',
        description: 'Optional short badge for the headline, e.g. "Moderate risk", "Fair renewal", "Below market", "Worth appealing", "Replace". Omit if nothing fits.',
      },
      summary: {
        type: 'string',
        description: 'A 2-4 sentence plain-English summary of the bottom line and why.',
      },
      key_numbers: {
        type: 'array',
        description: 'Zero to six of the most important numbers in this report, each a short label + value pair. Omit entirely if no numbers are meaningful here, rather than inventing placeholders.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['label', 'value'],
        },
      },
      sections: {
        type: 'array',
        description: 'The body of the report, broken into labeled sections appropriate to this specific submission (e.g. what to cancel, what changed, what to ask, warning signs, what is missing, an action checklist). Use as many sections as make sense — do not force a fixed set that does not fit this submission.',
        items: {
          type: 'object',
          properties: {
            icon: { type: 'string', description: 'A single emoji representing this section.' },
            title: { type: 'string' },
            items: {
              type: 'array',
              items: { type: 'string' },
              description: 'Bulleted points for this section — specific to this submission, not generic advice that would apply to anyone.',
            },
          },
          required: ['title', 'items'],
        },
      },
      missing_or_uncertain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required. Anything you could not verify, that was missing from what was provided, or where you are giving general guidance rather than a fact specific to this situation. Use an empty array only if there is genuinely nothing to flag — not as a default.',
      },
      closing_title: {
        type: 'string',
        description: 'Optional title for a final actionable block, e.g. "Ready-to-send email", "Pre-closing checklist", "Next steps". Omit if not applicable to this product.',
      },
      closing_body: {
        type: 'string',
        description: 'Optional free-text content for the closing block (a complete ready-to-send email, or a checklist written as plain text with line breaks). Omit if closing_title is omitted.',
      },
    },
    required: ['headline', 'summary', 'sections', 'missing_or_uncertain'],
  },
};

// requiresFiles mirrors what each product page's own intake form already
// enforces post-D-04-fix: home-savings, rental, insurance, hoa, and closing
// require an uploaded document client- and server-side because their
// analysis is meaningfully document-grounded; the other six work from a
// text description alone (files optional, matching each page's own FAQ
// copy — e.g. property-tax's "we can often work from the address alone").
const PRODUCT_CONFIGS = {
  'property-tax': {
    label: 'Property Tax Navigator',
    requiresFiles: false,
    task: `You are the analysis engine behind Property Tax Navigator. A homeowner paid for a review of whether their property tax assessment looks worth appealing, based on their address/description and, if provided, their latest assessment notice.

You do not have access to a live MLS or county assessor database, so you cannot pull real comparable-sale records — never invent a specific comparable address, sale price, or assessed value you were not given. Instead: reason from what's actually in the description/assessment notice, general knowledge of how property tax assessment and appeals work (and that the process varies significantly by state and county), and any patterns worth flagging (an assessment increase that looks unusually large, an inconsistency between the assessed value and what the homeowner describes about the property, an obvious data error). Where a real analysis would cite specific comparable properties, instead tell the homeowner exactly what kind of comparables to pull themselves (e.g., from their county assessor's public record site) and how to use them.

Give an honest read on whether appealing looks worth the homeowner's time given what was provided, explicitly saying when there isn't enough information to have a view rather than guessing. Close with a practical, generalized appeal checklist: typical evidence to gather and what to expect from the process — only get state/county-specific if the homeowner told you their location and you're genuinely confident about that jurisdiction's process.`,
  },

  'home-savings': {
    label: 'Home Savings Navigator',
    requiresFiles: true,
    task: `You are the analysis engine behind Home Savings Navigator. A homeowner paid for a full household recurring-bill audit and uploaded bills/statements (utility, internet, phone, insurance, memberships, and similar).

Review every bill provided: identify what's being paid for and how much, and assess whether each looks priced above a typical market rate for that category, using your general knowledge of typical U.S. pricing patterns — clearly flag when you're not confident about a current, region-specific rate rather than inventing one. For each recurring expense give one clear recommendation: cancel outright, downgrade without losing what they actually use, switch providers (name the type of alternative, not a fabricated specific current promotional price), or renegotiate (with specific talking points). Total an estimated annual savings figure, show your reasoning, and label it clearly as an estimate. Be honest when something is already fairly priced — don't manufacture savings that aren't really there.`,
  },

  'rental': {
    label: 'Rental Navigator',
    requiresFiles: true,
    task: `You are the analysis engine behind Rental Navigator. A landlord paid for a cash-flow leak analysis and uploaded a rent roll, expense records, and/or mortgage/debt-service details.

Compare each cost line (maintenance, utilities, insurance, taxes, debt service) against realistic ranges for that type of cost and flag anything that looks abnormal or above a typical range, saying plainly when you can't be sure without a local comparable. Assess whether rents charged look below what similar units nearby would likely command — you do not have live rental-comp data, so give a general, reasoned read (e.g., based on what the documents show about unit type, location, and condition) rather than a fabricated specific comparable rent figure. Produce a ranked list of cash-flow leaks by estimated dollar impact, with your reasoning for each, grounded specifically in what was provided — don't pad it with generic landlord tips that aren't tied to this data.`,
  },

  'subscriptions': {
    label: 'Subscription Navigator',
    requiresFiles: false,
    task: `You are the analysis engine behind Subscription Navigator. A customer paid to review every recurring subscription they listed or uploaded (a statement, or a manual list).

For each subscription, recommend one of: keep as-is, cancel outright, rotate (pause seasonally and resume when needed), or downgrade to a cheaper tier — grounded in whatever the customer told you about usage or value, and general knowledge of typical tier structures for well-known named services. Don't invent a specific current price for a named service unless you're confident it's accurate, or unless the customer told you the price — describe the type of change instead (e.g., "downgrade to the ad-supported tier") when you're not sure of the exact current figure. Where a well-known, stable cancellation or downgrade path exists for a widely known service, describe it in general terms rather than fabricating a specific URL. Total an estimated annual savings figure with your reasoning shown.`,
  },

  'government-money': {
    label: 'Government Money Finder',
    requiresFiles: false,
    task: `You are the analysis engine behind Government Money Finder — the highest hallucination-risk product in this lineup, so apply the honesty rules below especially strictly. A customer paid for a personalized list of rebates, tax credits, utility incentives, and grants they may qualify for, based on their described situation (homeownership, income range, recent purchases like an EV or heat pump, household size, etc.).

You do not have live access to current program databases, and eligibility rules, dollar amounts, and even a program's continued existence change over time. Only name a specific program (federal, state, or local) when you are genuinely confident, from general knowledge, that it is a long-standing, well-established category of program (e.g., a federal EV tax credit, a state homestead exemption, a common utility efficiency rebate) — and even then, explicitly say that exact dollar amounts, eligibility thresholds, and deadlines should be verified against the current official source, since you cannot confirm today's rules. Do not invent a specific program name, agency, or dollar figure you are not confident is real and currently active. When you're not confident about specifics, describe the general category of program that likely applies (e.g., "many utilities offer a rebate in this category — check with yours") instead of a fabricated specific one. For every program you do name, give plain-English next steps for how someone would typically go about claiming it.`,
  },

  'home-maintenance': {
    label: 'Home Maintenance Navigator',
    requiresFiles: false,
    task: `You are the analysis engine behind Home Maintenance Navigator. A homeowner paid for a repair-vs-replace call on a home system (roof, HVAC, water heater, windows, generator, or similar), based on their description of its age, condition, and what's prompting the decision — and optionally a repair quote or photos.

Weigh expected remaining life if repaired vs. replaced using general knowledge of typical lifespans and typical cost ranges for that system and repair type, stating clearly that costs vary significantly by region and what you give is an estimate, not a quote. Give a clear repair-or-replace recommendation with your reasoning, list warning signs that mean it's time to stop patching and replace, and list specific questions to ask before hiring anyone for the work. If a quote was provided, weigh it directly into the recommendation.`,
  },

  'landlord': {
    label: 'Landlord Navigator',
    requiresFiles: false,
    task: `You are the analysis engine behind Landlord Navigator — a legally sensitive product, so apply the honesty rules below especially strictly. A landlord paid for a compliance checklist covering licensing/registration, inspection deadlines, lead-paint/safety disclosure, tenant notice requirements, and permits, based on the properties they described (locations, property types, unit counts).

Landlord-tenant law varies by state, county, and sometimes city, and changes over time. Do not state a specific statute, ordinance number, or exact current notice-period length as settled fact unless you are genuinely confident it is both correct and current for the specific location given. When unsure, name the general category of requirement (e.g., "most jurisdictions require written notice before entry — the exact period depends on your state") and explicitly flag that it needs verification with the local housing authority or an attorney, rather than presenting a guess as legal fact. Produce a specific action-item checklist across the requested categories, with each item labeled either as something you're reasonably confident about or as something requiring the landlord's own local verification.`,
  },

  'insurance': {
    label: 'Insurance Navigator',
    requiresFiles: true,
    task: `You are the analysis engine behind Insurance Navigator. A customer paid for a renewal-vs-prior-policy comparison and uploaded their renewal notice, and optionally their prior policy or declarations page.

Compare premium, coverage limits, deductibles, and exclusions line by line between what was provided — if only the renewal notice was given, work from that alone and say so explicitly rather than guessing at what changed. Give a clear verdict on whether the renewal looks fair/typical or worth shopping elsewhere, backed by your reasoning, and flag when you don't have enough information to be confident. List specific, pointed questions for the customer to ask their insurer, and be explicit that only they or a licensed agent can actually shop for or bind a new policy.`,
  },

  'buying': {
    label: 'Purchase Navigator',
    requiresFiles: false,
    task: `You are the analysis engine behind Purchase Navigator. A customer paid for a true total-cost-of-ownership analysis on something they're considering buying (a vehicle, a major appliance, or similar), based on their description of the item/model, quoted price, and intended use.

Estimate financing cost impact if relevant, expected maintenance/running costs, and depreciation or resale-value expectations, using general knowledge of typical patterns for that category of purchase — clearly flag that exact figures depend on the specific make/model/location and should be treated as directional estimates, not quotes. Compare against at least one realistic alternative. Give a clear buy/wait/reconsider recommendation grounded in the math, and show your reasoning and assumptions plainly so the customer can sanity-check them.`,
  },

  'hoa': {
    label: 'HOA Navigator',
    requiresFiles: true,
    task: `You are the analysis engine behind HOA Navigator. A homebuyer paid for an HOA risk assessment and uploaded whatever HOA documents were available (budget, reserve study, meeting minutes, assessment notices, and similar) — work with whatever subset was actually provided, and explicitly flag which typically-useful documents are missing.

Assess reserve funding levels, planned capital projects, special-assessment risk, insurance coverage, overall financial health, and any board disputes visible in what was provided. Produce an HOA Risk Score of Low, Moderate, High, or Critical with your reasoning, documented potential financial exposure clearly labeled as an estimate grounded in the documents (never a fabricated figure), your top concerns each tied to something you actually saw in the documents, and specific questions to send the HOA, seller, or agent. Close with a pre-contingency-expiration checklist. Never state a dollar exposure figure you can't trace back to something in the documents provided — say so when you're inferring.`,
  },

  'closing': {
    label: 'Closing Disclosure Audit',
    requiresFiles: true,
    // The findings in this report are produced by api/_lib/closing-audit.js, not
    // by the model. The model's job is to write them up. It must not originate a
    // number, a benchmark, or a severity.
    //
    // The ordering instruction below exists because the first live paid report
    // led with "No confirmed overcharges found, but 15 fees could not be
    // benchmarked" — a receipt for work not done — while three real
    // verifications sat near the bottom marked "informational only". Same facts,
    // wrong order. A customer signing a six-figure document is buying the
    // verification as much as the discovery.
    task: `You are the writer for a Closing Disclosure Audit. A homebuyer paid for an independent audit of their final Closing Disclosure, and optionally supplied a purchase contract and Loan Estimates.

The deterministic audit engine has already run every check and produced a ranked list of findings. Each finding carries a severity, an evidence basis, an actionability label, and where applicable a charged amount, an expected amount, and a dollar impact. Your job is to present those findings clearly. It is not to add to them.

Hard rules:
- Never state a dollar figure, benchmark, expected amount, or regulatory citation that is not present in the findings you were given. If a fee is not covered by a finding, it is not in the report.
- Never upgrade a severity. Reproduce the engine's language exactly: a confirmed mathematical error, a potential TRID violation, a potential overcharge, above the available benchmark, a potential duplicate, requires documentation, cannot benchmark, or informational. Never say a fee is illegal, never promise a refund, never call a charge excessive unless the finding says so.
- Distinguish hard rules from market norms exactly as the finding's evidence basis does. A published rate table or a statute is a requirement. A market range is not.
- Carry each finding's actionability through: still changeable before closing, likely locked in, a possible post-closing remedy, or needing another document.
- Where a finding says cannot benchmark, say that in those words rather than filling the gap.
- A finding with basedOnCustomerInput true rests on a figure the customer typed in because we could not read it. Say so wherever you present it, and never describe it as verified or confirmed. The document has not been shown to be wrong; their typing might be.

HEADLINE AND ORDERING — this determines whether the report reads as work delivered or work not done.

Lead with the strongest TRUE statement available, in this order of preference:
1. Confirmed mathematical errors or potential tolerance violations, with the dollar figure.
2. Potential overcharges or duplicates, with the dollar figure.
3. If there are none of the above: lead with WHAT WAS VERIFIED. Name the specific checks that passed and the numbers behind them — Cash to Close reconciling to the cent, prepaid interest matching the note rate and day count, an escrow cushion sitting below the federal maximum with the margin stated. These are findings marked "within norms" and they are the product when nothing is wrong. State plainly that the arithmetic on this document was independently reproduced and holds.

Never open with what could not be done. Fees that could not be benchmarked and fields that could not be read are real and must be reported honestly — but they belong AFTER the verified results, not in the headline. A customer who receives a clean audit has bought confirmation that the numbers are right, and the report must deliver that rather than apologise for the gaps around it.

When reporting unbenchmarkable fees, say once and plainly why: we name a fee as high only when we can show the schedule or filing behind it, and for these we hold no reliable data for this jurisdiction. Do not repeat that sentence per fee. Make clear it is a limit on our data, not a clean bill of health for those fees.

Structure and length. One to two pages. Open with the headline as above. Then the top five findings by rank, two or three lines each: what the charge is, what it should be, the basis, the dollar impact, whether it can still be changed. Then every remaining material finding as a single compact line. Then a short section for checks that could not be run at all, and one for anything unreadable. Do not omit findings to save space; keep the basis to a short phrase rather than a full citation.

Close with two short ready-to-send emails, one to the lender and one to the settlement agent, each covering only the findings flagged for that recipient. If no findings are flagged for a recipient, omit that email entirely and say so in one line rather than writing a placeholder.

State plainly that this is not legal advice.`,
  },
};

function guessMediaType(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

async function generateNavigatorReport(submissionId) {
  const admin = getSupabaseAdmin();

  const { data: submission, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('*')
    .eq('id', submissionId)
    .single();

  if (fetchError || !submission) throw new Error('Submission not found');

  const config = PRODUCT_CONFIGS[submission.product];
  if (!config) throw new Error(`No report engine configured for product "${submission.product}"`);

  await admin
    .from('navigator_submissions')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', submissionId);

  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY env var');

    const filePaths = submission.file_paths || [];
    if (config.requiresFiles && !filePaths.length) {
      throw new Error(`${config.label} requires at least one uploaded document, but none were found on this submission.`);
    }

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
    if (config.requiresFiles && !contentBlocks.length) {
      throw new Error('Could not read any of the attached documents for this submission.');
    }

    const formData = submission.form_data || {};
    const contextLines = [
      formData.category ? `Customer-selected category: ${formData.category}` : null,
      formData.description ? `Customer's description: ${formData.description}` : null,
      `Number of documents attached: ${contentBlocks.length}`,
    ].filter(Boolean).join('\n');

    contentBlocks.push({ type: 'text', text: contextLines || 'No additional context or documents were provided — work from the product task alone and flag the lack of input in missing_or_uncertain.' });

    // Closing Disclosure Audit is the one product where the model is not the
    // analyst. The findings were computed deterministically by closing-audit.js
    // from the extraction captured at the free-scorecard stage; the model's job
    // is to write them up. Handing it the findings as data — rather than the
    // documents plus an instruction to judge — is what stops it inventing a
    // benchmark when the corpus has no entry for a county.
    let auditBlock = '';
    if (submission.product === 'closing') {
      const stored = submission.form_data || {};
      if (!stored.extraction) {
        throw new Error('This closing submission has no stored extraction — the free scorecard step did not complete.');
      }
      // Extract the Loan Estimates now, at report time, from the files already
      // downloaded above. This is the analysis the $59 tier is sold on; before
      // this ran, loanEstimates was always null and the tolerance engine — built
      // and tested — never executed on a paying customer's documents.
      // Reuse what the free scorecard already extracted. Re-reading the same
      // PDFs would be a second model call for an identical result.
      let loanEstimates = Array.isArray(stored.loan_estimates) && stored.loan_estimates.length
        ? stored.loan_estimates
        : null;
      const leIndexes = loanEstimates ? [] : (stored.documents || [])
        .filter((d) => d.document_type === 'loan_estimate')
        .map((d) => d.index)
        .filter((i) => typeof i === 'number' && contentBlocks[i]);

      if (leIndexes.length) {
        const records = [];
        for (const i of leIndexes) {
          try {
            const raw = await extractLoanEstimate(ANTHROPIC_API_KEY, contentBlocks[i]);
            if (raw && raw.is_loan_estimate !== false && (raw.charges || []).length) {
              records.push(toLoanEstimateRecord(raw, `LE${records.length + 1}`));
            }
          } catch (err) {
            // One unreadable Loan Estimate must not take down the whole report.
            console.error('[closing] loan estimate extraction failed:', err.message);
          }
        }
        // selectBaseline needs an issue date to order revisions. Without one we
        // cannot establish which LE governs, and guessing the baseline is worse
        // than declining to test tolerances.
        const dated = records.filter((r) => r.dateIssued);
        if (dated.length) loanEstimates = dated;
      }

      const { findings, skipped, cureNote } = runClosingAudit(stored.extraction, {
        answers: stored.answers || {},
        loanEstimates,
        contractTerms: stored.contract_terms || null,
      });

      if (leIndexes.length && !loanEstimates) {
        findings.unshift({
          checkId: 'TRID_NOT_RUN',
          title: 'Tolerance testing could not be run on the Loan Estimates provided',
          severity: 'requires_documentation',
          evidence: 'no_evidence_available',
          actionability: 'requires_additional_documentation',
          basis: 'The Loan Estimates could not be read clearly enough, or carried no issue date, '
            + 'which is needed to establish which one governs the tolerance baseline.',
          recommendedAction: 'Upload a clearer copy of each Loan Estimate, including the date issued.',
          detail: {},
        });
      }
      auditBlock = [
        '',
        'AUDIT FINDINGS — these are the report. Write these up. Do not add to them, do not',
        'recompute them, and do not soften or escalate any severity.',
        JSON.stringify(findings, null, 1),
        skipped.length
          ? `Checks that could not be run because the required values were missing or unreadable: ${skipped.join(', ')}. Say so plainly rather than implying they passed.`
          : '',
        cureNote || '',
      ].filter(Boolean).join('\n');
    }

    const systemPrompt = `${config.task}\n\n${HONESTY_RULES}${auditBlock}\n\nRespond ONLY by calling the submit_navigator_report tool.`;

    // Occasionally the model's structured tool-call output gets corrupted —
    // observed in testing as a stray closing tag / parameter fragment (e.g.
    // "</summary>\n<parameter name=\"key_numbers\">...") leaking into a
    // text field instead of populating the actual key_numbers field. The
    // JSON still parses fine, so this wouldn't be caught by a JSON.parse
    // check — it silently ships a broken-looking report to a paying
    // customer. Detect it and retry the whole generation once before
    // giving up, rather than surfacing garbled tags to a customer.
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
          system: systemPrompt,
          tools: [REPORT_TOOL],
          tool_choice: { type: 'tool', name: 'submit_navigator_report' },
          messages: [{ role: 'user', content: contentBlocks }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 500)}`);
      }

      const data = await response.json();
      const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_navigator_report');
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

    await admin.from('navigator_reports').insert({
      submission_id: submissionId,
      product: submission.product,
      report_json: report,
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

module.exports = { generateNavigatorReport, PRODUCT_CONFIGS };
