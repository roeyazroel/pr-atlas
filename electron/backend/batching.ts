/** Provider-neutral, deterministic planning for large PR map/reduce runs. */
export const BATCHING_THRESHOLDS = { files: 20, changes: 1_000 } as const;
export const MAX_BATCH_CONCURRENCY = 4;
const DEFAULT_BATCH_BYTES = 160 * 1024;

type ChangedDiff = { path: string; diff: string; additions?: number; deletions?: number };
type BatchFile = { path: string; diff: string; bytes: number; segment: number };
type BatchTask = { id: string; files: BatchFile[]; bytes: number; subsystems: string[] };
type BatchPlan = {
  chunks: BatchTask[];
  coverage: { complete: boolean; missing: string[]; duplicated: string[] };
  sourceFiles: string[];
};
type BatchMapOutput = { taskId: string; observations: Array<{ path: string; segment: number; summary: string; evidence: Array<{ path: string; line: number | null }>; changeGroups: string[]; tests: string[]; flows: string[]; limitations: string[] }> };

/** A dependency-free validator written into each read-only map-task scope. */
export function buildBatchMapValidatorScript(task: Pick<BatchTask, "id" | "files">): string {
  const assignment = JSON.stringify({ taskId: task.id, units: task.files.map(({ path, segment }) => ({ path, segment })) });
  return [
    "#!/usr/bin/env node",
    '"use strict";',
    `const expected = ${assignment};`,
    "const closed = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));",
    "const key = (path, segment) => JSON.stringify([path, segment]);",
    "const display = (path, segment) => String(path) + '#' + String(segment);",
    "const nonEmptyStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);",
    "const errors = [];",
    "const fail = (message) => errors.push(message);",
    "let raw = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { raw += chunk; });",
    "process.stdin.on('error', (error) => { fail('could not read JSON from stdin: ' + error.message); });",
    "process.stdin.on('end', () => {",
    "  let value;",
    "  try { value = JSON.parse(raw); } catch (error) { fail('stdin must contain one JSON object: ' + error.message); }",
    "  if (errors.length === 0) validate(value);",
    "  if (errors.length > 0) { console.error('Map output validation failed:'); for (const error of errors) console.error('- ' + error); process.exitCode = 1; return; }",
    "  console.log('Map output validation passed.');",
    "});",
    "function validate(value) {",
    "  if (!closed(value, ['taskId', 'observations'])) { fail('output must be a closed object with only taskId and observations.'); return; }",
    "  if (value.taskId !== expected.taskId) fail('taskId must be ' + JSON.stringify(expected.taskId) + '.');",
    "  if (!Array.isArray(value.observations)) { fail('observations must be an array.'); return; }",
    "  const allowed = new Map(expected.units.map((unit) => [key(unit.path, unit.segment), unit]));",
    "  const counts = new Map();",
    "  value.observations.forEach((observation, index) => {",
    "    const location = 'observations[' + index + ']';",
    "    if (!closed(observation, ['path', 'segment', 'summary', 'evidence', 'changeGroups', 'tests', 'flows', 'limitations'])) { fail(location + ' must be a closed canonical observation object.'); return; }",
    "    if (typeof observation.path !== 'string' || !Number.isInteger(observation.segment)) { fail(location + ' path must be a string and segment must be an integer.'); return; }",
    "    const unit = key(observation.path, observation.segment);",
    "    if (!allowed.has(unit)) fail('out-of-scope assigned unit: ' + display(observation.path, observation.segment) + '.'); else counts.set(unit, (counts.get(unit) || 0) + 1);",
    "    if (typeof observation.summary !== 'string' || !observation.summary.trim() || observation.summary.length > 8000) fail(location + ' summary must be non-empty and at most 8000 characters.');",
    "    for (const field of ['changeGroups', 'tests', 'flows', 'limitations']) if (!nonEmptyStrings(observation[field])) fail(location + '.' + field + ' must be an array of non-empty strings.');",
    "    if (!Array.isArray(observation.evidence) || observation.evidence.length === 0) { fail(location + '.evidence must be a non-empty array.'); return; }",
    "    observation.evidence.forEach((evidence, evidenceIndex) => {",
    "      const evidenceLocation = location + '.evidence[' + evidenceIndex + ']';",
    "      if (!closed(evidence, ['path', 'line'])) { fail(evidenceLocation + ' must be a closed evidence object.'); return; }",
    "      if (evidence.path !== observation.path) fail(evidenceLocation + ' path must exactly match its observation path.');",
    "      if (!(evidence.line === null || (Number.isInteger(evidence.line) && evidence.line >= 1))) fail(evidenceLocation + ' line must be null or an integer at least 1.');",
    "    });",
    "  });",
    "  for (const unit of expected.units) {",
    "    const count = counts.get(key(unit.path, unit.segment)) || 0;",
    "    if (count === 0) fail('missing assigned unit: ' + display(unit.path, unit.segment) + '.');",
    "    else if (count > 1) fail('duplicate assigned unit: ' + display(unit.path, unit.segment) + '.');",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** A dependency-free semantic preflight for the reducer's schema-constrained JSON. */
export function buildBatchReducerValidatorScript(): string {
  return String.raw`#!/usr/bin/env node
"use strict";
const errors = [];
let evidenceRefs = [];
const fail = (message) => errors.push(message);
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const ids = (values) => new Set(array(values).flatMap((value) => typeof object(value).id === "string" ? [object(value).id] : []));
const duplicateIds = (collections) => {
  const seen = new Map();
  for (const [name, values] of collections) array(values).forEach((value, index) => {
    const id = object(value).id;
    if (typeof id !== "string") return;
    const previous = seen.get(id);
    if (previous) fail("duplicate semantic id '" + id + "' in " + name + "[" + index + "] and " + previous + ".");
    else seen.set(id, name + "[" + index + "]");
  });
};
const unresolved = (value, path, singular, plural, known) => {
  const item = object(value);
  if (typeof item[singular] === "string" && !known.has(item[singular])) fail(path + "." + singular + " references unknown '" + item[singular] + "'.");
  array(item[plural]).forEach((id, index) => { if (typeof id === "string" && !known.has(id)) fail(path + "." + plural + "[" + index + "] references unknown '" + id + "'."); });
};
const evidenceReferences = (value, path = "$") => {
  if (Array.isArray(value)) return value.forEach((item, index) => evidenceReferences(item, path + "[" + index + "]"));
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, item]) => {
    const next = path + "." + key;
    if ((key === "evidenceId" || key === "evidenceRef") && typeof item === "string") evidenceRefs.push([next, item]);
    else if ((key === "evidenceIds" || key === "evidenceRefs") && Array.isArray(item)) item.forEach((id, index) => { if (typeof id === "string") evidenceRefs.push([next + "[" + index + "]", id]); });
    else evidenceReferences(item, next);
  });
};
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("error", (error) => { fail("could not read JSON from stdin: " + error.message); });
process.stdin.on("end", () => {
  let document;
  try { document = JSON.parse(raw); } catch (error) { fail("stdin must contain one JSON object: " + error.message); }
  if (errors.length === 0) validate(object(document));
  if (errors.length) { console.error("Reducer output validation failed:"); errors.forEach((error) => console.error("- " + error)); process.exitCode = 1; return; }
  console.log("Reducer output validation passed.");
});
function validate(document) {
  evidenceRefs = [];
  evidenceReferences(document);
  const evidence = ids(document.evidence);
  evidenceRefs.forEach(([path, id]) => { if (!evidence.has(id)) fail(path + " references unknown evidence '" + id + "'."); });
  const changeGroups = ids(document.changeGroups);
  const tests = ids(document.tests);
  const reviewThreads = ids(document.reviewThreads);
  const reviewInsights = ids(document.reviewInsights);
  if (!["risks", "dependencies", "unchangedInteractions"].every((key) => Array.isArray(document[key]))) fail("risks, dependencies, and unchangedInteractions must be canonical arrays.");
  const graphs = object(document.graphs);
  const graphDefinitions = [["systemOverview", "system-overview"], ["dataFlow", "data-flow"], ["codeDependency", "code-dependency"], ["userAction", "user-action"]];
  const graphNodes = [];
  graphDefinitions.forEach(([key, id]) => graphNodes.push(...array(object(graphs[key]).nodes)));
  duplicateIds([["changeGroups", document.changeGroups], ["stories", document.stories], ["tests", document.tests], ["reviewThreads", document.reviewThreads], ["reviewInsights", document.reviewInsights], ["risks", document.risks], ["dependencies", document.dependencies], ["unchangedInteractions", document.unchangedInteractions], ["evidence", document.evidence], ...graphDefinitions.flatMap(([key]) => { const graph = object(graphs[key]); return [["graphs." + key + ".nodes", graph.nodes], ["graphs." + key + ".edges", graph.edges], ["graphs." + key + ".guidedTours", graph.guidedTours]]; })]);
  const allNodes = ids(graphNodes);
  graphDefinitions.forEach(([key, id]) => validateGraph(object(graphs[key]), "graphs." + key, id, changeGroups, tests, reviewThreads, reviewInsights));
  const stories = array(document.stories);
  const storyIds = ids(stories);
  const plan = array(document.reviewPlan);
  if (plan.length !== stories.length || new Set(plan).size !== plan.length || plan.some((id) => !storyIds.has(id))) fail("reviewPlan must contain every story exactly once.");
  else if (plan[0] !== document.primaryStoryId) fail("reviewPlan must begin with primaryStoryId.");
  const owners = new Set(); let primary = 0;
  stories.forEach((story) => {
    const value = object(story);
    if (value.relationshipToPrimary === "primary") primary++;
    array(value.changeGroupIds).forEach((groupId) => { if (!changeGroups.has(groupId)) fail("story '" + value.id + "' references unknown change group '" + groupId + "'."); else if (owners.has(groupId)) fail("change group '" + groupId + "' belongs to more than one story."); else owners.add(groupId); });
    array(value.dependsOnStoryIds).forEach((dependency) => { const current = plan.indexOf(value.id); const previous = plan.indexOf(dependency); if (!storyIds.has(dependency)) fail("story '" + value.id + "' depends on unknown story '" + dependency + "'."); else if (dependency === value.id || previous >= current) fail("story '" + value.id + "' must depend only on an earlier reviewPlan story."); });
  });
  if (primary !== 1 || document.primaryStoryId === undefined || !stories.some((story) => object(story).id === document.primaryStoryId && object(story).relationshipToPrimary === "primary")) fail("exactly one primary story must match primaryStoryId.");
  changeGroups.forEach((groupId) => { if (!owners.has(groupId)) fail("change group '" + groupId + "' must belong to exactly one story."); });
  array(document.tests).forEach((test, index) => {
    const value = object(test); const path = "tests[" + index + "]";
    if (array(value.changeGroupIds).length === 0) fail(path + ".changeGroupIds must not be empty.");
    unresolved(value, path, "changeGroupId", "changeGroupIds", changeGroups);
  });
  array(document.reviewThreads).forEach((thread, index) => {
    const value = object(thread); const path = "reviewThreads[" + index + "]";
    unresolved(value, path, "changeGroupId", "changeGroupIds", changeGroups);
    unresolved(value, path, "graphNodeId", "graphNodeIds", allNodes);
    unresolved(value, path, "reviewInsightId", "reviewInsightIds", reviewInsights);
    duplicateIds([[path + ".replies", value.replies]]);
  });
  array(document.reviewInsights).forEach((insight, index) => {
    const value = object(insight); const path = "reviewInsights[" + index + "]";
    unresolved(value, path, "reviewThreadId", "reviewThreadIds", reviewThreads);
    unresolved(value, path, "changeGroupId", "changeGroupIds", changeGroups);
    unresolved(value, path, "graphNodeId", "graphNodeIds", allNodes);
  });
  ["risks", "dependencies", "unchangedInteractions"].forEach((name) => array(document[name]).forEach((item, index) => { const value = object(item); if (array(value.changeGroupIds).length === 0) fail(name + "[" + index + "].changeGroupIds must not be empty."); if (array(value.evidenceIds).length === 0) fail(name + "[" + index + "].evidenceIds must not be empty."); unresolved(value, name + "[" + index + "]", "changeGroupId", "changeGroupIds", changeGroups); }));
  const dependencies = array(document.dependencies); const dependencyIds = ids(dependencies); const dependencyById = new Map(dependencies.map((dependency) => [object(dependency).id, object(dependency)]));
  dependencies.forEach((dependency, index) => array(object(dependency).dependsOnIds).forEach((target) => { if (!dependencyIds.has(target)) fail("dependencies[" + index + "].dependsOnIds references unknown dependency '" + target + "'."); else if (target === object(dependency).id) fail("dependency '" + target + "' cannot depend on itself."); }));
  const visiting = new Set(); const visited = new Set(); const visitDependency = (id) => { if (visiting.has(id)) { fail("dependencies contain a cycle through '" + id + "'."); return; } if (visited.has(id)) return; visiting.add(id); array(dependencyById.get(id)?.dependsOnIds).forEach((target) => { if (dependencyById.has(target)) visitDependency(target); }); visiting.delete(id); visited.add(id); }; dependencyIds.forEach(visitDependency);
}
function validateGraph(graph, path, expectedId, changeGroups, tests, reviewThreads, reviewInsights) {
  if (graph.id !== expectedId) fail(path + ".id must be '" + expectedId + "'.");
  const nodes = array(graph.nodes); const edges = array(graph.edges); const tours = array(graph.guidedTours);
  const nodeIds = ids(nodes); const edgeIds = ids(edges); const tourIds = ids(tours);
  edges.forEach((edge, index) => { const value = object(edge); if (!nodeIds.has(value.source) || !nodeIds.has(value.target)) fail(path + ".edges[" + index + "] has an edge with an unknown node: source='" + value.source + "', target='" + value.target + "'."); });
  tours.forEach((tour, tourIndex) => array(object(tour).steps).forEach((step, stepIndex) => { if (!nodeIds.has(object(step).nodeId)) fail(path + ".guidedTours[" + tourIndex + "].steps[" + stepIndex + "] references unknown node '" + object(step).nodeId + "'."); }));
  [["nodes", nodes], ["edges", edges], ["guidedTours", tours]].forEach(([kind, values]) => array(values).forEach((item, index) => {
    const value = object(item); const itemPath = path + "." + kind + "[" + index + "]";
    unresolved(value, itemPath, "changeGroupId", "changeGroupIds", changeGroups);
    unresolved(value, itemPath, "testId", "testIds", tests);
    unresolved(value, itemPath, "reviewThreadId", "reviewThreadIds", reviewThreads);
    unresolved(value, itemPath, "reviewInsightId", "reviewInsightIds", reviewInsights);
    unresolved(value, itemPath, "nodeId", "nodeIds", nodeIds);
    unresolved(value, itemPath, "edgeId", "edgeIds", edgeIds);
    unresolved(value, itemPath, "tourId", "tourIds", tourIds);
  }));
  nodes.forEach((node, index) => {
    const value = object(node); const nodePath = path + ".nodes[" + index + "]";
    if (expectedId === "system-overview") {
      if (value.changed === true) fail(nodePath + " must be contextual and unchanged.");
      ["changeGroupIds", "testIds", "reviewThreadIds", "reviewInsightIds", "evidenceIds"].forEach((field) => { if (array(value[field]).length) fail(nodePath + "." + field + " must be empty for the PR-agnostic system graph."); });
    }
    if (value.changed === true && array(value.changeGroupIds).length === 0) fail(nodePath + ".changeGroupIds must identify the changed node's groups.");
    if (typeof value.state === "string" && (value.state === "changed") !== (value.changed === true)) fail(nodePath + ".state disagrees with changed.");
  });
  if (expectedId === "system-overview" && edges.length) fail(path + " must be PR-agnostic and contain zero edges.");
}
`;
}

/** Complete unified-diff sections keyed by their current (or deleted) repo path. */
export function parseGitDiffSections(diff: string): Map<string, string> {
  const starts = [...diff.matchAll(/^diff --git (.+)$/gm)].map((match) => match.index ?? 0);
  const sections = new Map<string, string>();
  for (let index = 0; index < starts.length; index += 1) {
    const section = diff.slice(starts[index], starts[index + 1]);
    const header = section.match(/^diff --git (.+)$/m)?.[1] ?? "";
    const [, fallback] = parseHeaderPaths(header);
    const added = section.match(/^\+\+\+ (.+)$/m)?.[1];
    const removed = section.match(/^--- (.+)$/m)?.[1];
    const renamed = section.match(/^rename to (.+)$/m)?.[1];
    const binary = section.match(/^Binary files .+ and b\/(.+) differ$/m)?.[1];
    const path = decodeDiffPath(added && added !== "/dev/null" ? added : removed && removed !== "/dev/null" ? removed : renamed ?? binary ?? fallback);
    if (!path || !section.trim()) throw new Error("Diff section has no safe file path or evidence.");
    sections.set(path, section);
  }
  return sections;
}

export function shouldBatchAnalysis(input: { files: number; changes: number }): boolean {
  return input.files >= BATCHING_THRESHOLDS.files || input.changes >= BATCHING_THRESHOLDS.changes;
}

export function buildBatchPlan(source: ChangedDiff[], options: { maxChunkBytes?: number; overlapBytes?: number } = {}): BatchPlan {
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_BATCH_BYTES;
  const overlapBytes = Math.min(options.overlapBytes ?? 2 * 1024, Math.floor(maxChunkBytes / 4));
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 32) throw new Error("maxChunkBytes must be at least 32.");
  const paths = source.map((file) => file.path).sort();
  if (new Set(paths).size !== paths.length) throw new Error("Changed file paths must be unique.");
  const units = source.flatMap((file) => splitFile(file, maxChunkBytes, overlapBytes))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path) || left.segment - right.segment);
  const raw: Array<{ files: BatchFile[]; bytes: number; subsystems: Set<string> }> = [];
  for (const unit of units) {
    const fits = raw.filter((chunk) => chunk.bytes + unit.bytes <= maxChunkBytes);
    const affinity = fits.filter((chunk) => chunk.subsystems.has(subsystem(unit.path)));
    const chosen = [...(affinity.length ? affinity : fits)].sort((a, b) => a.bytes - b.bytes || a.files[0].path.localeCompare(b.files[0].path))[0];
    if (chosen) {
      chosen.files.push(unit); chosen.bytes += unit.bytes; chosen.subsystems.add(subsystem(unit.path));
    } else raw.push({ files: [unit], bytes: unit.bytes, subsystems: new Set([subsystem(unit.path)]) });
  }
  const chunks = raw.map((chunk, index) => ({
    id: `map-${String(index + 1).padStart(3, "0")}`,
    files: chunk.files.slice().sort((a, b) => a.path.localeCompare(b.path) || a.segment - b.segment),
    bytes: chunk.bytes,
    subsystems: [...chunk.subsystems].sort(),
  }));
  const expected = units.map(unitKey); const actual = chunks.flatMap((chunk) => chunk.files.map(unitKey));
  const counts = new Map<string, number>(); for (const key of actual) counts.set(key, (counts.get(key) ?? 0) + 1);
  const coverage = { complete: expected.every((key) => counts.get(key) === 1), missing: expected.filter((key) => !counts.has(key)), duplicated: [...counts].filter(([, count]) => count > 1).map(([key]) => key) };
  return { chunks, coverage, sourceFiles: paths };
}

/** Map output is deliberately small and cannot point outside its assigned evidence. */
export function validateBatchMapOutput(value: unknown, task: Pick<BatchTask, "id" | "files">): { valid: boolean; output?: BatchMapOutput; errors: string[] } {
  if (!recordWithKeys(value, ["taskId", "observations"])) return { valid: false, errors: ["Map output must be a closed object."] };
  const output = value as { taskId: unknown; observations: unknown };
  if (output.taskId !== task.id) return { valid: false, errors: ["Map output taskId does not match its task."] };
  if (!Array.isArray(output.observations)) return { valid: false, errors: ["Map output observations must be an array."] };
  const allowed = new Set(task.files.map(unitKey));
  const observations = new Map<string, BatchMapOutput["observations"][number]>();
  for (const observation of output.observations) {
    if (!recordWithKeys(observation, ["path", "segment", "summary", "evidence", "changeGroups", "tests", "flows", "limitations"]))
      return { valid: false, errors: ["Map output contains invalid or out-of-scope evidence."] };
    const item = observation as Record<string, unknown>;
    if (typeof item.path !== "string" || !Number.isInteger(item.segment) || !allowed.has(`${item.path}:${item.segment}`) || typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > 8_000 || !Array.isArray(item.evidence) || item.evidence.length === 0 || !stringArray(item.changeGroups) || !stringArray(item.tests) || !stringArray(item.flows) || !stringArray(item.limitations)) return { valid: false, errors: ["Map output contains invalid or out-of-scope evidence."] };
    const evidence = item.evidence.map((entry) => recordWithKeys(entry, ["path", "line"]) ? entry as Record<string, unknown> : null);
    if (evidence.some((entry) => !entry || entry.path !== item.path || !(entry.line === null || (Number.isInteger(entry.line) && (entry.line as number) >= 1)))) return { valid: false, errors: ["Map output contains invalid or out-of-scope evidence."] };
    const key = `${item.path}:${item.segment}`;
    const next = { path: item.path, segment: item.segment as number, summary: item.summary, evidence: evidence as Array<{ path: string; line: number | null }>, changeGroups: [...item.changeGroups as string[]], tests: [...item.tests as string[]], flows: [...item.flows as string[]], limitations: [...item.limitations as string[]] };
    const previous = observations.get(key);
    observations.set(key, previous ? mergeObservation(previous, next) : next);
  }
  if ([...allowed].some((key) => !observations.has(key))) return { valid: false, errors: ["Map output did not cover every assigned unit exactly once."] };
  return { valid: true, output: { taskId: task.id, observations: task.files.map((file) => observations.get(unitKey(file))!) }, errors: [] };
}

function recordWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0); }
function unitKey(value: Pick<BatchFile, "path" | "segment">): string { return `${value.path}:${value.segment}`; }
function mergeObservation(left: BatchMapOutput["observations"][number], right: BatchMapOutput["observations"][number]): BatchMapOutput["observations"][number] {
  const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()];
  const summary = unique([left.summary, right.summary], String).join("\n\n").slice(0, 8_000);
  return { ...left, summary, evidence: unique([...left.evidence, ...right.evidence], (item) => `${item.path}:${item.line}`), changeGroups: unique([...left.changeGroups, ...right.changeGroups], String), tests: unique([...left.tests, ...right.tests], String), flows: unique([...left.flows, ...right.flows], String), limitations: unique([...left.limitations, ...right.limitations], String) };
}
function parseHeaderPaths(value: string): [string, string] {
  if (!value.includes('"')) { const boundary = value.lastIndexOf(" b/"); if (boundary > 0) return [value.slice(0, boundary), value.slice(boundary + 1)]; }
  const tokens: string[] = []; let rest = value.trim();
  while (rest) { if (rest.startsWith('"')) { let end = 1; let escaped = false; for (; end < rest.length; end += 1) { if (!escaped && rest[end] === '"') break; escaped = !escaped && rest[end] === "\\"; if (rest[end] !== "\\") escaped = false; } tokens.push(rest.slice(0, end + 1)); rest = rest.slice(end + 1).trimStart(); } else { const end = rest.search(/\s/); tokens.push(end < 0 ? rest : rest.slice(0, end)); rest = end < 0 ? "" : rest.slice(end).trimStart(); } }
  return [tokens[0] ?? "", tokens[1] ?? ""];
}
function decodeDiffPath(value: string): string {
  const raw = value;
  if (!raw.startsWith('"')) return raw.replace(/^(?:a|b)\//, "");
  const body = raw.slice(1, -1); const chunks: Buffer[] = []; let literal = "";
  const flush = () => { if (literal) { chunks.push(Buffer.from(literal, "utf8")); literal = ""; } };
  for (let index = 0; index < body.length; index += 1) { if (body[index] !== "\\") { literal += body[index]; continue; } flush(); const next = body[++index]; if (next && /[0-7]/.test(next)) { const octal = `${next}${body[index + 1] ?? ""}${body[index + 2] ?? ""}`.match(/^[0-7]{1,3}/)?.[0] ?? next; chunks.push(Buffer.from([Number.parseInt(octal, 8)])); index += octal.length - 1; } else { const escapes: Record<string, string> = { a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", "\\": "\\", '"': '"' }; chunks.push(Buffer.from(next ? (escapes[next] ?? next) : "", "utf8")); } }
  flush(); return Buffer.concat(chunks).toString("utf8").replace(/^(?:a|b)\//, "");
}

function splitFile(file: ChangedDiff, max: number, overlap: number): BatchFile[] {
  const bytes = Buffer.byteLength(file.diff, "utf8");
  if (bytes <= max) return [{ path: file.path, diff: file.diff, bytes, segment: 0 }];
  const hunks = file.diff.split(/(?=^@@ )/m).filter(Boolean);
  const pieces: string[] = [];
  let current = "";
  for (const hunk of hunks) {
    if (Buffer.byteLength(hunk, "utf8") > max) {
      if (current) { pieces.push(current); current = ""; }
      pieces.push(...windowText(hunk, max, overlap));
    } else if (Buffer.byteLength(current + hunk, "utf8") > max && current) {
      pieces.push(current); current = hunk;
    } else current += hunk;
  }
  if (current) pieces.push(current);
  return pieces.map((diff, segment) => ({ path: file.path, diff, bytes: Buffer.byteLength(diff, "utf8"), segment }));
}

function windowText(text: string, max: number, overlap: number): string[] {
  const result: string[] = []; let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + max);
    while (Buffer.byteLength(text.slice(offset, end), "utf8") > max) end -= 1;
    result.push(text.slice(offset, end));
    if (end === text.length) break;
    offset = Math.max(offset + 1, end - overlap);
  }
  return result;
}
function subsystem(path: string): string { const parts = path.split("/"); return parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)"; }
