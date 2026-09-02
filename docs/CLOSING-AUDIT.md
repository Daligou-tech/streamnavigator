# Closing Disclosure Audit

Engineering notes for the `closing` product. Describes what is in `main` today.

If you are an AI assistant picking this project up in a new session: read this
file first, then `tests/closing-audit.test.js` and `tests/closing-scorecard.test.js`.
Those tests are the durable memory of this project — each one names the real
document that exposed the bug it guards against.

## The one thing to understand before changing anything

Seventeen bugs were found in this product in a single day. **Every one was found
by uploading a real document. None came from the test suite.**

The tests kept passing because they encoded the author's misunderstanding of the
forms. The purchase Cash to Close formula was applied to a refinance and had
passing tests proving it correct. A Loan Estimate was classified, priced at $59
and stored — then never opened — with full unit tests covering an engine that
never ran.

So: **tests measure assumptions; only real documents measure reality.** Before
believing any change here is correct, run a real Closing Disclosure through the
free scorecard. Document *shape* is what breaks things — purchase vs refinance,
full document vs excerpt, Closing Disclosure vs settlement statement — not
character recognition, which has been reliable throughout.

## Why it is built this way

The original implementation was one ~150-word prompt asking the model to judge
fees "grounded in general knowledge of standard closing-cost tolerances". That is
the model's priors sold to a customer as analysis.

| Stage | Who | Where |
|---|---|---|
| Extract what is printed | model | `api/_lib/closing-extract.js` |
| Decide what is wrong | code | `api/_lib/closing-audit.js` |
| Write it up | model | `api/_lib/navigator-engine.js` |

Every flag, dollar figure, threshold, severity and citation comes from
deterministic code with a stated basis. The model never originates a number.

This is structural, not instructional. `compareToBenchmark(label, charged, bm)`
returns `cannot_benchmark` when `bm` is null. There is no path where a missing
benchmark becomes a guess.

## Request flow

```
POST /api/closing-scorecard        (free, pre-payment)
  rate limit -> insert -> store files
  -> classify documents (if more than one file)
  -> extract the Closing Disclosure
  -> extract Loan Estimates, if any
  -> deterministic audit, including TRID tolerance
  -> scorecard

POST /api/closing-answers          (free)   two structured questions
POST /api/closing-corrections      (free)   customer-typed values, re-runs the audit

Stripe -> api/navigator-stripe-webhook.js
  -> generateNavigatorReport() reuses the stored extraction and loan estimates
```

Tolerance testing runs in the FREE scorecard, not only in the paid report. The
flag count is the basis of the purchase decision, so a count that excluded the
analysis being paid for was not a basis.

## Storage

No dedicated tables. Everything lives in `form_data` (jsonb) on
`navigator_submissions`:

`ip_hash`, `extraction`, `original_extraction`, `customer_values`,
`loan_estimates`, `documents`, `tier`, `scorecard`, `answers`, `stage`,
`regeneration_count`.

**Any code that overwrites `form_data` must preserve the rest.** This has already
caused a bug: `closing-corrections.js` rebuilt `scorecard` from scratch,
discarding tier, tolerance results and Loan Estimates, so a customer correcting a
single unreadable figure silently lost the analysis they paid extra for.

## Decisions that came from real failures

**Cash to Close has two tables.** Purchases use the standard one; refinances use
the alternative one (loan amount − closing costs + costs already paid − payoffs).
Applying the purchase formula to a refinance produced a $95,155.17 "confirmed
mathematical error" as the headline of a paid report. Note the sign on costs paid
before closing: **added** on the alternative table, **subtracted** on the standard
one. Backwards gives a phantom error of exactly twice the amount.

**Section G is not the escrow cushion.** It is the whole opening deposit. The
RESPA 1/6 cap applies only to a cushion, which most Closing Disclosures do not
state separately. Where only an aggregate adjustment is present, report
informationally — do not test it.

**Tolerance buckets come from the printed section letter**, not a category the
model inferred. A (Origination) and B (Did Not Shop For) are zero tolerance; F, G
and H carry none; C depends on the written provider list. Section E is the one
place a label is still needed, because it holds both taxes (zero tolerance) and
recording fees (10% cumulative).

**The Loan Estimate must be for the same loan.** Lender, property and borrower
are compared before any tolerance testing. CFPB samples H-25(G) and H-24(D) share
borrowers and loan amount but are Fir Bank and Ficus Bank — five confident
"violations" came from comparing one lender's fees against another's. The
mismatch is shown in a prominent banner above the figures, not in small print.

**Charges are matched across documents in four passes** — exact key, category +
amount, category + payee, category + name similarity. An exact-key match reported
"Settlement Agent Fee $500" against "Title - Settlement Fee $500" as a full $500
increase. **An unmatched charge is ambiguous, not a violation**: it reports as
`requires_documentation` with no dollar impact, because it may be a renamed
existing charge.

**Zero tolerance is per charge** under 1026.19(e)(3)(i). A decrease in one fee
does not offset an increase in another. Do not net them.

**Section subtotals are not charges.** Individual lines carry a printed number
(01, 02, ...); headings and totals do not. A $1,320 section total was benchmarked
as if it were a single recording fee.

**Deposits and holdbacks are not closing costs.** A $24,000 rehab escrow counted
as a fee produced a headline of 33.3% of the loan against a true 8.3%.

**Tool output may arrive wrapped.** One run returned
`{ cd_extraction: { ...everything... } }`. The extraction was flawless, yet a
perfectly readable Closing Disclosure was rejected because `document_type` was
undefined. `unwrapToolInput()` guards all three extractors.

**A check that could not run is never reported as a pass.** Tolerance testing
needs charges on both sides; 22 Loan Estimate charges against an empty Closing
Disclosure produced "no fee rose beyond what the rules permit". A false all-clear
is worse than a false alarm — a false alarm gets questioned.

**Transfer taxes are tested in aggregate.** Buyer and seller split them by
contract, so a single line is one party's share. Only a total exceeding the
unexempted statutory amount is flagged; a total below it is informational,
because exemptions are common.

## Extraction confidence

Anything read below 0.85 confidence is discarded, not used, and surfaced naming
the page. The customer can type those figures in via
`/api/closing-corrections`; values arrive tagged `value_source: 'customer'`, that
tag travels into every finding built on them, and a "confirmed mathematical
error" resting on typed input is downgraded to `requires_documentation`.

## Rate limiting

`api/_lib/rate-limit.js`. Per email 8/hour, 20/day; per IP 15/hour, 40/day;
global 250/day. The global cap is the only layer that bounds spend against a
distributed script. Counts come from `navigator_submissions` — no separate table.
Checked before the row is inserted and before any model call. Fails open on a
database error. IPs are hashed, never stored raw.

Roughly $0.05–0.15 per scorecard, so the global cap bounds a worst-case day near
$13–38. Failed attempts count, because they still cost a model call; the original
limits were too tight and locked out the first tester mid-retry.

## Pricing

$29 for a Closing Disclosure audit; $59 when a Loan Estimate or purchase contract
is added, because those unlock tolerance testing and credit reconciliation — the
two analyses that can conclude money is owed. Tier is decided by classifying the
uploaded documents; an unrelated extra document does not trigger the upgrade
price. Two Stripe Payment Links, selected client-side from `data-link-basic` and
`data-link-full`.

## Tests

```
npm test
node --test tests/closing-audit.test.js tests/closing-scorecard.test.js
```

Three failures in `tests/purchase-engine.test.js` predate this work and are
unrelated.

Guardrail tests, which fail on purpose if behaviour regresses:

- the free scorecard never leaks a flagged fee name or dollar impact
- a normal customer is never blocked by the rate limits
- a typed figure never looks like a verified reading
- an unmatched charge is never reported as an increase

## Known limitations

**No benchmark corpus beyond Maryland transfer taxes.** `data/benchmarks.json`
holds state and Baltimore City transfer tax only. Every other benchmarkable fee
returns `cannot_benchmark` — honest, but it means "am I paying more than I
should" is largely unanswered. Worth knowing: the fees most likely to be padded —
doc prep, admin, processing, courier — have no published schedule anywhere, so a
corpus can never cover them. Handle those with rules, not data.

**Purchase contract reconciliation has never run on a real contract.** The code
exists and is unit-tested. So was the Loan Estimate path, which turned out to be
wired to nothing at all. Treat as unverified.

**The paid report has never been read end to end** with matched documents and a
working tolerance engine.

**Business-day definition unresolved.** `businessDaysBetween()` implements both
readings and defaults to the more conservative count. Which governs the
4-business-day rule in 1026.19(e)(4)(ii) needs counsel.

**9MB total upload cap.** `MAX_FILES` is 12 but Vercel's request body limit binds
first. Direct-to-storage upload with Supabase signed URLs is the fix.

## Legal posture

The strongest severity available is `potential_trid_violation`. The system never
states a fee is illegal, never promises a refund, and never calls a charge
excessive without a stated basis. Findings carry actionability — changeable
before closing, likely locked, potential post-closing remedy, or needs
documentation.

The generated lender and settlement-agent emails have not been reviewed by
counsel. Worth doing before promotion, along with a refund policy for audits that
return mostly `cannot_benchmark`.
