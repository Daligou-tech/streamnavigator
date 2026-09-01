# Closing Disclosure Audit

Engineering notes for the `closing` product. Everything here describes what is in
`main` today.

## Why this is built the way it is

The original implementation was a single ~150-word prompt asking the model to
judge fees "grounded in general knowledge of standard closing-cost tolerances."
That is the model's priors sold to a customer as analysis. It will confidently
produce a benchmark for a county it knows nothing about.

The rebuild splits the work three ways, and the split is the whole point:

| Stage | Who | Where |
|---|---|---|
| Extract what is printed | model | `api/_lib/closing-extract.js` |
| Decide what is wrong | code | `api/_lib/closing-audit.js` |
| Write it up | model | `api/_lib/navigator-engine.js` |

Every flag, dollar figure, threshold, severity and citation comes from
deterministic code with a stated basis. The model never originates a number.

This is enforced structurally, not by instruction. `compareToBenchmark(label,
charged, benchmark)` takes the benchmark as an argument; when it is `null` the
function returns `cannot_benchmark`. There is no path where a missing benchmark
becomes a guess.

## Request flow

```
POST /api/closing-scorecard    (free, pre-payment)
  rate limit check  -> insert submission -> store files
  -> model extraction -> deterministic audit -> scorecard
  -> form_data { ip_hash, extraction, scorecard }

POST /api/closing-answers      (free)
  -> form_data.answers { property_type, provider_list }

Stripe payment -> api/navigator-stripe-webhook.js
  -> generateNavigatorReport() reuses the stored extraction,
     re-runs the audit with the answers, model writes the report
```

The scorecard runs before payment on purpose. An illegible scan or a document
that is not a Closing Disclosure is caught while it is still free.

## Storage

No dedicated tables. Everything lives in the existing `form_data` jsonb column on
`navigator_submissions`:

- `ip_hash` — salted SHA-256, used by the rate limiter
- `extraction` — the structured CD, reused by the paid report so the PDF is not
  read twice
- `scorecard` — what the customer saw for free
- `answers` — the two Step 2 questions
- `stage` — `scorecard` | `answered`

Any code that overwrites `form_data` must preserve `ip_hash`, or the IP counter
silently stops working.

## The two questions are load-bearing

**Property type / occupancy** drives HOA and condo questionnaire charges, escrow
requirements, and investment-property handling.

**Written list of service providers** decides the TRID tolerance bucket for
shoppable services. Under 1026.19(e)(3)(ii) the 10% bucket is only available when
the creditor actually delivered the written list; without it, good faith is
measured under (e)(3)(i) — zero tolerance, where any increase is a potential cure.

"Don't know" is not treated as "yes." Only an explicit yes unlocks the 10% bucket
(`normalizeProviderListAnswer`). There is a test proving the same 600 → 695
increase is within tolerance with a list and a potential $95 cure without one.

## Extraction confidence

Anything read below 0.85 confidence is discarded, not used, and surfaced to the
customer as an extraction warning naming the page. Checks whose inputs are
missing are reported as `skipped` rather than silently passing.

## Rate limiting

`api/_lib/rate-limit.js`. Three layers: per email (3/hour, 8/day), per IP (6/hour,
20/day), global (250/day). The global cap is the only one that bounds spend
against a distributed script.

At roughly $0.05–$0.15 per scorecard, 250/day caps a worst-case day near $12–38.
Tune via the `LIMITS` object at the top of the file. Raise it when legitimate
customers start hitting it — visible as 429s in the Vercel logs.

Checked before the row is inserted and before the model call, so a blocked
request costs nothing. Fails open on a database error. Set `RATE_LIMIT_SALT` in
Vercel to make IP hashes unguessable.

## Tests

```
npm test                            # whole repo
node --test tests/closing-audit.test.js tests/closing-scorecard.test.js tests/rate-limit.test.js
```

71 tests across the three closing suites. Every expected value is hand-computed
and stated in a comment above the assertion.

Three failures in `tests/purchase-engine.test.js` predate this work and are
unrelated.

Two tests are guardrails rather than checks:

- `the scorecard never leaks a flagged fee name or its dollar impact` — fails
  loudly if anyone widens the free payload into the paid product.
- `a normal customer is never blocked` — fails if the rate limits are tuned down
  too far.

## Known limitations

**No benchmark corpus.** `compareToBenchmark()` is wired and tested with an
injectable data source, but nothing is loaded, so every benchmarkable fee returns
`cannot_benchmark`. This is the main product gap: "am I paying more than I should"
cannot be answered until the corpus exists. Everything else — arithmetic,
per-diem interest, escrow cushion, prorations, duplicates, fee stacking,
tolerances, contract reconciliation — works with no external data.

**LE-to-CD fee matching is fragile.** Charges match on a normalized
`category:label` key (`chargeKey`). "Settlement Fee" on the LE and "Title -
Settlement Fee" on the CD will not match, and the CD charge is then treated as
absent from the baseline — reporting the *full amount* as an increase. That is a
large, confident false positive. Needs fuzzy matching plus a reviewable "we
matched these lines" step before LE upload is offered to customers.

**9MB total upload cap.** `MAX_FILES` is 12 but `MAX_TOTAL_BYTES` is 9MB, to stay
under Vercel's request body limit. Scanned CDs run 2–4MB, so a CD plus contract
plus several Loan Estimates will be rejected. The fix is direct-to-storage upload
with Supabase signed URLs.

**Business-day definition is unresolved.** `businessDaysBetween()` implements both
the precise definition (all calendar days except Sundays and federal holidays) and
a general one, and defaults to the more conservative count. Which governs the
4-business-day rule in 1026.19(e)(4)(ii) should be confirmed by counsel before it
drives customer-facing output.

## Legal posture

The strongest severity the system can reach is `potential_trid_violation`. It
never states that a fee is illegal, never promises a refund, and never calls a
charge excessive without a stated basis. Findings carry an actionability label —
changeable before closing, likely locked, potential post-closing remedy, or needs
documentation — so the report does not imply everything is still negotiable.

The generated lender and settlement-agent emails have not been reviewed by
counsel. Worth doing before this is promoted, along with the refund policy for
audits that return mostly `cannot_benchmark`.
