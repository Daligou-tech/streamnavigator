# Iteration 3 — the document-only service

Goal: a clean, complete service that provides value from the CD, plus the LE and
contract when supplied. No benchmarks. No 50-state data problem.

`node test/run-all.js` → **90 assertions across 3 suites, all passing.**

---

## 1. Where to upload — exact steps

Repo: `github.com/Daligou-tech/streamnavigator`, branch `main`.

**The one-shot way (recommended).** From a clone, at the repo root:

```
node scripts/add-loan-calculations-schema.js
node test/run-all.js
git add -A && git commit -m "Document-only audit service" && git push
```

**The GitHub web way.** Go to the repo → **Add file → Upload files**. Drag a
file in, then edit the filename box to include the folder path — typing
`api/_lib/closing-service.js` creates the `api/_lib` folders automatically.
Repeat, then **Commit changes**.

### Every file and its destination

| Upload this file | To this path | New or replace |
|---|---|---|
| `closing-service.js` | `api/_lib/closing-service.js` | new |
| `closing-math.js` | `api/_lib/closing-math.js` | new |
| `add-loan-calculations-schema.js` | `scripts/add-loan-calculations-schema.js` | new |
| `run-all.js` | `test/run-all.js` | new |
| `closing-service.test.js` | `test/closing-service.test.js` | new |
| `closing-math.test.js` | `test/closing-math.test.js` | new |
| `md-benchmarks.test.js` | `test/md-benchmarks.test.js` | new |
| `md-jurisdiction.js` | `api/_lib/md-jurisdiction.js` | new |
| `benchmark-corpus.js` | `api/_lib/benchmark-corpus.js` | **replaces** |
| `benchmarks.json` | `data/benchmarks.json` | **replaces** |
| `build-md-corpus.js` | `scripts/build-md-corpus.js` | new |
| `ITERATION-3.md` | `docs/08-document-only-service.md` | new |
| `ITERATION-2.md` | `docs/07-document-intrinsic-checks.md` | new |
| `NOTES.md` | `docs/06-md-corpus-notes.md` | new |

**Do not upload a whole `closing-extract.js`.** Your working copy is ahead of
`main` — that file is one of your four pending-deploy files. Run the patch script
instead. It is idempotent, checks every anchor before touching anything, writes a
`.bak`, and refuses cleanly if the file has moved on. `--dry-run` shows what it
would do.

The two benchmark files still go in even though benchmarking is off. They carry
the `stacked()` completeness fix, which matters more with a thin corpus, and the
service switches benchmarking off at the service layer so the corpus can return
later without a rewrite.

---

## 2. What was built

### `api/_lib/closing-service.js` — one entry point

```js
const { runDocumentAudit } = require('./api/_lib/closing-service');

const result = runDocumentAudit({
  extraction,                 // the CD extraction
  loanEstimates,              // optional
  contractTerms,              // optional
  answers,                    // optional
  unusableDocuments: ['loan_estimate'],  // a file arrived but could not be read
});
// -> { findings, skipped, coverage, coverage_by_group, scorecard, tier }
```

Three things it does that calling `runClosingAudit` directly does not:

**Benchmarks are absent, not configured off.** Passing a null `getBenchmark`
still emits a `CANNOT_BENCHMARK` finding for every benchmarkable fee, which would
fill the report with a promise you are no longer making. The service drops those
findings and deletes `benchmarkable_count` and `cannot_benchmark_count` from the
scorecard. Leaving them at zero reads as failure rather than absence.

**A denominator that can actually be reached.** `"10 of 14 fees, no rate data"`
measures a corpus you do not have. The new headline counts **checks**:

> `8 of 27 checks ran. 9 need two quick answers from you, your Loan Estimate and your purchase contract.`

27 is reachable. 14-fees-with-rate-data never was.

**Price follows analysis that ran.** The catalog records which document each
check needs, so the upgrade price comes from checks that produced a result. An
unreadable LE stays at $29 and the page says why. A readable LE describing a
different loan also stays at $29, with a different explanation. There is a test
asserting the price never reaches $59 when no upgrade check produced anything.

### The catalog is the contract

`CATALOG` in `closing-service.js` lists all 27 checks with a customer-readable
label, a group, and the document each needs. It is the scorecard denominator, the
basis for the price, and the source of the upsell copy.

Two tests keep it honest by reading the engine source and comparing: one fails if
the engine can emit a `checkId` the catalog does not list, the other fails if the
catalog names a check the engine cannot emit. Add a check and forget the catalog,
and the build tells you.

### No dead-end upsells

Your note flagged *"needs the initial escrow account statement"* with nowhere to
upload one. Every blocked check now rolls up into an unlock that names a document
the page can accept:

```json
{ "title": "Upload your Loan Estimate",
  "why": "It is the only way to test whether a fee was allowed to increase...",
  "accepts": "loan_estimate",
  "unlocks_count": 6,
  "unlocks": ["No zero-tolerance charge increased", "..."] }
```

A test asserts every unlock has a `title`, a `why`, and an `accepts` — so a dead
end fails the build rather than shipping.

---

## 3. What a customer gets from a CD alone

Run against a CD with ordinary defects planted, no other documents, no benchmarks:

```
tier: basic $29
8 of 27 checks ran.

confirmed_mathematical_error  Monthly principal and interest does not match the stated loan terms
confirmed_mathematical_error  Disclosed APR is below the note rate, which is not possible
confirmed_mathematical_error  Total of payments is less than the scheduled payments themselves
confirmed_mathematical_error  Discount points charged do not match the percentage printed beside them
potential_trid_violation      Disclosed APR is lower than the disclosure's own figures support
potential_trid_violation      Disclosed finance charge is less than the interest the payments produce
potential_trid_violation      Total interest percentage does not agree with the payment schedule
```

Every one cites only the customer's own document. None is arguable, none needs a
rate table, and none has a 50-state problem.

---

## 4. Where I'd still push back

**You have swapped the question, not just the data source.** "Is this fee too
high?" is what customers arrive with, and this service does not answer it. What it
answers — *"is this document correct, and were the increases permitted?"* — is a
better product right now because it is **completable**. A partial benchmark
corpus advertises its own gaps on every screen. This does not.

But say so on the page. If the landing copy still implies fee benchmarking, the
$29 tier will generate refund requests from customers who expected a different
product. The `evidence_basis` string in the scorecard is written to be shown:

> Every finding is arithmetic or a regulatory rule applied to the documents you
> uploaded. Nothing here is compared against market averages or a fee database.

**The LE is your real product.** Six of the 27 checks need it, they are the ones
that produce refundable dollars, and TRID tolerance testing is already built and
is the strongest thing you own. I would make the LE upload the primary call to
action, not a secondary upsell — "upload both and we'll tell you what you're owed"
is a sharper pitch than anything CD-only.

**Benchmarks were never a 50-state problem.** You do not need thousands of
counties; you need the counties your customers are in. Coverage follows demand,
and `coverageFor()` in `benchmark-corpus.js` already reports which jurisdiction to
fill next. Worth revisiting once you have traffic telling you where they are.

---

## 5. Ranked next, all document-only

1. **Cure-credit detection.** A lender credit labelled as a cure, or an
   unexplained "Lender Credits" line, is the lender's own admission that a
   tolerance basket was breached. Readable from the CD alone, and it converts
   directly into the LE upsell: *"your lender appears to have already refunded a
   tolerance breach — upload the LE and we'll check the refund was complete."*
2. **Three-business-day delivery.** §1026.19(f) requires the CD three business
   days before consummation. You already extract the closing date; one question
   gets the receipt date. One of the few findings with a real remedy.
3. **Section placement.** A zero-tolerance charge sitting in Section C, or a
   lender affiliate listed as a shoppable provider, changes which tolerance
   bucket applies. Structural, no external data.
4. **Paid-by column integrity.** Borrower-paid and seller-paid columns must
   reconcile to the Summaries of Transactions on page 3. Pure arithmetic.

---

## 6. Automation

**Fail the deploy on a broken audit.** Add to `vercel.json`:

```json
"buildCommand": "node test/run-all.js"
```

Right now a broken corpus or a catalog drift degrades silently in production.
90 assertions run in under a second.

**The catalog tests are your regression suite skeleton** (open issue #3). They
already read the engine source and fail on drift. The ~50 anonymised CDs hang off
the same runner — plain `node`, no framework, no install step.
