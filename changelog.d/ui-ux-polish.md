### Changed

- Code mode's file tree is a slide-over below `lg` (opened from a Files button in the code bar, closed by picking a file), so the editor gets a phone's full width instead of a ~100px sliver.
- The new-pull-request form labels its base and head pickers, caps its width like the app's other forms, and lists the reasons Create is off in a box of its own instead of three grey lines.
- A pull-request row keeps its metadata on one readable line on a phone, with the age below it rather than in a squeezed third column.

### Fixed

- The create page's drag-and-drop hint wraps as one paragraph instead of breaking into three ragged columns (its `<p>` was a flex container, so each text node became a flex item).
