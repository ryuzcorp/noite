### Changed

- The tenant D1 editor runs multi-statement actions in one `celld d1 execute --batch` call instead of one subprocess per statement: a row page and its total share one call (and one snapshot), and the schema view needs at most two. SPEC's "Do not write to a live D1 with the `celld d1` CLI" rule is lifted — the hang it guarded was the D1 concurrent-call stall, fixed in celld `0.6.3-ryuzcorp.6` and verified gone there — while the control D1 editor stays in-process by design.
