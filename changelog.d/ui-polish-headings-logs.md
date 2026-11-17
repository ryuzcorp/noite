### Changed

- The tenant app Metrics and Analytics tabs show their **Metrics** / **Analytics** headings on the same row as the 24h/7d/1m range picker (heading left, pickers right, wrapping cleanly at 390 px), in the same heading style as the other cards.
- The control page's Logs tab (`/apps/_control?t=logs`) renders inside the standard card with a **Logs** title row, like the Errors/Events cards; the shared log tail is unchanged, so deploy-row logs look the same.
- The Admin user list's row actions (Impersonate, Make/Remove admin, Ban/Unban, Delete, Approve/Reject) collapse into one compact kebab menu per row at every width — the inline buttons spilled onto two lines at 390 px. The menu is keyboard-operable, Ban and Delete keep the destructive tone and their confirm dialogs.
