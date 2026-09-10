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
  extractLoanEstimate, toLoanEstimateRecord,
} = require('./closing-extract');
const { runDocumentAudit } = require('./closing-service');
const { buildEmails } = require('./closing-emails');
const { rankFindings, Severity } = require('./closing-audit');
const { extractRentalDocuments } = require('./rental-extract');
const { runRentalAudit, Severity: RentalSeverity } = require('./rental-audit');
const { buildRentalEmails, renderRentalLetters } = require('./rental-emails');

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
    // Like Closing, and for the same reason: the findings in this report are
    // produced by api/_lib/rental-audit.js, not by the model. The model's job
    // is to write them up. It must not originate a number, a threshold, or a
    // severity.
    //
    // What this replaced was a single instruction to read the documents and
    // find leaks. It worked, unevenly. On a live four-unit audit it caught a
    // suspicious summer water bill and a run of HVAC calls, and walked straight
    // past $118 a month of mortgage insurance on a loan at 66% loan-to-value —
    // while on a different property, with no mortgage insurance to find, the
    // same prompt volunteered "no PMI (25% down)" unasked. It also never added
    // up the repair schedule, which was $500 short of the total on its own page.
    // Neither miss was a reasoning failure. Nothing was checking a list.
    task: `You are the writer for a Rental Navigator cash-flow audit. A landlord paid for an independent audit of their rent roll, operating statement, and whatever mortgage and insurance documents they had.

The deterministic audit engine has already run every check and produced a ranked list of findings. Each finding carries a severity, an evidence basis, an actionability label, an impact kind, and where applicable a charged amount, an expected amount, and a dollar impact. Your job is to present those findings clearly. It is not to add to them.

Hard rules:
- Never state a dollar figure, ratio, threshold or comparison that is not present in the findings you were given. If a cost is not covered by a finding, it is not in the report.
- Never upgrade a severity. Reproduce the engine's language: a confirmed arithmetic error, a recoverable charge, a unit below comparable units in the same property, an unrecovered owner cost, a cost above a typical range, a capital decision due, something requiring documentation, or within norms. Never say a charge is illegal or improper, never promise a refund, and never call a cost excessive unless the finding says so.
- THE DOCUMENTS ARE ATTACHED SO YOU CAN QUOTE THEM, NOT SO YOU CAN AUDIT THEM. You will see costs in these documents that no finding mentions. That is the normal case and it needs no explanation: an expense with no finding simply does not appear in the report. Do not list it, do not total it, do not account for its absence, and do not create a section to hold it. Quote the documents only to support a finding you were given — a line label, a date, a lease term.
- CARRY THE IMPACT KIND THROUGH, every time you state a dollar figure. "recoverable" is money that stops leaving the account once the landlord acts. "excess" is the amount above the property's own baseline. "exposure" is the total currently being borne, only part of which is addressable — an exposure figure is NEVER a saving and must never be described as one, or added into a total of savings. "unexplained" is a discrepancy, not yet money. Never total figures of different kinds together.
- Distinguish hard rules from market norms exactly as the finding's evidence basis does. Arithmetic from the landlord's own documents, a comparison between units in their own building, and a standard lender threshold are things they can hold someone to. A typical range is not — it is a reason to ask a question.
- Carry each finding's actionability through: something to act on now, something for the next renewal, a capital decision, or something needing another document.

HEADLINE AND ORDERING — this determines whether the report reads as work delivered or work not done.

Lead with the strongest TRUE statement available, in this order of preference:
1. Confirmed arithmetic errors or recoverable charges, with the dollar figure.
2. A unit below comparable units in the same property, or an unrecovered owner cost, with the dollar figure.
3. Costs above a typical range, or a capital decision that is due.
4. If there are none of the above: lead with WHAT WAS VERIFIED. Name the specific checks that passed and the numbers behind them — the expense lines adding up to their own total, the escrow reconciling to the taxes and insurance it funds, every unit priced in line with the ones beside it, no system absorbing repeat repair visits. These are findings marked "within norms" and they are the product when nothing is wrong. State plainly that the arithmetic on these documents was independently reproduced and holds.

Never open with what could not be done. Checks that could not run are real and must be reported honestly — but they belong AFTER the results, not in the headline.

ALWAYS include a section naming what was independently verified, whether or not anything was flagged. Every finding marked "within norms" is a check that ran and passed, and every one is work the customer paid for. Name them and give the numbers behind them. A report that flags four findings and mentions one of eight passed checks has quietly thrown away most of the work it did — and on a well-run property that work is the entire product.

Structure. Open with the headline. Then the findings in the order given, the strongest few at two or three lines each: what the figure is, what it should be, what it rests on, the dollar impact and its kind, and when it can be acted on. Then every remaining finding as one compact line. Then the verified section described above. Then a short section for checks that could not be run, in the engine's words.

Use key_numbers for figures that appear in the findings, and label each one so its kind is unmistakable — "recoverable", "above baseline", "currently unrecovered".

Close by telling the landlord that the letters below were drafted from these findings and are theirs to send under their own name after checking them.

State plainly that this is not legal, tax, or investment advice.`,
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
- Never upgrade a severity. Reproduce the engine's language exactly: a confirmed mathematical error, a potential TRID violation, a potential overcharge, a potential duplicate, requires documentation, or informational. Never say a fee is illegal, never promise a refund, never call a charge excessive unless the finding says so.
- THE DOCUMENTS ARE ATTACHED SO YOU CAN QUOTE THEM, NOT SO YOU CAN AUDIT THEM. You will see charges on the Closing Disclosure that no finding mentions. That is the normal case and it needs no explanation: a fee with no finding simply does not appear in the report. Do not list it, do not total it, do not account for its absence, and do not create a section to hold it. Quote the documents only to support a finding you were given — the wording of a contract provision, a date, a line label.
- Distinguish hard rules from market norms exactly as the finding's evidence basis does. A published rate table or a statute is a requirement. A market range is not.
- Carry each finding's actionability through: still changeable before closing, likely locked in, a possible post-closing remedy, or needing another document.
- There is no benchmarking. Do not use the words "benchmark", "cannot benchmark", "market rate" or "market data" anywhere in the report. No finding will ask you to.
- A finding with basedOnCustomerInput true rests on a figure the customer typed in because we could not read it. Say so wherever you present it, and never describe it as verified or confirmed. The document has not been shown to be wrong; their typing might be.

HEADLINE AND ORDERING — this determines whether the report reads as work delivered or work not done.

Lead with the strongest TRUE statement available, in this order of preference:
1. Confirmed mathematical errors or potential tolerance violations, with the dollar figure.
2. Potential overcharges or duplicates, with the dollar figure.
3. If there are none of the above: lead with WHAT WAS VERIFIED. Name the specific checks that passed and the numbers behind them — Cash to Close reconciling to the cent, prepaid interest matching the note rate and day count, an escrow cushion sitting below the federal maximum with the margin stated. These are findings marked "within norms" and they are the product when nothing is wrong. State plainly that the arithmetic on this document was independently reproduced and holds.

Never open with what could not be done. Fields that could not be read are real and must be reported honestly — but they belong AFTER the verified results, not in the headline. A customer who receives a clean audit has bought confirmation that the numbers are right, and the report must deliver that rather than apologise for the gaps around it.

ALWAYS include a section naming what was independently verified, whether or not anything was flagged. Every finding marked "within norms" is a check that ran and passed, and every one is work the customer paid for: Cash to Close reconciling to the cent, the APR agreeing with the disclosure's own amount financed and payment, the finance charge and total of payments consistent with the payment schedule, the monthly escrow matching the disclosed annual costs, discount points matching the percentage printed beside them. Name them and give the numbers behind them. A report that flags four issues and mentions one of ten passed checks has quietly thrown away most of the work it did — and on a clean document that work is the entire product.

Structure and length. One to two pages. Open with the headline as above. Then the top five findings by rank, two or three lines each: what the charge is, what it should be, the basis, the dollar impact, whether it can still be changed. Then every remaining material finding as a single compact line. Then the verified section described above. Then a short section for checks that could not be run at all, and one for anything unreadable. Do not omit findings to save space; keep the basis to a short phrase rather than a full citation.

Close with two short ready-to-send emails, one to the lender and one to the settlement agent, each covering only the findings flagged for that recipient. If no findings are flagged for a recipient, omit that email entirely and say so in one line rather than writing a placeholder.

State plainly that this is not legal advice.`,
  },
};

// The tool schema declares missing_or_uncertain, sections, sections[].items
// and key_numbers as arrays. The model does not always honour that, and
// nothing between the API and the customer's screen checked.
//
// Observed on a live rental report (submission 37466c44, 2026-09-09):
// missing_or_uncertain came back as the STRING '["...","..."]}' — a JSON
// array plus a stray brace, serialised into a string field. It carries no
// angle brackets, so the tag-leak check above passed it; the JSON parses,
// so nothing else objected; and it was stored and served.
//
// navigator-status.html then called .forEach on a string. That throws
// partway through rendering, which cost the customer three things at once:
// the "what I couldn't verify" block rendered as a heading with an empty
// list, and the two statements that run AFTER it — renderFixups() and the
// automatic PDF email — never ran at all. The page promises the report is
// "delivered automatically"; on that report it silently was not.
//
// Normalising here rather than retrying is deliberate: the content was
// entirely correct, only the container was wrong, and a retry would have
// spent another minute of the customer's wait to re-roll a die.
function coerceStringArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim());
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  // '["a","b"]}' — take everything up to the last ']' and try again.
  const close = trimmed.lastIndexOf(']');
  if (trimmed.startsWith('[') && close > 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(0, close + 1));
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string' && v.trim());
    } catch (err) { /* fall through and keep the raw string as one item */ }
  }
  return trimmed ? [trimmed] : [];
}

function normalizeReport(input) {
  const out = { ...input };
  out.missing_or_uncertain = coerceStringArray(out.missing_or_uncertain);
  out.sections = (Array.isArray(out.sections) ? out.sections : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ ...s, items: coerceStringArray(s.items) }));
  out.key_numbers = (Array.isArray(out.key_numbers) ? out.key_numbers : [])
    .filter((n) => n && typeof n === 'object' && (n.label || n.value));
  return out;
}

function guessMediaType(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

// Renders the drafted letters as the plain text navigator-status.html shows
// in its closing block, so the page and the PDF carry the same words.
function renderLettersAsText(emails) {
  const blocks = [];
  for (const [key, label] of [['lender', 'LENDER'], ['settlement', 'SETTLEMENT AGENT']]) {
    const email = emails && emails[key];
    if (!email || !email.body) continue;
    const heading = `EMAIL TO ${label}${email.to ? ` (${email.to})` : ''}`;
    blocks.push(`${heading}\n\nSubject: ${email.subject}\n\n${email.body}`.trim());
  }
  return blocks.join('\n\n---\n\n');
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
    // The lender / settlement-agent letters. Built here on the paid path and
    // attached to the stored report below, so the PDF has something to print.
    // Null for every other product, and null for a clean Closing Disclosure —
    // nothing routed to a party means no letter, and inventing one would spend
    // the customer's credibility with someone they still have to close with.
    let draftedEmails = null;
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

      // runDocumentAudit, NOT runClosingAudit — the same entry point the free
      // scorecard uses. This was the single most damaging defect in the product.
      //
      // runClosingAudit is the raw engine. runDocumentAudit is the engine PLUS
      // the document-intrinsic loan maths — APR against the amount financed,
      // finance charge against the payment stream, total of payments, amount
      // financed, TIP, monthly principal and interest, monthly escrow, discount
      // points — and MINUS the retired cannot-benchmark findings.
      //
      // Calling the raw engine here meant the paid report was built from a
      // SMALLER audit than the free scorecard. Not merely fewer reassurances:
      // fewer errors. An APR disclosed below the note rate — a confirmed
      // mathematical error and a potential TRID violation, checks 03 and 04 of
      // the twenty-seven the page enumerates — was caught by the free scorecard
      // and did not appear anywhere in the report the customer paid $59 for.
      // Verified by planting exactly that error and running both paths.
      //
      // It also explains two things that looked like the model ignoring its
      // instructions. Told to name every passed check, it named one, because
      // one was all it was given. Told never to mention benchmarking, it kept
      // producing a section about it, because six cannot-benchmark findings
      // were in the findings it was told to write up and not omit. Both were
      // this call.
      const audited = runDocumentAudit({
        extraction: stored.extraction,
        answers: stored.answers || {},
        loanEstimates,
        // Extracted at the free scorecard stage and reused here, like the Loan
        // Estimates — re-reading the contract would be a second model call for
        // an identical result.
        contractTerms: stored.contract_terms || null,
      });
      const { skipped, cureNote } = audited;
      const findings = audited.findings;

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
      // Ranked once, then used for both the write-up and the letters. If the
      // model saw one order and the letters used another, a customer reading
      // the PDF top to bottom would meet the same findings twice in two
      // different priorities.
      const ranked = rankFindings(findings);

      draftedEmails = buildEmails(ranked, {
        propertyAddress: stored.extraction.property_address,
        closingDate: stored.extraction.closing_date,
        borrowerName: Array.isArray(stored.extraction.borrower_names)
          ? stored.extraction.borrower_names.filter(Boolean).join(' and ')
          : null,
        lenderName: stored.extraction.lender_name,
        // Without this the settlement agent's letter was addressed to nobody —
        // `to: null` — even though the agent is named on the first page of every
        // Closing Disclosure. The model's own draft named them correctly because
        // it reads the document; the structured letter could not, because the
        // name was never extracted.
        settlementName: stored.extraction.settlement_agent_name,
      });

      // Flagged and passed are handed over SEPARATELY, and that is deliberate.
      //
      // They used to go as one ranked array. Severity order puts within-norms
      // last, so ten passed checks sat at the bottom of a long JSON blob behind
      // the four that needed action — and the report named exactly one of them,
      // even after the instruction to name them all was added. The writer was
      // not disobeying so much as summarising the tail of a list.
      //
      // Those ten are not filler. Each is a figure the lender printed and we
      // reproduced independently: the APR against the amount financed, the
      // finance charge against the payment stream, the escrow against the
      // disclosed annual costs. On a document with nothing wrong they are the
      // entire product, and a customer who paid $59 to be told "your lender's
      // arithmetic is correct" deserves to see which arithmetic was checked.
      const passed = ranked.filter((f) => f.severity === Severity.WITHIN_NORMS);
      const flagged = ranked.filter((f) => f.severity !== Severity.WITHIN_NORMS);

      auditBlock = [
        '',
        'AUDIT FINDINGS — these are the report. Write these up. Do not add to them, do not',
        'recompute them, and do not soften or escalate any severity.',
        JSON.stringify(flagged, null, 1),
        '',
        passed.length
          ? [
            `CHECKS THAT RAN AND PASSED — ${passed.length} of them, listed below.`,
            'These belong in the "what was independently verified" section. Name EVERY ONE,',
            'each with the figure behind it, in the engine\'s own words. Do not compress them',
            'into "other checks passed", do not pick a representative few, and do not drop any',
            'for length — this list is the work the customer paid for.',
            JSON.stringify(
              passed.map((f) => ({ title: f.title, basis: f.basis, charged: f.charged })),
              null, 1
            ),
          ].join('\n')
          : '',
        skipped.length
          ? `Checks that could not be run because the required values were missing or unreadable: ${skipped.join(', ')}. Say so plainly rather than implying they passed.`
          : '',
        cureNote || '',
      ].filter(Boolean).join('\n');
    }

    // Rental Navigator, on the same arrangement as Closing: read the documents
    // into numbers, judge the numbers deterministically, and hand the model the
    // findings rather than the documents plus an instruction to look for
    // problems. See api/_lib/rental-audit.js for what that fixed.
    //
    // The one branch back to the old behaviour is at the bottom: if extraction
    // produces nothing a single check can run on — a photograph too dark to
    // read, a document that turns out not to be a rent roll — the customer has
    // still paid, and a thinner analysis they are told is thinner beats an empty
    // report. That fallback is the exception and it announces itself.
    let usedFallbackAnalysis = false;
    if (submission.product === 'rental') {
      let extraction = null;
      try {
        extraction = await extractRentalDocuments(ANTHROPIC_API_KEY, contentBlocks);
      } catch (err) {
        console.error('[rental] extraction failed:', err.message);
      }

      const audited = extraction ? runRentalAudit(extraction) : { findings: [], skipped: [], checksRun: 0 };

      if (audited.findings.length) {
        const flagged = audited.findings.filter((f) => f.severity !== RentalSeverity.WITHIN_NORMS);
        const passed = audited.findings.filter((f) => f.severity === RentalSeverity.WITHIN_NORMS);

        draftedEmails = buildRentalEmails(audited.findings, {
          propertyAddress: (extraction.property || {}).address || null,
          managerName: (extraction.management || {}).company_name || null,
        });

        // Flagged and passed go over separately for the reason the Closing
        // branch above documents: severity order puts within-norms last, and a
        // writer told to name every passed check will summarise the tail of one
        // long list no matter how firmly it is instructed not to.
        auditBlock = [
          '',
          'AUDIT FINDINGS — these are the report. Write these up. Do not add to them, do not',
          'recompute them, and do not soften or escalate any severity.',
          JSON.stringify(flagged, null, 1),
          '',
          passed.length
            ? [
              `CHECKS THAT RAN AND PASSED — ${passed.length} of them, listed below.`,
              'These belong in the "what was independently verified" section. Name EVERY ONE,',
              'each with the figure behind it, in the engine\'s own words. Do not compress them',
              'into "other checks passed", do not pick a representative few, and do not drop any',
              'for length — this list is the work the customer paid for.',
              JSON.stringify(passed.map((f) => ({ title: f.title, basis: f.basis })), null, 1),
            ].join('\n')
            : '',
          audited.skipped.length
            ? `Checks that could not be run because the required figures were missing or unreadable: `
              + `${audited.skipped.join('; ')}. Say so plainly rather than implying they passed.`
            : '',
          (extraction.unreadable || []).length
            ? `The extraction could not read these parts of the documents: ${(extraction.unreadable || []).join('; ')}.`
            : '',
        ].filter(Boolean).join('\n');

        // Kept on the submission so a future re-run can compare this period
        // against the next one without asking for these documents again.
        await admin
          .from('navigator_submissions')
          .update({
            form_data: { ...formData, rental_extraction: extraction, rental_checks_run: audited.checksRun },
            updated_at: new Date().toISOString(),
          })
          .eq('id', submissionId);
      } else {
        usedFallbackAnalysis = true;
        console.error('[rental] no deterministic findings — falling back to document analysis');
      }
    }

    // The pre-engine prompt, used only on the fallback path above. It is the
    // weaker product and the report has to say so rather than passing an
    // unverified read off as an audit.
    const FALLBACK_RENTAL_TASK = `You are the analysis engine behind Rental Navigator. A landlord paid for a cash-flow audit and uploaded documents, but the documents could not be read into figures precisely enough for the audit engine to run a single check on them.

Say that plainly and early, in the summary and again in missing_or_uncertain: the numbers could not be extracted, so what follows is a read of the documents rather than the arithmetic audit that was paid for, and it should be treated as a starting point. Tell them exactly what would fix it — a clearer scan, the original PDF export from their property management system rather than a photograph, or the statement pages that carry the totals.

Then do what you can. Work only from what is legibly present, flag anything that looks abnormal or above a typical range, and never state a figure you cannot point at in the documents. Do not present any of it as verified.`;

    const taskForThisRun = usedFallbackAnalysis ? FALLBACK_RENTAL_TASK : config.task;
    const systemPrompt = `${taskForThisRun}\n\n${HONESTY_RULES}${auditBlock}\n\nRespond ONLY by calling the submit_navigator_report tool.`;

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
          // Raised from 4096. A closing audit with twenty findings plus two
          // drafted emails runs close to that ceiling, and nothing below checks
          // stop_reason — a truncated tool call would have been saved and billed
          // as a finished report.
          max_tokens: 8000,
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

      // A truncated response still parses. Without this, a report cut off

      // mid-sentence is stored and emailed as though it were complete.

      if (data.stop_reason === 'max_tokens') {

        throw new Error('Report generation hit the output limit and was truncated — not saved.');

      }
      const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_navigator_report');
      if (!toolUse) {
        lastError = new Error('Model did not return a structured report');
        continue;
      }

      // Normalised BEFORE the contamination check so the check reads the same
      // strings the customer will, not a container the renderer would reject.
      const candidate = normalizeReport(toolUse.input);

      if (reportLooksContaminated(candidate)) {
        lastError = new Error('Model output contained malformed/leaked formatting artifacts');
        continue;
      }

      // A report with no sections is not a report. Retrying costs a minute;
      // storing an empty one costs the customer the whole purchase.
      if (!candidate.sections.length) {
        lastError = new Error('Model returned a report with no sections');
        continue;
      }

      report = candidate;
    }

    if (!report) throw lastError || new Error('Failed to generate a valid report after retrying');

    // Attached after generation, never before: the letters are assembled from
    // the audit's own figures and must not pass through the model, which is
    // here to write up findings, not to reword a letter the customer will sign
    // their name to. Attaching after also keeps them clear of the contamination
    // check above, which is looking for model output, not our own text.
    const hasLetters = draftedEmails
      && Object.values(draftedEmails).some((letter) => letter && letter.body);
    if (hasLetters) {
      report.emails = draftedEmails;

      // And they replace closing_body, for exactly the reason above.
      //
      // The customer was getting two different versions of the same letters:
      // api/_lib/pdf-report.js renders report.emails into the PDF, while
      // navigator-status.html renders closing_body, which the model writes
      // itself. On the paid report for submission c764be16 the two differed
      // in subject, tone and wording — the deterministic letter opened "I may
      // well be reading something wrong, so I would appreciate your help
      // squaring these up", the model's opened "I've had my Closing
      // Disclosure independently audited" under a subject reading "Three
      // Items Requiring Correction".
      //
      // Both are letters the customer signs their name to and sends to their
      // own lender, and the tone of those is not a detail. The voice fix made
      // to closing-emails.js on 2026-09-08 reached only the PDF copy, because
      // nobody had noticed there were two.
      const rendered = submission.product === 'rental'
        ? renderRentalLetters(draftedEmails)
        : renderLettersAsText(draftedEmails);
      if (rendered) {
        report.closing_title = 'Ready-to-send emails';
        report.closing_body = rendered;
      }
    }

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

module.exports = {
  generateNavigatorReport,
  PRODUCT_CONFIGS,
  __internal: { renderLettersAsText, normalizeReport, coerceStringArray },
};
