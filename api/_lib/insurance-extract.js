'use strict';

// Reads an insurance renewal notice — and, when the customer sent one, their
// prior policy or declarations page — into structured numbers. It does not
// judge them.
//
// This is the transcription half of the arrangement api/_lib/insurance-audit.js
// describes: every conclusion about whether a renewal is worth challenging is
// drawn afterwards by arithmetic that runs the same way every time, on figures
// that were actually printed on the page. Splitting the two exists because a
// model asked to read AND judge an insurance renewal in one pass is exactly
// the pipeline that this codebase already caught missing a real charge on a
// different document type (docs/INSURANCE-AUDIT.md, citing the same failure
// mode observed on Rental Navigator: a single-pass reader notices what stands
// out and stays quiet about what does not).
//
// So the rules for this call are narrow: copy what each document states,
// classify it into a fixed vocabulary, and leave anything not printed as
// null. A null costs the customer one skipped check, named in their report. A
// guess costs them a finding built on a number nobody wrote down.

const EXTRACT_MODEL = 'claude-sonnet-5';

const CATEGORIES = ['auto', 'home', 'renters', 'umbrella', 'other'];

// Coverage lines are classified into a fixed vocabulary rather than matched by
// their printed label, because "Dwelling", "Coverage A" and "Dwelling
// Protection" are the same line on three different declarations pages and a
// label-only match would treat them as unrelated. The audit compares two
// policies by category, never by label text.
const COVERAGE_CATEGORIES = [
  'dwelling', 'other_structures', 'personal_property', 'loss_of_use',
  'liability', 'medical_payments', 'bodily_injury', 'property_damage',
  'comprehensive', 'collision', 'uninsured_motorist', 'personal_injury_protection',
  'umbrella_liability', 'other',
];

function policySnapshotSchema(extra) {
  return {
    type: 'object',
    properties: {
      carrier_name: { type: 'string' },
      policy_number: { type: 'string' },
      policy_period_start: { type: 'string' },
      policy_period_end: { type: 'string' },
      premium_total: { type: 'number', description: 'The total premium for this policy period, as printed. Not a monthly instalment unless that is the only figure the document gives.' },
      payment_frequency: { type: 'string', description: 'How the premium is billed, as stated — e.g. "annual", "semi-annual", "monthly". Omit if not stated.' },
      named_insured: { type: 'string' },
      risk_description: { type: 'string', description: 'What is being insured, as the document identifies it — a property address, a vehicle year/make/model, or similar. Copied, not summarised.' },
      coverages: {
        type: 'array',
        description: 'One entry per coverage line printed on the document, however small. Do not omit a line because it looks minor — the audit decides what matters, not the extraction.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The line exactly as printed, e.g. "Coverage A – Dwelling".' },
            category: { type: 'string', enum: COVERAGE_CATEGORIES, description: 'Classify from the label and context. Use "other" only when nothing fits.' },
            limit: { type: 'number', description: 'The dollar limit, if the document states one. Null for a line stated as "Included" or "Actual Cash Value" with no dollar figure.' },
            limit_basis: { type: 'string', description: 'Only if the document says the limit is expressed unusually — e.g. "Actual Cash Value", "% of Coverage A" — copy that phrase. Omit otherwise.' },
          },
          required: ['label', 'category'],
        },
      },
      deductibles: {
        type: 'array',
        description: 'One entry per deductible printed on the document.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'As printed, e.g. "All Other Perils", "Wind/Hail", "Collision".' },
            applies_to: { type: 'string', enum: COVERAGE_CATEGORIES, description: 'Which coverage category this deductible applies to, classified the same way as coverages above.' },
            amount: { type: 'number' },
            is_percentage: { type: 'boolean', description: 'True if the deductible is printed as a percentage of a limit rather than a flat dollar amount.' },
          },
          required: ['label', 'amount'],
        },
      },
      discounts_applied: {
        type: 'array',
        description: 'Discounts the document explicitly names as applied — e.g. "Multi-Policy", "Autopay", "Claims-Free", "Bundling". Do not infer one from a lower premium; only record what is printed by name.',
        items: { type: 'string' },
      },
      exclusions_endorsements: {
        type: 'array',
        description: 'Every named exclusion, endorsement, rider or coverage form listed on the document — the schedule of forms, endorsements, or exclusions section. This is usually a list of codes and short titles; copy the titles.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            kind: { type: 'string', enum: ['exclusion', 'endorsement'], description: '"endorsement" for anything that adds or extends coverage (including a form that is simply listed as attached); "exclusion" for anything that removes or limits it.' },
          },
          required: ['label', 'kind'],
        },
      },
      renewal_prior_premium_stated: {
        type: 'number',
        description: 'ONLY on the renewal notice: if the renewal notice itself states what the prior term\'s premium was (a common line: "Your premium is changing from $X to $Y"), record the prior figure here. Leave null if the renewal notice does not state a prior premium.',
      },
      ...extra,
    },
  };
}

const EXTRACT_TOOL = {
  name: 'record_insurance_documents',
  description: 'Record every figure found in the customer\'s insurance renewal notice and, if provided, their prior policy — without interpreting them.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: CATEGORIES,
        description: 'The line of insurance these documents cover, from their content — not from anything the customer typed.',
      },
      renewal: Object.assign(
        { description: 'The upcoming/renewal term — the policy period that has not yet started, or the most recently dated document if only one was provided.' },
        policySnapshotSchema({}),
      ),
      prior_policy: Object.assign(
        { description: 'The expiring/prior term, recorded ONLY when a second, earlier-dated policy document was actually provided. Omit this entirely — do not fill it from the renewal notice\'s own stated prior premium, which belongs in renewal.renewal_prior_premium_stated instead.' },
        policySnapshotSchema({}),
      ),
      documents_seen: {
        type: 'array',
        description: 'What each attachment turned out to be, in order, and which of the two above (if either) it was recorded as.',
        items: { type: 'string' },
      },
      unreadable: {
        type: 'array',
        description: 'Anything you could see was present but could not read reliably — a cut-off column, a blurred figure, a page that did not scan. Name it rather than filling it in.',
        items: { type: 'string' },
      },
    },
    required: ['renewal', 'documents_seen'],
  },
};

const EXTRACT_SYSTEM = `You are reading a customer's insurance renewal notice and, if they sent one, their prior policy or declarations page — and recording what each one states.

You are not analysing anything. You are not deciding whether a premium change is reasonable. Every judgement about these figures is made afterwards by a separate deterministic engine, and it can only work with figures that were actually printed on a page.

Rules, in order of importance:

1. NEVER invent, infer or compute a figure. If a document does not print a coverage limit, leave it null. If discounts are not named explicitly, record none. A null costs the customer one skipped check, named by name in their report. A guessed number silently corrupts a finding they will act on.

2. TWO DOCUMENTS, TWO SLOTS, AND THEY ARE NOT INTERCHANGEABLE. "renewal" is the upcoming term — the policy period that starts after this document, or simply the newer-dated document if that is all you can tell. "prior_policy" is a SEPARATE, earlier-dated policy document, and it is recorded ONLY when the customer actually attached one. If they attached only a renewal notice, leave prior_policy entirely absent — do not copy anything into it from the renewal notice's own text. If the renewal notice itself states what the prior premium was ("your premium is changing from $X to $Y"), that single figure goes in renewal.renewal_prior_premium_stated, which is a different field for a different purpose: a number the renewal notice prints about the past, not a second document.

3. THE COVERAGE LIST MUST BE COMPLETE. Record every coverage line on the document's declarations or coverage summary page, however small it looks — liability, medical payments, uninsured motorist, and any add-on coverage all belong here, not only the largest lines. The audit decides which lines matter; leaving one out produces a report that is silently missing a comparison the customer paid for.

4. THE EXCLUSIONS/ENDORSEMENTS LIST is usually a schedule of form codes and short titles on the document — record it in full, classified as "endorsement" (adds or extends coverage, including anything simply listed as attached) or "exclusion" (removes or limits it). If the document has no such schedule, leave the list empty rather than guessing at what might be excluded.

5. DISCOUNTS ARE RECORDED ONLY WHEN NAMED. A lower premium is not evidence of a discount you were not told about. Record a discount only when the document names it explicitly — "Multi-Policy Discount", "Paperless/Autopay Discount", and similar.

6. Classify coverages and deductibles into the categories given. Use "other" only when nothing fits — most personal lines coverage falls into the listed categories.

7. Copy carrier names, policy numbers and dates exactly as printed, in the document's own format.

8. Anything you can see but cannot read reliably goes in "unreadable", named specifically.

Respond ONLY by calling the record_insurance_documents tool.`;

// --- shape normalisation ----------------------------------------------------
//
// The tool schema declares objects and arrays for renewal/prior_policy and
// their nested lists. Handed a truncated or unusually-shaped response, the
// model has, on other products in this codebase, returned an array or a list
// serialised as a JSON string rather than the object/array the schema
// declares. See rental-extract.js for the same defect observed on a stored
// prior_period field. Normalising here, rather than trusting the shape, means
// a malformed field costs the customer one skipped check instead of a thrown
// error partway through rendering their report.
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const opener = trimmed.charAt(0);
  if (opener !== '{' && opener !== '[') return value;
  const close = trimmed.lastIndexOf(opener === '{' ? '}' : ']');
  if (close <= 0) return value;
  try {
    return JSON.parse(trimmed.slice(0, close + 1));
  } catch (err) {
    return value;
  }
}

const ARRAY_FIELDS = ['coverages', 'deductibles', 'discounts_applied', 'exclusions_endorsements'];

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const x = Object.assign({}, raw);
  for (const key of ARRAY_FIELDS) {
    const value = parseMaybeJson(x[key]);
    x[key] = Array.isArray(value) ? value : [];
  }
  return x;
}

function normalizeExtraction(raw) {
  const x = Object.assign({}, raw || {});
  x.renewal = normalizeSnapshot(x.renewal) || { coverages: [], deductibles: [], discounts_applied: [], exclusions_endorsements: [] };
  x.prior_policy = normalizeSnapshot(x.prior_policy);
  const docs = parseMaybeJson(x.documents_seen);
  x.documents_seen = Array.isArray(docs) ? docs : [];
  const unreadable = parseMaybeJson(x.unreadable);
  x.unreadable = Array.isArray(unreadable) ? unreadable : [];
  return x;
}

// Two attempts, because a truncated or missing tool call is worth one retry
// before a paying customer's report falls back to a thinner analysis.
async function extractInsuranceDocuments(apiKey, contentBlocks, options) {
  const opts = options || {};
  const fetchImpl = opts.fetch || fetch;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: 8000,
        system: EXTRACT_SYSTEM,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'record_insurance_documents' },
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = await response.json();
    if (data.stop_reason === 'max_tokens') {
      lastError = new Error('Document extraction was truncated');
      continue;
    }
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_insurance_documents');
    if (!toolUse) {
      lastError = new Error('Extraction returned no structured result');
      continue;
    }
    return normalizeExtraction(toolUse.input);
  }

  throw lastError || new Error('Document extraction failed');
}

module.exports = {
  extractInsuranceDocuments,
  normalizeExtraction,
  EXTRACT_TOOL,
  EXTRACT_SYSTEM,
  EXTRACT_MODEL,
  CATEGORIES,
  COVERAGE_CATEGORIES,
};
