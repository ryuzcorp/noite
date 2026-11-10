//! The control app's fleet availability as one tri-state. `GET /v1/admin/stats`
//! answers `control_fleet`; "no answer yet" and "managed" used to be the same
//! `undefined`/`true`, so a failed lookup showed telemetry tabs over a stream
//! that could never open.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Unknown: no answer yet
//!   Unknown --> Managed: control_fleet true
//!   Unknown --> Absent: control_fleet false
//! ```
//!
//! `Unknown` renders a neutral notice and offers the admin tabs only; it never
//! pretends to be `Managed`.

import { Data } from "effect";

export type FleetState = Data.TaggedEnum<{
  Unknown: Record<never, never>;
  Managed: Record<never, never>;
  Absent: Record<never, never>;
}>;

export const FleetStateTypes = Data.taggedEnum<FleetState>();

export const fleetState = (controlFleet?: boolean | undefined): FleetState => {
  if (controlFleet === true) {
    return FleetStateTypes.Managed();
  }

  if (controlFleet === false) {
    return FleetStateTypes.Absent();
  }

  return FleetStateTypes.Unknown();
};

/** Telemetry tabs need a supervised control fleet; only `Managed` shows
 * them, so `Unknown` cannot open a stream that will never receive a frame. */
export const telemetryAvailable = (state: FleetState): boolean =>
  state._tag === "Managed";
