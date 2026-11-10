//! One transition's outcome, shared by the slice's machines: the next model
//! and optional one-shot work. Named, so `update` functions declare a real
//! contract instead of an anonymous object type.
import type { Cmd } from "@ilha/model";

export interface Step<Model, Message> {
  readonly cmd?: Cmd<Message> | readonly Cmd<Message>[] | undefined;
  readonly model: Model;
}
