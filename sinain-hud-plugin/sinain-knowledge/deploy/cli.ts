#!/usr/bin/env node

/**
 * sinain-knowledge CLI
 *
 * Commands:
 *   install [--backend openclaw|generic]  — Deploy knowledge system to workspace
 *   snapshot export <file>                — Export knowledge state to file
 *   snapshot import <file>                — Import knowledge state from file
 *   protocol render --binding <name>      — Render protocol templates with bindings
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

async function main(): Promise<void> {
  const command = args[0];

  switch (command) {
    case "install":
      await cmdInstall();
      break;
    case "snapshot":
      await cmdSnapshot();
      break;
    case "protocol":
      await cmdProtocol();
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`sinain-knowledge CLI

Usage:
  sinain-knowledge install [--backend openclaw|generic] [--workspace <path>]
  sinain-knowledge snapshot export <file>
  sinain-knowledge snapshot import <file> [--workspace <path>]
  sinain-knowledge snapshot save [--workspace <path>] [--repo <path>]
  sinain-knowledge snapshot list [--repo <path>] [--count <n>]
  sinain-knowledge snapshot restore <ref> [--workspace <path>] [--repo <path>]
  sinain-knowledge protocol render --protocol <heartbeat|skill> --binding <openclaw|generic>
  sinain-knowledge protocol render --protocol <heartbeat|skill> --binding <openclaw|generic> --output <file>
`);
}

// ── Install ─────────────────────────────────────────────────────────────

async function cmdInstall(): Promise<void> {
  const backend = getArg("--backend") ?? "openclaw";
  const workspace = getArg("--workspace") ?? process.cwd();

  console.log(`Installing sinain-knowledge (backend: ${backend}, workspace: ${workspace})`);

  // Import renderer to generate HEARTBEAT.md and SKILL.md
  const { render } = await import("../protocol/renderer.js");
  const binding = backend === "openclaw" ? "openclaw" : "generic";

  const heartbeat = render("heartbeat", binding as any);
  const skill = render("skill", binding as any);

  writeFileSync(resolve(workspace, "HEARTBEAT.md"), heartbeat, "utf-8");
  writeFileSync(resolve(workspace, "SKILL.md"), skill, "utf-8");

  console.log(`  Written HEARTBEAT.md (${heartbeat.length} chars)`);
  console.log(`  Written SKILL.md (${skill.length} chars)`);
  console.log("Done.");
}

// ── Snapshot ────────────────────────────────────────────────────────────

async function cmdSnapshot(): Promise<void> {
  const subcommand = args[1];

  if (subcommand === "export") {
    const file = args[2];
    if (!file) {
      console.error("Usage: sinain-knowledge snapshot export <file>");
      process.exit(1);
    }

    const workspace = getArg("--workspace") ?? process.cwd();
    const { KnowledgeStore } = await import("../data/store.js");
    const { exportSnapshot } = await import("../data/snapshot.js");

    const logger = { info: console.log, warn: console.warn };
    const store = new KnowledgeStore(workspace, logger);
    const snapshot = exportSnapshot(store);

    writeFileSync(resolve(file), JSON.stringify(snapshot, null, 2), "utf-8");
    console.log(`Snapshot exported to ${file} (${JSON.stringify(snapshot).length} bytes)`);
  } else if (subcommand === "import") {
    const file = args[2];
    if (!file) {
      console.error("Usage: sinain-knowledge snapshot import <file>");
      process.exit(1);
    }

    const workspace = getArg("--workspace") ?? process.cwd();
    const { KnowledgeStore } = await import("../data/store.js");
    const { importSnapshot } = await import("../data/snapshot.js");

    const logger = { info: console.log, warn: console.warn };
    const store = new KnowledgeStore(workspace, logger);
    const snapshot = JSON.parse(readFileSync(resolve(file), "utf-8"));

    importSnapshot(store, snapshot);
    console.log(`Snapshot imported from ${file}`);
  } else if (subcommand === "save") {
    const workspace = getArg("--workspace") ?? process.cwd();
    const repoPath = getArg("--repo");

    const { KnowledgeStore } = await import("../data/store.js");
    const { GitSnapshotStore } = await import("../data/git-store.js");

    const logger = { info: console.log, warn: console.warn };
    const store = new KnowledgeStore(workspace, logger);
    const gitStore = new GitSnapshotStore(repoPath, logger);

    const hash = await gitStore.save(store);
    console.log(`Snapshot saved → ${hash} (repo: ${gitStore.getRepoPath()})`);
  } else if (subcommand === "list") {
    const repoPath = getArg("--repo");
    const count = parseInt(getArg("--count") ?? "20", 10);

    const { GitSnapshotStore } = await import("../data/git-store.js");

    const logger = { info: () => {}, warn: console.warn };
    const gitStore = new GitSnapshotStore(repoPath, logger);
    const entries = await gitStore.list(count);

    if (entries.length === 0) {
      console.log("No snapshots found.");
    } else {
      console.log(`${entries.length} snapshot(s) in ${gitStore.getRepoPath()}:\n`);
      for (const e of entries) {
        console.log(`  ${e.hash}  ${e.date}  ${e.subject}`);
      }
    }
  } else if (subcommand === "restore") {
    const ref = args[2];
    if (!ref) {
      console.error("Usage: sinain-knowledge snapshot restore <ref>");
      process.exit(1);
    }

    const workspace = getArg("--workspace") ?? process.cwd();
    const repoPath = getArg("--repo");

    const { KnowledgeStore } = await import("../data/store.js");
    const { GitSnapshotStore } = await import("../data/git-store.js");

    const logger = { info: console.log, warn: console.warn };
    const store = new KnowledgeStore(workspace, logger);
    const gitStore = new GitSnapshotStore(repoPath, logger);

    await gitStore.restore(store, ref);
    console.log(`Snapshot ${ref} restored to ${workspace}`);
  } else {
    console.error("Usage: sinain-knowledge snapshot <export|import|save|list|restore>");
    process.exit(1);
  }
}

// ── Protocol ────────────────────────────────────────────────────────────

async function cmdProtocol(): Promise<void> {
  const subcommand = args[1];

  if (subcommand !== "render") {
    console.error("Usage: sinain-knowledge protocol render --protocol <name> --binding <name>");
    process.exit(1);
  }

  const protocol = getArg("--protocol") ?? "heartbeat";
  const binding = getArg("--binding") ?? "openclaw";
  const output = getArg("--output");

  const { render } = await import("../protocol/renderer.js");
  const result = render(protocol as any, binding as any);

  if (output) {
    writeFileSync(resolve(output), result, "utf-8");
    console.log(`Rendered ${protocol} with ${binding} binding → ${output}`);
  } else {
    process.stdout.write(result);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
