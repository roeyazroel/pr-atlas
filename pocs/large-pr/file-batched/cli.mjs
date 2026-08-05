#!/usr/bin/env node
import { resolve } from "node:path";

import { buildFileBatchedPlan, loadAtlasInput, summarizePlan, writeReplayBundle } from "./planner.mjs";

const args = process.argv.slice(2);
const valueFor = (flag) => args[args.indexOf(flag) + 1];
if (args.includes("--help") || !valueFor("--input")) {
  console.log("Usage: node cli.mjs --input <Atlas input directory> [--out <replay directory>] [--max-chunk-bytes <bytes>] [--parallelism <n>]");
  process.exit(args.includes("--help") ? 0 : 1);
}

const options = {};
if (valueFor("--max-chunk-bytes")) options.maxChunkBytes = Number(valueFor("--max-chunk-bytes"));
if (valueFor("--parallelism")) options.parallelism = Number(valueFor("--parallelism"));
const run = await loadAtlasInput(resolve(valueFor("--input")));
const plan = buildFileBatchedPlan(run.files, options);
const summary = summarizePlan(plan);

if (valueFor("--out")) await writeReplayBundle(plan, resolve(valueFor("--out")));
console.log(JSON.stringify({ inputDiffBytes: run.diffBytes, ...summary, replayDirectory: valueFor("--out") ? resolve(valueFor("--out")) : undefined }, null, 2));
