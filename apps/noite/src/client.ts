import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./app.css";
import { pageRouter } from "ilha:pages/client";

pageRouter.mount("#app");

// daisyUI dropdowns are open while focus is inside them. SPA navigation keeps
// focus on the clicked item, so the menu stayed open after "Account".
// Blurring on an item click closes every dropdown the same way; a
// card-style dropdown's own controls (e.g. a copy button) keep it open.
document.addEventListener("click", (event) => {
  const item =
    event.target instanceof Element
      ? event.target.closest(
          ".dropdown-content a[href], .dropdown-content.menu button"
        )
      : null;
  if (item && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
});

// `<details class="dropdown">` popovers (filters, sort, menus) only close
// when their own summary is clicked. Close every open one on a press outside
// it, which also means opening one dropdown closes the others.
const closeOpenDetails = (except?: Node) => {
  for (const open of document.querySelectorAll<HTMLDetailsElement>(
    "details.dropdown[open]"
  )) {
    if (!(except && open.contains(except))) {
      open.open = false;
    }
  }
};
document.addEventListener("pointerdown", (event) => {
  closeOpenDetails(event.target instanceof Node ? event.target : undefined);
});
// Esc closes any dropdown: open `<details>` ones, and focus-based ones by
// dropping focus out of them. A dialog's own Esc handling is unaffected.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  closeOpenDetails();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(".dropdown")) {
    active.blur();
  }
});
