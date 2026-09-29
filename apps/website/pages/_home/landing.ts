// Landing page behaviour: copy buttons and tour chapters (the install tabs
// are daisyUI radio tabs and need no script). Runs on
// every Astro page load, since Blume navigates with the client router.

const COPIED_MS = 1600;

const initCopyButtons = (): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-copy]"
  )) {
    button.addEventListener("click", async () => {
      const text = button.dataset.copy ?? "";
      const label = button.querySelector("[data-copy-label]");
      try {
        await navigator.clipboard.writeText(text);
        if (label) {
          label.textContent = "Copied";
          setTimeout(() => {
            label.textContent = "Copy";
          }, COPIED_MS);
        }
      } catch {
        // Clipboard blocked (insecure origin, permissions): the command stays
        // selectable in the block next to the button.
      }
    });
  }
};

const initChapters = (): void => {
  const video = document.querySelector<HTMLVideoElement>("[data-tour-video]");
  if (!video) {
    return;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-chapter]"
  )) {
    button.addEventListener("click", async () => {
      video.currentTime = Number(button.dataset.chapter ?? 0);
      try {
        await video.play();
      } catch {
        // Autoplay refused: the seek still happened, the viewer presses play.
      }
    });
  }
};

document.addEventListener("astro:page-load", () => {
  if (!document.querySelector("[data-landing]")) {
    return;
  }
  initCopyButtons();
  initChapters();
});
