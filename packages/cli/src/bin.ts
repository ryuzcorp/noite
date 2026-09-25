#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { deploy } from "./deploy.js";

// Keep in sync with package.json version (single-command CLI, one line).
const VERSION = "0.1.0";

const root = Command.make("noite").pipe(
  Command.withDescription(
    "Noite CLI: deploy prebuilt dist to your own hardware"
  ),
  Command.withSubcommands([deploy])
);

BunRuntime.runMain(
  // Command.run needs the platform Environment (Stdio, Terminal, FileSystem,
  // Path, ChildProcessSpawner) — BunRuntime.runMain does not provide it.
  Command.run(root, { version: VERSION }).pipe(
    Effect.provide(BunServices.layer)
  )
);
