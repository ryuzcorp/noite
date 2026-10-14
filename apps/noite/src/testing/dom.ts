/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- a test fixture: it stands in for the handful of browser globals a bun test does not have */
//! The browser globals the pod frame's own code reaches for, faked for tests.
//!
//! The frame always runs in a real document, but `bun test` has no DOM, and
//! one thing the frame does touches it: the SDK's `attach` (it creates its
//! `Terminal`, loads the fit addon, opens it on an element, listens for window
//! resizes, and fits on the next frame). This module installs exactly
//! that much — no layout, no events, nothing that could stand in for a real
//! assertion — so the tap and the wiring can be driven in a unit test.

/** One element as the frame's code uses it: a hidden host node, appended once
 * and removed on teardown. */
const fakeElement = (): HTMLElement =>
  ({
    append: () => {
      // Dedicated children: nothing in a unit test draws or measures.
    },
    hidden: false,
    parentElement: null,
    remove: () => {
      // Detached from nothing.
    },
  }) as unknown as HTMLElement;

/** Install the globals. A test that never touches the SDK's terminal does not
 * need this; one that does has to call it before the code under test runs. */
export const installDomFixture = (): void => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = {
    body: {
      append: () => {
        // The fake document keeps no children.
      },
    },
    createElement: fakeElement,
    querySelector: () => null,
  };
  globals.window = {
    addEventListener: () => {
      // Resize listeners are never fired in a unit test.
    },
    clearTimeout,
    removeEventListener: () => {
      // Nothing was ever attached.
    },
    setTimeout,
  };
  globals.requestAnimationFrame = (frame: (time: number) => void): number => {
    frame(0);
    return 0;
  };
};
