# Maryland benchmark corpus + jurisdiction canonicalisation

Closes most of open issue **#1** (empty benchmark corpus) and all of **#2**
(non-determinism) for Maryland. Nothing here touches the four files already
pending deploy, so it can go in before or after them.

## Files

| File | Status |
|---|---|
| `api/_lib/md-jurisdiction.js` | new |
| `api/_lib/benchmark-corpus.js` | modified — 3 additive changes |
| `data/benchmarks.json` | regenerated, 2 rows → 48 |
| `build-md-corpus.js` | new — regenerates the Maryland rows |
| `test/md-benchmarks.test.js` | new — 43 assertions, no dependencies |

`node test/md-benchmarks.test.js` → `43/43 passed`.

## What the data covers

23 of Maryland's 24 taxing jurisdictions, both recordation tax and local
transfer tax, plus the state transfer tax. On a resolved county the audit can
now state the full statutory total for a deed instead of reporting
cannot-benchmark.

Sources are the publishing authorities, not a summary:

- Rates: Maryland Department of Legislative Services, *Other Local Tax Rates
  in Maryland* (2026 edition), FY 2026 columns —
  `https://dls.maryland.gov/pubs/prod/NoPblTabPDF/2026CountyLocalTaxRates.pdf`
- State transfer tax and clerk recording fees: Maryland Judiciary, Clerk of the
  Circuit Court — `https://www.courts.state.md.us/clerks/wicomico/recordingfees`
- Purchase-money exemption: Tax-Property Article §12-108(i)(3)

The rate table is transcribed once, in `build-md-corpus.js`, and all 48 rows are
derived from it programmatically, so no county can pick up a neighbour's rate
through a copy-paste slip.

**Recordation tax is carried in the `transfer_tax` category.** On a Maryland
deed the state transfer tax, the local transfer tax and the recordation tax are
three separate taxes on one instrument, and the audit already tests that
category in aggregate. Splitting them would compare a partial benchmark against
a full charge.

**A purchase-money deed of trust is exempt from recordation tax** under
§12-108(i)(3), so recordation is modelled once, on the deed, against sale price.
This was worth checking: taxing the loan amount as well would have roughly
doubled every Maryland benchmark.

## Three things I deliberately did not ship

**Montgomery County.** DLS records both its rates as "Varies". Recordation is a
base rate plus a school increment plus a premium stepping at
$500k/$600k/$750k/$1M, and published sources disagree on whether those brackets
are marginal — I found $4.45, $5.05 and $25.73 per $500 all asserted for the
same county. Montgomery is high-volume and high-dollar, so a wrong row there is
the most expensive row in the corpus. It needs someone to read the county code
directly. This is the single highest-value remaining gap.

**Anne Arundel at $1M and above.** 1.0% below $1M is certain and shipped. The
0.5% surcharge at $1M is real, but whether it applies to the whole consideration
or only the excess is not settled by the DLS footnote, so the top bracket is
absent and the row returns nothing there. The audit already skips transfer-tax
testing above $1M anyway.

**The clerk recording fee is loaded but dormant.** Maryland sets it statutorily
at $60 per instrument ($20 for a principal residence plus the $40 Chapter 538
surcharge). It uses a new `per_instrument` kind that returns nothing unless
`instrumentCount` is supplied, and nothing supplies it yet. Two things are
needed before it goes live, and the order matters:

1. The extractor must not categorise a Maryland *"State Recordation Tax"* line
   as a `recording_fee`. It is a tax in the thousands; the recording fee is
   $60. If those collide, every Maryland CD reports a fabricated overcharge.
   Suggested guard in the category description: *a line whose label contains
   "recordation" is a transfer tax, never a recording fee.*
2. Instrument count needs extracting. Section E normally itemises it
   ("Deed: $X  Mortgage: $Y").

Leaving it inert means the row is written, tested and reviewed now, and flipping
it on later is a one-line change rather than a research task.

## Bug found in `stacked()`

Pre-existing, and it would have caused false overcharge findings the moment this
data landed. For a county the corpus does not model, `stacked()` still matched
the **state-level** rows and returned a partial total — for Maryland, the 0.5%
state transfer tax alone, with county transfer and recordation silently missing.
Every correct charge would then exceed that total and be reported as an
overcharge. Montgomery County would have hit this on day one.

`stacked()` now refuses when the corpus models county rows for a category in
that state and the requested county is not among them. Covered by the test
*"a county with no rows returns nothing"*.

## Issue #2: how the non-determinism is actually fixed

The old `norm()` lowercased and stripped a trailing "county", so
`"Baltimore County"` and bare `"Baltimore"` both folded to `baltimore` and
matched Baltimore **County** — half Baltimore City's recordation rate. On a
$400k sale that is a silent $2,000 error, and which one you got depended on the
extraction run.

`canonicalizeMdCounty()` resolves aliases deterministically (`PG County`,
`St Marys`, `Prince Georges`, `Allegheny`, municipality names, and so on) and
treats bare `"Baltimore"` as **ambiguous rather than guessing**. Baltimore
County has no town called Baltimore, but USPS assigns the mailing city
"Baltimore, MD" to much of the county, so the address does not settle it either.
When the county field is ambiguous the lookup falls back to the city parsed out
of `property_address`, and failing that returns no benchmark at all. A visible
gap is a bug report; a silent 2x error is a refund.

One line at each of the two call sites in `closing-extract.js` will feed the
fallback:

```js
county: e.property_county,
propertyAddress: e.property_address,   // <- add
```

Better still, tighten the extraction schema so the ambiguity rarely arises:

```js
property_county: {
  type: 'string',
  description: 'Maryland only: Baltimore City and Baltimore County are separate '
    + 'taxing jurisdictions with different rates. Return "Baltimore City" or '
    + '"Baltimore County" explicitly, never bare "Baltimore".',
},
```

## Before this drives paid findings — one thing I could not verify

These are FY 2026 figures. **FY 2027 began 1 July 2026** and DLS has not
published an FY 2027 column yet, so this is the latest published data but may
already be superseded by county budget ordinances. Charles County moved
$5.00 → $7.00 at the FY 2026 boundary, so movement is not rare.

The rows carry `stale_after_days: 120`, expiring **31 December 2026**, at which
point they stop answering rather than quoting last year's rate. That is a
backstop, not a substitute for a spot-check of a few counties' adopted FY 2027
ordinances.

## Automation worth setting up

**Turn the annual re-verification into a diff review.** The DLS URL is
predictable (`{YEAR}CountyLocalTaxRates.pdf`). A scheduled job each August can
fetch the new edition, re-run `build-md-corpus.js` against it, and open a PR
containing only the changed rates. That converts the recurring cost of this
corpus from data entry into reviewing a handful of lines — and it is the same
shape of job for every state added later.

**Fail the build on a stale or invalid corpus.** `makeGetBenchmark` already
throws on a bad corpus, but only at request time on Vercel, where it degrades to
"all fees cannot-benchmark" and nobody notices. Add
`node test/md-benchmarks.test.js` to the build command in `vercel.json` so a
broken corpus fails the deploy instead of quietly disabling the product's core
promise.

**Alert before rows expire, not after.** Staleness is already modelled per row.
A weekly cron that lists rows expiring within 30 days turns a silent capability
loss into a calendar item.

**Issue #3 (regression suite) has its skeleton here.** This test file is the
pattern: plain `node`, zero dependencies, hand-checked expected values. The
~50 anonymised CDs can hang off the same runner rather than pulling in a
framework.

## Suggested commit

```
Maryland benchmark corpus (48 rows) + deterministic jurisdiction resolution

- 23 of 24 MD jurisdictions: recordation + local transfer tax, from the
  DLS FY2026 table; state transfer tax and clerk fees from the Judiciary
- canonicalise MD county names; treat bare "Baltimore" as ambiguous
- fix stacked() returning a partial state-only total for unmodelled counties
- add per_instrument row kind; MD clerk recording fee loaded but dormant
- 43 assertions, no test dependencies
```
