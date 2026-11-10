### Fixed

- Code mode's workspace no longer opens a pod frame it never bound: the page waits for the frame's own acknowledgement, and says the host answered but never took the port instead of failing every request one by one on its own deadline.
- A Push the page reported as settled without the commit it landed no longer leaves the pod stuck mid-push: the refusal keeps the push open so the page can answer again, and a push the page never settles expires so the next one can start.
- A tab that loses the saved workspace's lock now stops claiming to save: it goes back to following, says its edits are not being kept, and reloads cleanly, instead of silently failing every save.
- The derive loop answers a "derive now" request on a pass that started after it, so the tree and Changes panel no longer show rows one pass behind a rename or a terminal write; a change event that arrives out of order can no longer roll the panel back.
- Language intelligence restarts its worker after a crash instead of losing diagnostics, hover and go-to-definition for the rest of the mount.
- A terminal whose frame died says so instead of showing a live prompt that swallows keystrokes.
- A tab that opens second no longer waits out its full timeout when the other tab is not the one saving the workspace.
- A bracketed window of unsaved edits that the browser refused to mirror is now reported, rather than silently leaving a reload unprotected.
- A branch opened after a large one no longer inherits the declaration budget cap that large branch reached.

### Changed

- The pod handshake, the pod server's workspace/push/shell lifecycles, the workspace open decision and derive loop, the row sides, read-only refusals, tab roles, the cross-tab sync, the sessionStorage mirror, the proxy's write coalescing, the preview frame, the terminal session, the language client and the esm.sh declaration budget are each one explicit state with one transition function, documented in their module.
