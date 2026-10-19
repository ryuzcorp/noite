#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";

import pkg from "../package.json";
import { deploy } from "./deploy.js";
import { environments } from "./environments.js";

// Bundled from package.json at build time (the bundler inlines the JSON import), so
// the advertised version can never drift from the published package.
const VERSION: string = pkg.version;

const root = Command.make("noite").pipe(
  Command.withDescription(
    "Noite CLI: deploy prebuilt dist to your own hardware"
  ),
  Command.withSubcommands([deploy, environments])
);

NodeRuntime.runMain(
  // Command.run needs the platform Environment (Stdio, Terminal, FileSystem,
  // Path, ChildProcessSpawner).
  Command.run(root, { version: VERSION }).pipe(
    Effect.provide(NodeServices.layer)
  )
);
