import type { AgentProvider, ProviderAccounting, ProviderCost, ProviderUsage } from "../../shared/contracts.js";

const CODEX_PRICING_VERSION = "2026-08-10";
const CODEX_PRICING_SOURCE = "OpenAI API pricing";
const LONG_CONTEXT_TOKENS = 272_000;
type CodexPrice = { input: number; cachedInput: number; output: number; cacheWriteInput?: number; longContext: boolean };
/** Small, versioned API-equivalent reference table; never a subscription charge. */
const CODEX_PRICING: Readonly<Record<string, CodexPrice>> = {
  "gpt-5.6": { input: 5, cachedInput: 0.5, output: 30, cacheWriteInput: 6.25, longContext: true },
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30, cacheWriteInput: 6.25, longContext: true },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12, cacheWriteInput: 2.5, longContext: true },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2, cacheWriteInput: 0.25, longContext: true },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15, longContext: true },
  "gpt-5.4-2026-03-05": { input: 2.5, cachedInput: 0.25, output: 15, longContext: true },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14, longContext: false },
  "gpt-5.2-2025-12-11": { input: 1.75, cachedInput: 0.175, output: 14, longContext: false },
};

const finiteTokens = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
function token(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) { const parsed = finiteTokens(value[key]); if (parsed !== undefined) return parsed; }
  return undefined;
}
function usageFrom(value: Record<string, unknown>): ProviderUsage | undefined {
  const input = token(value, "input_tokens", "inputTokens", "input");
  const cached = token(value, "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens", "cacheReadTokens", "cache_read_tokens");
  const cacheWrite = token(value, "cache_creation_input_tokens", "cacheCreationInputTokens", "cacheWriteInputTokens", "cache_write_input_tokens", "cacheWriteTokens", "cache_write_tokens");
  const output = token(value, "output_tokens", "outputTokens", "output");
  const reasoning = token(value, "reasoning_tokens", "reasoningTokens", "reasoning_output_tokens", "reasoningOutputTokens", "reasoning");
  const usage: ProviderUsage = { ...(input !== undefined ? { inputTokens: input } : {}), ...(cached !== undefined ? { cachedInputTokens: cached } : {}), ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}), ...(output !== undefined ? { outputTokens: output } : {}), ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}) };
  return Object.keys(usage).length ? usage : undefined;
}
function sumUsage(candidates: ProviderUsage[]): ProviderUsage | undefined {
  const result: ProviderUsage = {};
  for (const usage of candidates) for (const key of Object.keys(usage) as Array<keyof ProviderUsage>)
    result[key] = (result[key] ?? 0) + (finiteTokens(usage[key]) ?? 0);
  return Object.keys(result).length ? result : undefined;
}
/** Provider terminal/turn usage is cumulative, so keep its highest counter values. */
function cumulativeUsage(candidates: ProviderUsage[]): ProviderUsage | undefined {
  const result: ProviderUsage = {};
  for (const usage of candidates) for (const key of Object.keys(usage) as Array<keyof ProviderUsage>) {
    const value = usage[key]; if (value !== undefined && value >= (result[key] ?? 0)) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
function jsonEnvelopes(raw: string): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    try { const parsed: unknown = JSON.parse(line); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values.push(parsed as Record<string, unknown>); } catch { /* provider prose is not metadata */ }
  }
  if (!values.length) try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values.push(parsed as Record<string, unknown>); } catch { /* no envelope */ }
  return values;
}
function directUsage(envelope: Record<string, unknown>): ProviderUsage | undefined {
  const candidates: ProviderUsage[] = [];
  const direct = usageFrom(envelope); if (direct) candidates.push(direct);
  if (envelope.usage && typeof envelope.usage === "object" && !Array.isArray(envelope.usage)) {
    const usage = usageFrom(envelope.usage as Record<string, unknown>); if (usage) candidates.push(usage);
  }
  if (envelope.modelUsage && typeof envelope.modelUsage === "object" && !Array.isArray(envelope.modelUsage))
    for (const value of Object.values(envelope.modelUsage as Record<string, unknown>))
      if (value && typeof value === "object" && !Array.isArray(value)) { const usage = usageFrom(value as Record<string, unknown>); if (usage) candidates.push(usage); }
  return cumulativeUsage(candidates);
}
/** Claude's result.modelUsage is a whole-tree, per-model breakdown; result.usage excludes subagents. */
function claudeTerminalUsage(envelope: Record<string, unknown>): ProviderUsage | undefined {
  if (envelope.modelUsage && typeof envelope.modelUsage === "object" && !Array.isArray(envelope.modelUsage)) {
    const byModel = Object.values(envelope.modelUsage as Record<string, unknown>).flatMap((value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (() => { const usage = usageFrom(value as Record<string, unknown>); return usage ? [usage] : []; })()
        : [],
    );
    if (byModel.length) return sumUsage(byModel);
  }
  const candidates: ProviderUsage[] = [];
  const direct = usageFrom(envelope); if (direct) candidates.push(direct);
  if (envelope.usage && typeof envelope.usage === "object" && !Array.isArray(envelope.usage)) {
    const usage = usageFrom(envelope.usage as Record<string, unknown>); if (usage) candidates.push(usage);
  }
  return cumulativeUsage(candidates);
}
function reportedCost(envelope: Record<string, unknown>): number | undefined {
  const value = envelope.total_cost_usd ?? envelope.totalCostUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function priceUsage(price: CodexPrice, usage: ProviderUsage, longContext: boolean): number {
  const input = finiteTokens(usage.inputTokens) ?? 0;
  const cached = finiteTokens(usage.cachedInputTokens) ?? 0;
  const cacheWrite = finiteTokens(usage.cacheWriteInputTokens) ?? 0;
  const output = finiteTokens(usage.outputTokens) ?? 0;
  // Codex input is cumulative including cache buckets. Reasoning is already output.
  const uncached = Math.max(0, input - cached - (price.cacheWriteInput ? cacheWrite : 0));
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  return (uncached * price.input * inputMultiplier + cached * price.cachedInput * inputMultiplier + output * price.output * outputMultiplier + (price.cacheWriteInput ? cacheWrite * price.cacheWriteInput * inputMultiplier : 0)) / 1_000_000;
}

export function estimateCodexCost(model: string | undefined, usage: ProviderUsage | undefined): ProviderCost {
  const price = model ? CODEX_PRICING[model.trim().toLowerCase()] : undefined;
  if (!price) return { kind: "unavailable", reason: "No API pricing is recorded for this Codex model." };
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return { kind: "unavailable", reason: "Codex usage was not reported." };
  const amountUsd = priceUsage(price, usage, false);
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return { kind: "unavailable", reason: "Usage could not be safely priced." };
  const maxAmountUsd = price.longContext && (usage.inputTokens ?? 0) > LONG_CONTEXT_TOKENS
    ? priceUsage(price, usage, true)
    : undefined;
  return { kind: "estimated", amountUsd, ...(maxAmountUsd !== undefined && maxAmountUsd > amountUsd ? { maxAmountUsd } : {}), model: model!.trim(), pricingSource: CODEX_PRICING_SOURCE, pricingVersion: CODEX_PRICING_VERSION, pricingAsOf: CODEX_PRICING_VERSION };
}

export function parseProviderAccounting(provider: AgentProvider, raw: string, model?: string): ProviderAccounting {
  const envelopes = jsonEnvelopes(raw);
  if (provider === "claude") {
    const terminalUsage: ProviderUsage[] = []; const fallbackUsage: ProviderUsage[] = []; const costs: number[] = []; const seenMessageIds = new Set<string>();
    for (const envelope of envelopes) {
      if (envelope.type === "result") {
        const usage = claudeTerminalUsage(envelope); if (usage) terminalUsage.push(usage);
        const cost = reportedCost(envelope); if (cost !== undefined) costs.push(cost);
        continue;
      }
      if (envelope.type !== "assistant" || !envelope.message || typeof envelope.message !== "object" || Array.isArray(envelope.message)) continue;
      const message = envelope.message as Record<string, unknown>;
      const id = typeof message.id === "string" ? message.id : undefined;
      if (id && seenMessageIds.has(id)) continue;
      if (id) seenMessageIds.add(id);
      if (message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)) {
        const usage = usageFrom(message.usage as Record<string, unknown>); if (usage) fallbackUsage.push(usage);
      }
    }
    const usage = terminalUsage.length ? cumulativeUsage(terminalUsage) : sumUsage(fallbackUsage);
    const amountUsd = costs[costs.length - 1];
    return { ...(usage ? { usage } : {}), ...(amountUsd !== undefined ? { cost: { kind: "reported", amountUsd, ...(model ? { model } : {}) } as ProviderCost } : usage ? { cost: { kind: "unavailable", reason: "Claude reported usage but not total cost." } } : {}) };
  }
  const usage = cumulativeUsage(envelopes.flatMap((envelope) => { const value = directUsage(envelope); return value ? [value] : []; }));
  if (provider === "codex") return { ...(usage ? { usage } : {}), cost: estimateCodexCost(model, usage) };
  return { ...(usage ? { usage } : {}), cost: { kind: "unavailable", reason: "Cursor Agent does not expose model-specific pricing." } };
}

export function aggregateProviderAccounting(values: Array<ProviderAccounting | undefined>): ProviderAccounting {
  const usage = sumUsage(values.flatMap((value) => value?.usage ? [value.usage] : []));
  const costs = values.flatMap((value) => value?.cost ? [value.cost] : []);
  const priced = costs.filter((cost): cost is Extract<ProviderCost, { amountUsd: number }> => cost.kind !== "unavailable");
  const hasUnpricedUsage = values.some((value) => value?.usage && value.cost?.kind === "unavailable");
  const first = priced[0];
  if (!first) return { ...(usage ? { usage } : {}), ...(costs.find((cost) => cost.kind === "unavailable") ? { cost: costs.find((cost) => cost.kind === "unavailable") } : {}) };
  const amountUsd = priced.reduce((sum, cost) => sum + cost.amountUsd, 0);
  if (first.kind === "estimated") {
    const maxAmountUsd = priced.reduce((sum, cost) => sum + (cost.kind === "estimated" ? cost.maxAmountUsd ?? cost.amountUsd : cost.amountUsd), 0);
    return { ...(usage ? { usage } : {}), cost: { ...first, amountUsd, ...(maxAmountUsd > amountUsd ? { maxAmountUsd } : {}), ...(hasUnpricedUsage ? { incomplete: true } : {}) } };
  }
  return { ...(usage ? { usage } : {}), cost: { ...first, amountUsd, ...(hasUnpricedUsage ? { incomplete: true } : {}) } };
}
