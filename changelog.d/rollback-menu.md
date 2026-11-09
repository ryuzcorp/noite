### Changed

- The header's **Deploy** menu now offers **Roll back to `<sha>`**: the newest successful production release that is not the live one, one click from any tab (confirm dialog, then the same rollback the Deployments tab already had). It loads the deploy list when the menu opens, hides itself while there is no earlier release, and says so once it knows. The per-row **Roll back** button on the Deployments tab is unchanged.
