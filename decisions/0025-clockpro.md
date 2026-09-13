# 0025 -- ClockPro: the tenth member, the CLOCK approximation of LIRS, D25

Status: accepted (S18 -- the clock-approximation member; recency-of-recency on a clock with a
0-link-write hot path and a self-tuning hot/cold split)

## Context

S18 adds `ClockPro` as the tenth `LiteCache<K,V>` family member: CLOCK-Pro (Jiang, Chen &
Zhang, USENIX ATC'05). ClockPro is to `Lirs` (decisions/0023) what CLOCK is to LRU: it
APPROXIMATES LIRS's exact inter-reference-recency ordering with ONE circular list + per-page
reference bits + moving hands, trading LIRS's O(1) stack surgery on a hit for a single
reference-bit store and no relink at all. That makes its hot path the Sieve/S3Fifo headline --
0 link writes, 1 state store -- while keeping LIRS-grade scan/loop resistance and, unlike
LIRS, a SELF-TUNING hot/cold split (no fixed L_hir/L_lir reserve).

It rides the SAME `SlotStore` substrate (decisions/0011) via the shared `newStore` factory:
default Map backing, opt-in `keys:'int'` strict-zero backing, the `[lite-lru]`-tagged int-key
door, the conservation invariant, the onEvict fire-after + `_inOnEvict` reentrancy guard
(decisions/0002), TTL (decisions/0017), zero-GC iteration (decisions/0018), opt-in stats
(decisions/0019) and snapshot/restore (decisions/0021). No new file; `ClockPro` is a named
export in `Lru.js`.

## The decision -- D25

### D25.1 -- ONE circular list, per-page state bits, three hands

The clock is ONE list threaded through the shared `_next`/`_prev` columns (this member makes
them circular in traversal). Per-slot state lives in a member `_st` Uint8 byte (like LIRS's
`_st`, NOT a field on the shared SlotStore -- the other members' hot paths stay byte-identical):
bit0 hot(1)/cold(0), bit1 referenced, bit2 test (a cold page in its test period). A hot page is
never in a test period, so `HOT | TEST` is an invalid tag (validate rejects it). Three hands are
Int32 slot pointers on member fields: `_handCold` (eviction), `_handHot` (hot demotion),
`_handTest` (test-period expiry). NEVER `new` on the hot path; the bounded non-resident history
(D25.2) is a preallocated ring, fail-closed on the honest bounds.

REALIZATION NOTE (a documented deviation from the literal "physically circular" reading, taken
with reason). The circular clock is realized as a NIL-terminated doubly-linked list
(`_head` = newest .. `_tail` = oldest) whose hands WRAP: `_advance(_tail) -> _head`. The
TRAVERSAL is circular (a clock has no ends -- the defining CLOCK property), while the NIL
terminus lets `ClockPro` reuse the family's shared iteration (`CacheIterator`), conservation
(validate's default recency descriptor) and snapshot (`snapList`/`snapLink`/`snapRestoreList`)
machinery BYTE-FOR-BYTE, exactly as the planner's brief anticipated ("reuse `_next`"). A
physically-cyclic `_next[_tail] === _head` would force custom re-implementations of ALL of those
shared helpers (each assumes a NIL terminus), multiplying surface and divergence risk for zero
behavioural gain. validate() asserts the logical closure instead: every hand references a
resident slot (never dangles), |hot| + |cold| == size, and the ring is a coherent head..tail DLL
(term 3/4). This is the ONLY deviation from the D25 rulings and it is behaviour-preserving.

### D25.2 -- BOUNDED non-resident history (the honest deviation, mirrors Lirs D23)

Textbook ClockPro interleaves non-resident cold pages (test pages) INTO the circular clock and
uses HAND_test to walk and expire them, bounding the total metadata at 2*capacity. We instead
keep the non-resident test pages in a SEPARATE keys-only bounded ring (`ClockProHistory`, a
generalization of `ArcGhost`), cap = capacity, drop-oldest, reusing the same strict-zero int
ring / amortized Map-backed Set the S3-FIFO/TwoQ/Arc/Lirs ghosts use. A non-resident cold page
is "still remembered" iff its key is still in this ring. This is the SAME bounded, honest
deviation Lirs (D23) took over the unbounded textbook stack: it is NOT interleaved into the
clock, and we do NOT claim textbook-exact metadata behaviour. It keeps every column fixed-size,
never grown, and the retention story clean (keys only, never values). The t6 gate proves the
history ring never grows; validate() proves `hist._len <= capacity`.

### D25.3 -- ADAPTIVE integer hot target `_mHot` (0..capacity), O(1) updates

The hot/cold split self-tunes through a single integer `_mHot` (the target number of resident
hot pages), 0..capacity, following the paper's direction:

  - a re-admit of a key still in the bounded non-resident history RAISES it (`_mHot = min(_mHot
    + 1, capacity)`): the page proved worthy (re-accessed during its test period), so favour
    more hot pages. It is also re-admitted directly as a HOT page.
  - HAND_test ending a resident cold page's test period WITHOUT a reference LOWERS it
    (`_mHot = max(_mHot - 1, 0)`): a test page expired unused, so we over-reserved hot capacity.

Both updates are O(1). HAND_cold consults `_mHot` when it promotes a referenced test page (if the
hot set would exceed `_mHot`, HAND_hot demotes one hot page back to cold), keeping the split
tracking the workload with no knobs.

### D25.4 -- RESIDENT value capacity is EXACTLY capacity (like Arc D16.2 / Lirs D23)

Only the hot/cold split moves; the resident value total is ALWAYS exactly `capacity` at
capacity. `_nHot + _nCold == size` is an invariant validate() checks (a fresh ring walk must
agree with the running counts). A capacity insert evicts exactly one resident before admitting
the newcomer (its slot reused in place, D6), so the total never drifts.

### D25.5 -- hot path = lazy promotion (the 0-link-write headline)

`get` (and `put` on an existing key) sets the reference bit ONLY: `_st[s] |= REF` -- 0
`_next`/`_prev` writes, exactly 1 `_st` state store. This is the Sieve/S3Fifo lazy-promotion
discipline, and it is what makes ClockPro cheaper on the hot path than LIRS (whose interior LIR
hit is a 5-write move-to-top-of-S) or classic LRU (a relink). `has`/`peek` are reference-neutral
(inspections, not accesses). The t6 Gate CLOCKPRO PINS this hot-path number (a real, proven
gate): a hit is `CLOCKPRO_WRITES_HIT_LINKS = 0` link stores + `CLOCKPRO_WRITES_HIT_ST = 1` state
store.

The EVICTION cost is honestly NOT a constant, and we do NOT pin one. A miss+evict is
**amortized O(1)** (the classic CLOCK amortization: HAND_cold and HAND_hot each clear at most one
reference bit per step and advance, so the work is charged to the references it clears), but
**worst-case O(capacity)** writes on a full-scan-then-insert -- fill to capacity, reference every
resident page (set every reference bit), then insert one new key: HAND_cold (and HAND_hot, to keep
the hot set within `_mHot`) must sweep the WHOLE clock clearing reference bits, ~2*capacity `_st`
writes (e.g. ~134 at cap 64, ~518 at cap 256, ~2054 at cap 1024). Unlike `Lfu`'s proven <= 14
writes/hit, ClockPro's eviction cost is genuinely O(capacity) in the worst case; "null is not zero"
/ fail-closed-on-unverified-state forbids pinning an unproven constant as a hard cap. Accordingly
`CLOCKPRO_WRITES_MISS_EVICT_TRIPWIRE = 64` is a per-STREAM regression TRIPWIRE on the t6 `cpStream`
corpus (a mixed recurring stream that never does scan-then-insert, worst-observed 37), NOT a bound
-- if a future change pushes the cpStream worst-observed past it, the tripwire fires so the
regression is investigated; it makes no claim about the true worst case.

### D25.6 -- snapshot captures the FULL clock + hands + `_mHot` + history verbatim

`dump()` captures the circular order (newest..oldest) + each page's `_st` byte, ALL THREE hand
positions, the adaptive `_mHot`, and the bounded non-resident history (keys only, oldest..
newest). `restore()` reconstructs every one, so a restored cache decides FUTURE evictions
identically to an un-snapshotted twin fed the same trace (D21.1). Dropping ANY of the hands,
`_mHot`, the test bits or the history is a fail-OPEN bug: the sweep would start from the wrong
place, the split would mis-tune, evicted pages would mis-record in the history, or re-admits
would mis-classify -- so the victim drifts. `restore()` fails closed on a malformed/short `st`
column, an invalid `_st` tag (0..7, never HOT|TEST), an `mHot` out of [0, cap], a hand that does
not reference a resident slot (or is set on an empty clock), and a history over its bound. Four
t9 controls prove the teeth: `clockpro-hands-dropped`, `clockpro-mhot-dropped` and
`clockpro-test-bits-dropped` each drop one aux post-restore and MUST diverge from the twin on the
round-trip differential; `clockpro-no-adapt` freezes `_mHot` and MUST diverge from the oracle.

## The DEBATE rebuttal

  - "you already ship Lirs -- ClockPro is a redundant recency-of-recency member." REBUTTED.
    Lirs is the EXACT inter-reference-recency ordering with an O(1)-but-multi-write stack move on
    a hit and a FIXED L_hir/L_lir reserve; ClockPro APPROXIMATES the same idea on a clock with a
    0-link-write hit (D25.5) and a SELF-TUNING split (D25.3). They are the exact/approximate pair
    for recency-of-recency, exactly as `Lfu`/`WTinyLfu` are the exact/approximate pair for
    frequency. Choosing ClockPro buys the cheapest possible hot path with adaptation; choosing
    Lirs buys exactness. Both belong.
  - "why ClockPro over CAR/CART, LRU-K or MQ?" REBUTTED. CAR/CART are the clock forms of ARC,
    which the family already covers with the exact `Arc` (decisions/0016) -- adding CAR would be a
    second adaptive-recency member with no new mechanism. LRU-K needs a per-page timestamp history
    (K entries/page) -- not zero-GC-friendly and O(log n) on the priority structure. MQ needs
    multiple LRU queues + per-page expiry timers -- more state, timer bookkeeping, no clean
    fixed-capacity story. ClockPro adds a genuinely NEW mechanism to the roster (a clock with
    reference bits approximating recency-of-recency) with the family's cheapest hot path.
  - "the bounded history is not textbook ClockPro." CONCEDED and OWNED (D25.2). We keep the
    non-resident test pages in a SEPARATE bounded ring (drop-oldest) instead of interleaving them
    into the clock, mirroring the Lirs D23 bounded deviation. We state this plainly rather than
    claim textbook-exact metadata; the oracle encodes the SAME bounded semantics so the
    differential is honest.
  - "O(1)?" HONEST. get/put-update are O(1) (a reference-bit store). A capacity insert amortizes:
    HAND_test moves one step (O(1)); HAND_cold's sweep and HAND_hot's demotion each clear at most
    one reference bit per step and are bounded by the resident set, amortized O(1) per eviction --
    the classic CLOCK amortization. There is no heap, no comparison, no per-page timer.
  - "a clock hit does no work, like SIEVE -- so it's just SIEVE." REBUTTED. The hit is as cheap as
    SIEVE (1 bit), but the EVICTION is recency-of-recency with an adaptive hot/cold split and a
    non-resident test history -- SIEVE is a single FIFO ring with one hand and no adaptation. The
    cheap hit is shared; the policy is not.

## Consequences

  - The tenth member; the family now spans recency (LiteLru), lazy-promotion FIFO (Sieve/S3Fifo),
    approximate frequency admission (WTinyLfu), exact frequency (Lfu), segmented recency
    (Slru/TwoQ), adaptation (Arc), exact recency-of-recency (Lirs), and its CLOCK APPROXIMATION
    (ClockPro) -- one `LiteCache<K,V>` surface, one-line policy swap.
  - New member columns `_st` + the three hands + `_mHot` + the bounded `ClockProHistory`; all
    fixed-size, allocated once, never grown. The other members' hot paths are byte-identical (no
    field added to the shared `SlotStore`).
  - A new conservation term in `validate()` (term 14: hot+cold==size, valid `_st` tags, hands
    resident, `_mHot` in range, history bounded); a new INDEPENDENT brute oracle
    (`test/torture/oracles/clockpro.mjs`, an array-clock + three index hands + bounded history,
    encoding the D25.2 bounded deviation, sharing no code with the SoA member); harness
    `clockProPolicy`/`clockProIntPolicy`/`clockProTtlPolicy` + `CountedClockPro` + `wrapClockPro`
    + `ClockPro` in `SNAP_MEMBERS`; `ClockPro` added to t0/t2/t5/t6/t7 and the snapshot round-trip
    roster; the t6 Gate CLOCKPRO (zero-alloc + the pinned writes-per-hit + covered lanes); four t9
    must-fail controls (`clockpro-no-adapt`, `clockpro-hands-dropped`, `clockpro-mhot-dropped`,
    `clockpro-test-bits-dropped`); a boundary suite (`test/ClockPro.test.js`); the bench MEMBERS +
    the demo renderer + roster.
