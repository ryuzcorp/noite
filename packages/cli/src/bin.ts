#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";

import pkg from "../package.json";
import { deploy } from "./deploy.js";

// Bundled from package.json at build time (bun inlines the JSON import), so
// the advertised version can never drift from the published package.
const VERSION: string = pkg.version;

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
