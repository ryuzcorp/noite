#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";

import pkg from "../package.json";
import { deploy } from "./deploy.js";
import { environments } from "./environments.js";
import { pr } from "./pr.js";
import { logs, rollback } from "./release.js";

// Bundled from package.json at build time (the bundler inlines the JSON import), so
// the advertised version can never drift from the published package.
const VERSION: string = pkg.version;

const root = Command.make("noite").pipe(
  Command.withDescription(
    "Noite CLI: deploy prebuilt dist to your own hardware, and drive the whole agent loop from a terminal"
  ),
  Command.withSubcommands([deploy, environments, logs, pr, rollback])
);

NodeRuntime.runMain(
  // Command.run needs the platform Environment (Stdio, Terminal, FileSystem,
  // Path, ChildProcessSpawner).
  Command.run(root, { version: VERSION }).pipe(
    Effect.provide(NodeServices.layer)
  )
);
