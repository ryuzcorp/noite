//! The source tree's interaction layer: the right-click menu, the toast corner
//! the pane's refusals land in, the confirm a folder delete asks through, and
//! the path/event math they share. `@pierre/trees` opens its context menu on
//! rows only, so the pane opens the same menu for the empty space under them;
//! everything here builds plain DOM with daisyUI classes, because the tree is
//! mounted imperatively, outside ilha.

import type { TreeDropTarget } from "./pierre";

/** What a tree menu acts on: the row it opened on (pierre's canonical path, a
 * folder ending with "/"), or nothing when it opened on empty space. */
export interface MenuTarget {
  path: string | null;
}

/** The actions a menu offers; Delete is absent where there is no row, and
 * `deleteCount` (the rows it acts on) shows in its label past one. Rename
 * belongs to the single row the menu opened on; Upload writes into the target
 * folder (the row's folder, or the root for empty space). */
export interface MenuActions {
  deleteCount?: number;
  newFile: () => void;
  newFolder: () => void;
  onDelete?: () => void;
  onRename?: () => void;
  onUpload?: () => void;
}

/** An open menu: its element, and a teardown that removes both (idempotent —
 * pierre's own close lands here as well). */
export interface TreeMenu {
  close: () => void;
  element: HTMLElement;
}

/** daisyUI's toast corner (the storage panels' pattern): the refusals the tree
 * raises — a name it will not take, an add it rejected — have no row to land
 * in. */
export interface Toaster {
  host: HTMLElement;
  notify: (message: string) => void;
}

/** `path` without its folder slash. */
export const withoutSlash = (path: string): string =>
  path.endsWith("/") ? path.slice(0, -1) : path;

/** The folder holding `path` ("" at the root). */
export const parentDir = (path: string): string => {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
};

/** The folder a new entry goes into: a folder row itself, a file row's parent,
 * the root for empty space. */
export const menuDir = (path: string | null): string => {
  if (path === null) {
    return "";
  }

  return path.endsWith("/") ? withoutSlash(path) : parentDir(path);
};

/** Sort flat file paths so folders come first at every level, then
 * files — alphabetical within each group (segment-wise compare). */
export const sortTreePaths = (paths: string[]): string[] =>
  paths.toSorted((a, b) => {
    const as = a.split("/");
    const bs = b.split("/");
    const len = Math.min(as.length, bs.length);

    for (let i = 0; i < len; i += 1) {
      const charA = as[i] ?? "";
      const charB = bs[i] ?? "";

      if (charA !== charB) {
        const aIsDir = i < as.length - 1;
        const bIsDir = i < bs.length - 1;

        if (aIsDir !== bIsDir) {
          return aIsDir ? -1 : 1;
        }

        return charA < charB ? -1 : 1;
      }
    }

    return as.length - bs.length;
  });

/** Where a drop lands, in pierre's own convention: the target folder with the
 * dragged name kept (a folder keeps its slash), the bare name at the root. */
export const dropDestination = (
  path: string,
  target: TreeDropTarget
): string => {
  const trimmed = withoutSlash(path);
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const leaf = path.endsWith("/") ? `${name}/` : name;

  if (target.kind === "root" || target.directoryPath === null) {
    return leaf;
  }

  return `${target.directoryPath}${leaf}`;
};

/** Whether the event landed on a tree row — pierre's own menu target, which
 * the pane leaves alone (there is no menu of its own on read-only refs). */
export const isTreeRow = (event: Event): boolean =>
  event
    .composedPath()
    .some(
      (node) => node instanceof HTMLElement && node.dataset.type === "item"
    );

/** The inline name input pierre renders, found through the event's own path
 * (the row lives inside the tree's shadow root). */
export const renameInput = (event: Event): HTMLInputElement | null => {
  for (const node of event.composedPath()) {
    if (
      node instanceof HTMLInputElement &&
      node.dataset.itemRenameInput !== undefined
    ) {
      return node;
    }
  }

  return null;
};

export const newToaster = (): Toaster => {
  const host = document.createElement("div");
  host.className = "toast toast-top toast-end z-[100]";
  document.body.append(host);

  return {
    host,
    notify: (message) => {
      const line = document.createElement("div");
      line.className = "alert alert-error alert-soft text-sm";
      line.setAttribute("role", "alert");
      line.textContent = message;
      host.append(line);
      setTimeout(() => {
        line.remove();
      }, 4000);
    },
  };
};

/** The tree's context menu: one daisyUI `menu` of what makes sense for the
 * target. The library styles its own slot surface, so this one carries the
 * dropdown look itself (light and dark through daisyUI's variables). */
export const newTreeMenu = (actions: MenuActions): HTMLElement => {
  const menu = document.createElement("ul");
  menu.className =
    "menu bg-base-100 rounded-box border-base-300 border w-48 p-1 text-sm shadow";
  menu.setAttribute("aria-label", "Tree actions");
  menu.setAttribute("role", "menu");

  const add = (label: string, run: () => void, cls?: string) => {
    const item = document.createElement("li");
    item.setAttribute("role", "none");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;

    if (cls !== undefined) {
      button.className = cls;
    }

    button.addEventListener("click", () => {
      run();
    });
    item.append(button);
    menu.append(item);
  };

  add("New File", actions.newFile);
  add("New Folder", actions.newFolder);

  if (actions.onUpload !== undefined) {
    add("Upload files…", actions.onUpload);
  }

  if (actions.onRename !== undefined) {
    add("Rename", actions.onRename);
  }

  if (actions.onDelete !== undefined) {
    const count = actions.deleteCount ?? 1;
    add(
      count > 1 ? `Delete (${count})` : "Delete",
      actions.onDelete,
      "text-error"
    );
  }

  return menu;
};

/** Park `element` at a viewport point and own its dismissal: the menu lives on
 * `document.body`, outside the tree's clipped, scrolling pane (marking it as
 * pierre's menu root keeps the library from reading its clicks as outside). */
export const openTreeMenu = (
  element: HTMLElement,
  point: { x: number; y: number },
  dismiss: () => void
): TreeMenu => {
  element.dataset.fileTreeContextMenuRoot = "true";
  element.style.position = "fixed";
  element.style.zIndex = "60";
  document.body.append(element);
  element.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - element.offsetWidth - 8))}px`;
  element.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - element.offsetHeight - 8))}px`;
  const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")];

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      dismiss();

      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();
    const active = document.activeElement;

    const from =
      active instanceof HTMLButtonElement
        ? Math.max(0, buttons.indexOf(active))
        : 0;

    const step = event.key === "ArrowDown" ? 1 : buttons.length - 1;
    buttons[(from + step) % buttons.length]?.focus();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!event.composedPath().includes(element)) {
      dismiss();
    }
  };

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onPointerDown, true);
    element.remove();
  };

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onPointerDown, true);
  buttons[0]?.focus();

  return { close, element };
};
