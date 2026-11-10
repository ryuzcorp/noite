### Fixed

- Code mode: a checkout whose pod stopped after its listing had loaded could still become the current checkout, leaving a dead file tree and editor behind the "Could not open" card. It is now refused, and the failure card describes the ref that actually failed.
- Code mode: a failed Deploy preview was rendered under the commit form as a push failure (and a failed push could show in the Preview panel). The two operations now have their own state, so each failure stays with the button that caused it.
- Code mode: after a branch switch failed, the read-only banner could describe the branch the panes were still showing while the failure card named another ref.
- Code mode: a pod-side change arriving while a file was still opening could cancel that open, leaving the editor on the previous file while `?file=` named the new one.
- Code mode: a changed row whose committed text was still being read hid both its Discard button and its diff.
- Code mode: renaming a new file after its placeholder had been taken back (Escape, a refused name, a tree rebuild) could send a rename of a path the pod never had.
- Code mode: two file drops could interleave their replace confirmations and writes, and the drop outline could stay up after a refused drop.
- Code mode: the branch picker kept a stale action error when reopened, and a second delete click could open a second confirmation dialog.

### Changed

- Code mode's implicit lifecycles (checkout, push/preview, commit target, editor surface, inline naming, uploads, hover tip, TypeScript intel readiness, tree resync, forge resource views, ref access) are explicit state machines in their own modules, with unit tests, instead of parallel flags and counters.
