// Prometheus's text exposition format: a HELP and TYPE line per metric, then one line per sample.

import type { Sample } from "./arbitrum.ts";

export const PREFIX = "arbitrum_";

export const HELP: Record<string, string> = {
  up: "1 if the last scrape of the chain's RPC worked, 0 if it didn't.",
  scrape_duration_seconds: "How long reading the chain took.",
  block_number: "The block every other value was read at.",
  arbos_version: "The ArbOS version the chain runs.",
  l2_base_fee_wei: "The L2 base fee per gas.",
  l2_minimum_base_fee_wei: "The floor the L2 base fee can't go below.",
  l1_base_fee_estimate_wei: "ArbOS's estimate of the parent chain's base fee.",
  l1_cost_simple_tx_wei: "The parent-chain part of a simple transaction's fee (140 bytes of calldata).",
  l1_calldata_byte_price_wei: "The parent-chain price of one byte of calldata.",
  storage_slot_price_wei: "The price of allocating one storage slot.",
  l1_pricing_surplus_wei: "What the L1 pricer holds minus what it owes for posting data to the parent chain; negative is a deficit.",
  gas_backlog:
    "Gas used beyond the speed limit, not yet worked off (single-constraint pricing; stops changing once a chain uses gas_constraint_backlog).",
  gas_speed_limit_per_second: "The gas per second the L2 base fee is tuned to (single-constraint pricing).",
  gas_constraint_target_per_second: "Target gas per second of one multi-constraint pricing constraint (ArbOS 50+).",
  gas_constraint_backlog: "Backlog in gas of one multi-constraint pricing constraint (ArbOS 50+).",
  multigas_base_fee_wei: "Base fee per gas of one resource kind in multi-dimensional pricing (ArbOS 60+).",
};

function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Renders samples from every chain, grouped by metric so each HELP and TYPE appears once. */
export function render(chains: { chain: string; samples: Sample[] }[]): string {
  const byName = new Map<string, string[]>();
  for (const { chain, samples } of chains) {
    for (const { name, labels, value } of samples) {
      const pairs = Object.entries({ chain, ...labels }).map(([k, v]) => `${k}="${escape(v)}"`);
      const lines = byName.get(name) ?? [];
      lines.push(`${PREFIX}${name}{${pairs.join(",")}} ${value}`);
      byName.set(name, lines);
    }
  }
  let out = "";
  for (const [name, lines] of byName) {
    out += `# HELP ${PREFIX}${name} ${HELP[name] ?? name}\n# TYPE ${PREFIX}${name} gauge\n`;
    out += lines.join("\n") + "\n";
  }
  return out;
}
