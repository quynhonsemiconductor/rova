# Capacity Planning: declared divergences from the BA

Extracted from `CLAUDE.md` so the rule stays in the always-loaded notes and the
incidents behind it stay one click away.

Each was ruled on. None is drift, and none should be "fixed" on sight — and note the first one is a
divergence that has since been REVERSED, kept here because the reasoning will come up again.

- **Rollup and Complete no longer filter children by Project+Release — the BA REVERSED that divergence
  on 2026-08-17** (`P5-CP-029`, retest, Confirmed Fail, P0). It used to be a declared divergence in
  Rally's favour: "If a portfolio item includes allocated points/counts, the Project and Release fields
  in the story must match the plan for that story to be included in the Rollup calculation", on the
  grounds that without it a long-lived Feature inflates every plan that touches it. `P5-CAP-AC-016` and
  SRS §311/§318 state the formula with NO qualifier — `SUM(child.planEstimate WHERE child belongs to
  Feature)` — and the release half is what made the BA's repro read zero: an ordinary Story carries no
  Release of its own, so a Feature with one Completed 3-point child reported `Rollup = 0, Complete = 0`
  on the plan header, on the Team row and on the Features tab at once. The predicate is now the link
  plus `deleted_at is null`, in `capacity-metrics.sql.ts`. **Do not re-add the qualifier without a
  fresh ruling.**

  Two things had to move with it, and they are the part worth remembering:

  - **A team SLICE cannot be a strict `work_items.team_id = ?`.** That was tier 1 of the rule with no
    tier 2, and SQL equality never matches NULL — `work_items.team_id` is nullable and mostly unset —
    so every unteamed child fell out of every team slice. `teamSliceChildScope` attributes a child to
    its own team when that team holds an allocation of the Feature on this plan, and otherwise to the
    Feature's OWNER (`is_primary`, Rally's Planned Team Assignment). Exactly one slice, and the slices
    SUM to the Feature's own total, which is `AC-017`'s reconciliation requirement.
  - **A team row is the SUM OF ITS OWN ALLOCATION ROWS** (SRS §341/§347 say precisely that), not a
    separate aggregate query. `repo.teamMetrics` and `childWorkPredicate` are gone: two definitions of
    one number are what let the Team row, the Feature rows under it and the plan header (which sums the
    team rows in `planTotals`) disagree about one child.
- **Nested `Dependencies` renders `0`, not `—`.** The BA's catalog suggests a dash (§205); Rally's column
  is a COUNT, dependencies are genuinely unimplemented rather than unknown, and `0` is true where a dash
  would read as "not known". Note this is the one place the app's own absent-value rule (`--` everywhere
  else) is deliberately not applied.
- **The cutline keeps the overflowing Feature BELOW the line.** Rally's Items-tab doc is the deciding
  sentence: "Items above the cutline fit within the defined plan capacity. Items below the line exceed
  the capacity of the plan." SRS §189 says the line is drawn "after the first Feature where cumulative
  planning Estimated reaches or exceeds Plan total Capacity", which puts that Feature above the line. The
  two differ by exactly one row — capacity 100 against 90, 20, 5 puts the 20 below here and above under
  §189.

  Worth knowing that this one was shipped §189's way and reverted: the BA reading went in under a
  blanket "align to the BA" instruction, and Broadcom's wording was only checked afterwards.

  This note used to add that `Rollup`, `Complete` and the cutline were "all decided the same way — the
  product's documented behaviour wins", and to warn that reversing one meant reversing all three. **The
  BA reversed the Rollup/Complete child filter on 2026-08-17 and left the cutline alone**, so the trio
  is deliberately split now: the cutline still follows Broadcom, the child filter follows
  `P5-CAP-AC-016`. Recorded rather than deleted because the next person to read either bullet will
  wonder which rule governs — the answer is per-rule, and each one names its own source.

  Verified at
  `techdocs.broadcom.com/us/en/ca-enterprise-software/valueops/rally/rally-help/planning/capacity-planning-page/view-capacity-plan-details/capacity-plan-items-tab.html`
  (the same page carries the Project/Release sentence above, for Complete and for estimated points).
  The cutline was removed from Rally and later restored, which is why it may be absent from an older
  screenshot or a different edition.
