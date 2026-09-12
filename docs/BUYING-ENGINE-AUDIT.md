# Buying Engine Audit

Engineering notes on how `api/_lib/purchase-engine.js` fails to *produce* a
report, as opposed to how a report contradicts itself. The consistency side is
[REPORT-CONSISTENCY-AUDIT.md](REPORT-CONSISTENCY-AUDIT.md), which sets the tag
leak aside as a generation failure; this is where it is tracked.

Covers the five generation defects found and fixed on 2026-09-09, and eleven
live production runs across all three categories. Written up on 2026-09-12.

If you are an AI assistant picking this up: the last section is the one that
matters. Three of these five defects produced clean-looking, fully-passing
output, and none of them was caught by a green test suite.

## The one thing to understand before trusting a green run

**This engine fails by producing plausible output.** It does not usually throw.
A leaked response is detected and repaired, an abandoned verification still
yields a report, a corrupted requirement still gets graded. Every one of those
paths ends in a row marked `complete` and a report that reads fine.

Of the five defects below, two were found by reading the *text* of a generated
report, one by reading a CI log that had been red for three commits, and only
two by something failing. The metric is not completion.

## The defects

| # | Defect | Symptom | Fixed in |
|---|---|---|---|
| 1 | Whole-response tag leak | ~3 attempts in 4 returned the tool input as parameter-tag text | `9ad23fa` |
| 2 | Verification ate the invocation | 3 attempts, 3 × 300s timeouts, no report, `job_state` null | `72df99d` |
| 3 | Verification budget set too low | Must-have checks silently downgraded on 2 of 3 categories | `3201f96` |
| 4 | Thousands separator split a requirement | "at least 7,000 lbs" graded as "at least 7" | `5029983` |
| 5 | `unref`'d abort timer | Abort never fired if nothing else held the event loop | `3201f96` |

Defects 3 and 5 were introduced by the fix for defect 2. That is worth stating
plainly: two of the five were self-inflicted, and both shipped.

## 1. The whole-response tag leak

`submit_purchase_report` came back with its nested objects serialised as
parameter-tag text instead of JSON — often all six at once, one fragment each.
Measured baseline: **9 leaks in 12 attempts, then 4 in 4.**

Four fixes had already failed against it:

- a prompt instruction not to do it;
- renaming the field the leak kept naming (the leak followed the new name);
- removing the literal tag syntax from the prompt, on the theory that showing
  the syntax primed it — the rate went 4-in-4 after;
- giving the model extended thinking as a scratchpad for its arithmetic.

**What settled it was a natural experiment already running.**
`submit_must_have_checks` lives in the same file, runs on the same model, with
the same `web_search` tool attached — and asks for an *array of objects with
five required fields each plus a nested optional object*. It has never leaked.

So neither nesting depth nor search-result context is what breaks, and the
search-off diagnostic that `ff6c910` had removed the env-var lever for never
needed running. The one structural feature the report tool had and
`must_have_checks` does not was **six sibling object-valued top-level fields**.

The fix flattens the wire schema to 25 top-level scalars and lists.
`cost_breakdown` stays an array of objects deliberately — `must_have_checks` is
that exact shape and is the evidence it is safe.

**The change is confined to what the model is asked to emit.** `nestReportInput`
folds the flat input back into the nested shape at the boundary, so the
arithmetic checks, every repair path and `mapToGenericReport` — all hardened
over the incidents in the consistency audit — were not touched.

Two things needed real thought rather than translation:

- `leakedFlatSections` replaces the old whole-response detector, which relied on
  a signal flattening destroys (a field declared an object arriving as a
  string). It now asks what the schema can still answer: content that is *gone*
  — the whole value was tag text, or a number/boolean/array field arrived as a
  string carrying tag text, or an enum value fell outside its enum. A stray
  fragment on otherwise-good prose stays the cheap sanitise-and-continue case,
  with a test pinning that, because turning those into whole-response retries
  would discard reports that only needed a strip.
- `toolUseResponse` in the tests flattens on the way out, so all 26 existing
  stub sites exercise the new path unedited. The test file states the field
  mapping *independently* of `FLAT_TO_NESTED` — a wrong entry applied in both
  directions would otherwise be invisible.

## 2. The verification that ate the invocation

Submission `72100718` — a financed F-150 with a towing figure and adaptive
cruise to check — failed three times running, each with `Vercel Runtime Timeout
Error: Task timed out after 300 seconds`, and `job_state` still null afterwards.

**That null is the diagnostic.** Nothing was ever cached, so every attempt
re-ran the same verification, died in the same place, and never reached the
report call at all. Three attempts, no report.

`486d602` had already added the verification cache and the hand-back for exactly
this, but both engage only once the verification *succeeds*. Its own comment is
explicit that a failed verification caches nothing, so handing back would loop
forever. That reasoning was right. Its remedy — push on into the report with
whatever time is left — rested on "it cost little when it failed", and that is
untrue of the failure that matters: a verification that runs until the platform
kills the invocation costs all 300 seconds and never reaches the line meant to
save it.

Two changes, neither sufficient alone:

- **A budget.** `verifyMustHaves` runs against an absolute deadline on an
  `AbortController`, shared across both its requests and its step-down retries
  so they cannot each start a fresh one.
- **A marker.** An abandoned verification is written to the row, and later
  attempts skip it. That is what makes handing back safe, so the failure path
  hands back too and the report gets a full clean invocation with the
  requirements marked unchecked.

The customer trades a verified must-have for a report that exists — the same
trade the engine already makes when verification returns nothing.

## 3. The budget regression

The budget shipped at 120s, justified in its own commit message with "the two
that succeeded in that same batch were done well inside it". **That was
asserted, not measured, and the measurement was already available and said
otherwise.**

A verification holds its invocation open until it answers, so the duration of
the first poll *is* the duration of the verification. The two that had
succeeded took **128s** and **166s**. The bound was set below the thing it
existed to permit.

On the next run both were killed at the budget. The LG fridge had been
correctly reporting a failed deal-breaker — no internal water dispenser,
verdict RECONSIDER, the finding in its own headline — and came back "0 of 2
confirmed" instead. Honest, and far less than the customer paid for. Two of
three categories were downgraded this way and it shipped.

Raised to **240s**. The ceiling was never the report's: a verification that
answers hands back, and since `72df99d` one that is abandoned hands back too,
so it never shares an invocation with the report either way. The budget only has
to fit inside the 300s platform limit with room to write the marker.

A test now holds the constant from both sides — `>= 200000` so it clears the
slowest verification observed to succeed, `<= 280000` so the hand-back still
fits. Observed durations, since a fixed budget is a guess against them:

```
34s   55s   116s   128s   166s   >242s (F-150)
```

The vehicle category is the one that loses its verification. It graded 2 of 2
with sources on one run and was abandoned on the next. That variance is real.

## 4. The thousands separator

`mustHaveFragments` split on every comma, so

```
"must tow at least 7,000 lbs, and must have adaptive cruise control"
```

became **three** requirements: `"must tow at least 7"`, `"000 lbs"`, and the
cruise control.

The visible symptom was a miscount — the report said "0 of 3 confirmed" under a
headline saying "both". The count was the least of it. The towing requirement
had been silently rewritten into one about **7 lbs**, which every truck
satisfies, and it was in that form that it went to the model to be graded and to
the customer to be read back. `"000 lbs"` was shown to them as something they
had asked for.

This is the exact failure the must-have section exists to prevent —
`MUST_HAVE_TOOL`'s own description says a buyer told their deal-breaker is met
goes and buys the thing. A verdict of "confirmed" against *"must tow at least
7"* would have been true, useless, and indistinguishable from the answer they
needed.

The comma is masked and restored rather than matched around, because the text
has to survive into the fragment: it is quoted back to the customer and sent to
the model as the requirement to check, and `"7000 lbs"` is not what they wrote.
Only a comma between a digit and exactly three more digits is protected, so
`"internal ice maker, no external dispenser"` still separates.

**Found by reading a live report, not by anything failing.** The report
generated cleanly on its first attempt and both graded requirements were wrong
in a way only visible by reading the requirement text.

## 5. The `unref`'d abort timer

The abort timer added in defect 2 was `.unref()`'d, on the reasoning that a
pending timer must never be the reason a lambda stays up. `clearTimeout` in the
`finally` already guaranteed that, so `unref` bought nothing — and cost
correctness.

**An unref'd timer does not hold the event loop open.** If the request in flight
is not holding it either, Node exits before the deadline can fire, the abort
never happens, and the awaited promise never settles.

A real `fetch` holds an open socket, so production hid this completely. A
stubbed `fetch` holds nothing, so the test process simply ended mid-suite:
`purchase-engine.test.js` reported 125 passed and then every test from 126
onward as `not ok`, because they never ran.

Whether it reproduced depended on whether anything else happened to be keeping
the loop alive — which is why a laptop and the Vercel build container both said
green and a clean CI runner did not. **CI was red from `4aeaadb` through two
merges to `main` while every signal being looked at said pass.** The PR page
read "2 successful checks"; those two were Vercel's, and the test suite is a
third check. See [green-checks-are-not-one-signal] in the session memory.

Isolated before fixing: an otherwise-idle process running one verification
against a stubbed fetch exits without the call ever settling; with `unref`
removed it settles in 3ms and returns `null`.

## Method, and how much to trust it

Eleven live production runs across the three categories, producing ten reports.
Each run drove a real submission through `navigator-intake` → flip to `paid` in
Supabase → poll, against whichever production build was current. Leak rate was
read from `job_state.malformed_responses` and the engine's own refusal log line,
which still counts in "N of 6 sections" *specifically* so the rate stays
comparable to the pre-flattening baseline.

**No leak in any of the eleven**, against a baseline of 9-in-12 then 4-in-4.

How much that is worth: less than it looks, and the reason is not sample size
alone. **An unknown number of those eleven runs never reached the report call**,
because the verification consumed the invocation first — so the count of actual
`submit_purchase_report` responses behind "no leak in eleven" is smaller than
eleven and was not instrumented. Against a baseline where the failure was the
dominant mode, a clean sweep is real evidence; it is not the same as having
measured the new rate. **If the leak recurs, this sample is why you should not
be very surprised.**

Each fix was mutation-checked rather than trusted because the suite was green:

- add an unmapped field to the flat schema → the structural test fails
- swap `resale_low`/`resale_high` in the mapping → an existing arithmetic test
  fails
- remove the abandoned-marker → the suite polls forever
- remove the abort → the suite hangs outright (`timeout` exit 124)
- restore the naive comma split → all three parser tests fail

142 tests in `purchase-engine.test.js`, 27 suites green, CI green.

## What this does not cover

- **Report quality.** The arithmetic gates catch internal contradiction, which
  is a real guarantee, and every figure spot-checked during these runs
  reconciled to the dollar. They cannot catch a plausible wrong figure.
- **Later work on this engine.** `99f03b5`, `1d6bfcd` and `d204f4c` changed
  delivery, the paid-submission queue and outage handling after this audit.
  Those are about getting a finished report to a customer, not about generating
  one, and are not assessed here.
- **Whether the vehicle category is reliable enough.** It is the one whose spec
  lookup runs long enough to lose its verification, and it produced the only
  no-report run in the set.
- **The other Navigator products.** Only `buying` is covered.
