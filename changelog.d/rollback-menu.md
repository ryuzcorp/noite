### Fixed

- **The header Deploy menu keeps its rollback through the app detail landing.** A page load paints the header from the previous snapshot first, so the new Stop/Start control used to replace the menu's subtree and close it, and the rollback lookup froze on the release already serving. The action row is keyed, and the target is now derived against the live sha at render, so the menu keeps its open state and its rows and never offers the serving release as "Roll back to".
- **A failed history lookup is shown with a retry**, instead of the menu claiming there is no earlier deploy.
- **Double-clicking Stop, Roll back or Redeploy sends one call**, not two.
