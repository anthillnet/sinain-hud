#!/usr/bin/env node
// prepack: replace symlinks with real copies so npm pack bundles the files.
// postpack: restore symlinks.

import fs from "fs";
import path from "path";

const LINKS = ["sinain-core", "sinain-mcp-server", "sinain-agent", "sense_client", ".env.example"];
const PKG_DIR = path.dirname(new URL(import.meta.url).pathname);

const action = process.argv[2]; // "pre" or "post"

if (action === "pre") {
  for (const name of LINKS) {
    const linkPath = path.join(PKG_DIR, name);
    if (!fs.existsSync(linkPath)) continue;
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) continue;
    const target = fs.realpathSync(linkPath);
    fs.unlinkSync(linkPath);
    const targetStat = fs.statSync(target);
    if (targetStat.isDirectory()) {
      copyDir(target, linkPath);
    } else {
      fs.copyFileSync(target, linkPath);
    }
  }
  console.log("prepack: symlinks → copies");
} else if (action === "post") {
  for (const name of LINKS) {
    const linkPath = path.join(PKG_DIR, name);
    if (!fs.existsSync(linkPath)) continue;
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) continue; // already a symlink
    fs.rmSync(linkPath, { recursive: true, force: true });
    fs.symlinkSync(`../${name}`, linkPath);
  }
  console.log("postpack: copies → symlinks");
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (["node_modules", "__pycache__", ".pytest_cache", "dist", ".env"].includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}
