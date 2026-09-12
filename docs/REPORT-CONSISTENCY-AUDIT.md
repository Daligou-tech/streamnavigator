# Report Consistency Audit

Engineering notes on whether a Navigator report contradicts itself. Covers
`buying`, `closing` and `hoa` as they stood on 2026-09-08, and why two of the
three turned out to be immune to a class of bug that took a full day to clear
out of the third.

If you are an AI assistant picking this up: read this before adding a check to
any report engine. Most of the checks it describes exist because a defect
shipped, and several exist because an earlier check was written wrong.

## The one thing to understand before adding a check

**A product that computes its numbers cannot contradict itself. A product that
asks a model for them will, and no amount of checking fully fixes that.**

`closing` and `hoa` compute. `closing-math.js` derives the per-diem, the
amortisation, the escrow cushion; the model is handed findings and writes them
up. Twenty-one figures were re-derived by hand from a live HOA report and
twenty-one reconciled. Nine from a live closing report, nine reconciled.

`buying` asked the model for the arithmetic, and produced, across one day of
live runs: a total that disagreed with its own line items, a fuel cost stated
twice ~$3,000 apart, a resale figure out by a factor of two against the section
written for it, and a recommendation asserting a deal-breaker was satisfied when
the manufacturer's own page said otherwise.

Every fix that stuck moved a quantity to having one home and computed the rest.
Every fix that only *checked* two written numbers against each other moved the
contradiction somewhere else — usually into a field nobody was watching yet.

## The contradiction classes

Found in `buying`, in the order they surfaced. Each is worth testing for in any
new report product.

| # | Class | What it looked like |
|---|---|---|
| 1 | A total contradicting its own parts | Headline `$52,000–$68,000` over a breakdown summing to `$47,000–$57,700` |
| 2 | One quantity stated twice, differently | Fuel at `$9,000–$11,000` in one section, `$900–$1,100/yr × 7` in another |
| 3 | A figure contradicting the section written for it | Resale `$6,000–$8,000` in the breakdown, `$16,000–$18,000` in the depreciation section |
| 4 | A fact asserted from memory, not checked | "no external dispenser" — LG's own page lists a Tall Ice & Water Dispenser |
| 5 | A required field satisfied emptily | `assumptions: []` under a seven-year total whose inputs were all assumed |
| 6 | Research advertised but not performed | Page promises live research; `research_notes` empty, zero `server_tool_use` blocks |

Classes 1–3 are arithmetic and yield to structure: state a quantity once, derive
the rest, check the derivation. Class 4 is not arithmetic and needed a separate
verification call with sources. Classes 5 and 6 are honesty defects — the report
claiming more than it did.

## What the audit found in `closing`

Report `7bfbe27c`, submission `c764be16` — a real Closing Disclosure with four
findings totalling $4,032.78.

Nine independent re-derivations, all exact:

- per-diem `300,000 × 6.5% ÷ 365 = $53.4247` against a stated `$53.42`
- sixteen days `= $854.79`, and the charged `$1,175.24` implies `22.0` days
- escrow cushion `5,650 ÷ 6 = $941.67`; excess `1,354 − 941.67 = $412.33`
- underwriting fee `1,095 − 795 = $300`
- monthly P&I on `$300,000 / 6.5% / 360` computes to `$1,896.20`, as disclosed
- total of payments `360 × 1,896.20 = $682,632`
- finance charge `682,632 − 296,479.76 = $386,152.24`
- total interest percentage `(682,632 − 300,000) ÷ 300,000 = 127.5%`
- the four findings sum to `$4,032.78`, matching the key number exactly

**One real defect, fixed in `0ba27bc`.** The report carried two independently
written versions of the same customer letters. `api/_lib/pdf-report.js` renders
`report.emails` — assembled in code from the audit's figures. `navigator-status.html`
rendered `closing_body`, which the model wrote itself. They differed in subject,
tone and wording:

```
assembled (PDF)   Subject: Closing Disclosure: 3 questions before signing
                  "I may well be reading something wrong, so I would
                   appreciate your help squaring these up."

model's (page)    Subject: Closing Disclosure — Three Items Requiring Correction
                  "I've had my Closing Disclosure independently audited"
```

Both are letters the customer signs and sends to their own lender. A voice fix
made to `closing-emails.js` that morning reached only the PDF copy, because
nobody had noticed there were two. `navigator-engine.js` now renders the
assembled letters into `closing_body` as well.

The split was *documented* in the header of `closing-emails-voice.test.js`,
which reasoned that only the PDF version is emailed. That was accurate and
beside the point: the on-screen copy sits under a heading reading "Ready-to-send
emails" with the customer's name at the bottom.

## What the audit found in `hoa`

Report `a27cde5f`, submission `9dca5332` — three HOA documents read together.

Twenty-one re-derivations, all reconcile. A sample:

- reserves `412,000 ÷ 1,830,000 = 22.5%`
- fund at roof replacement `412,000 + 2 × 84,000 = $580,000`; gap `$380,000`
- per unit `380,000 ÷ 120 = $3,167` — the source of the board's "approximately $3,200"
- funding the study in full still falls `$152,000` short by 2028
- reserves-only funding needs `$274,000/yr`, or `$190` per unit per month
  against the `$58` currently going in
- with an 11.4% budgeted collection loss, an assessment netting $380,000 must
  bill `$3,574` per unit
- ten years at 7.25% on $380,000 → `$53,535/yr`, `$446` per unit, `$155,350`
  total interest, against the report's "about $155,000"

**No defects found.** Two figures looked wrong on first pass and were not: bid
overruns of 10% and 20% are applied to the *roof cost* and the gap re-derived
(`1,056,000 − 580,000 = 476,000 → $3,967/unit`), which is the correct modelling.
The auditor — me — had applied the uplift to the per-unit figure.

`hoa` also labels every derived figure "(our calculation)", distinguishing what
it worked out from what the documents say. Worth copying.

## Method, and how much to trust it

Both reports were read out of `navigator_reports` and re-derived by hand rather
than regenerated, so this audit cost nothing and reflects engine behaviour as of
2026-09-08. `buying` was checked differently — nine live runs across all three
categories, by a script that parses the *rendered* report and recomputes every
invariant, because an engine checking its own output proves nothing.

That script was wrong five times before its verdicts meant anything:

- it read the `7` out of `"Total over 7 years — $50,100"` as money
- it read `-$11,000` as positive, the minus sitting before the `$`
- it read the hyphen in `$49,500-$64,500` as a minus sign
- it treated a prose sentence containing an em-dash as a line item
- it lacked the field-level exemption the engine has, so it flagged the
  customer's own quoted price

Two of those are the same mistakes the engine had made earlier the same day.
**A checker is not exempt from the thing it is checking for**, and its clean
verdicts are worth something only because each false positive was traced to
source before being dismissed rather than waved away.

## What this does not cover

- `contractor` and the remaining Navigator products were not audited.
- `buying`'s tag-leak failure (the model returning its whole tool input as
  parameter-tag text) is a *generation* failure, not a consistency one, and is
  tracked in [BUYING-ENGINE-AUDIT.md](BUYING-ENGINE-AUDIT.md). It was traced to
  six sibling object-valued fields in the report schema and flattened on
  2026-09-09.
- One `closing` report and one `hoa` report is a small sample. Neither product
  showed a contradiction, but "none found in one report" is not "none exists".
