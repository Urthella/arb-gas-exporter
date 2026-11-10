// Checks the exporter's readings against a second RPC provider, live: `npm run crosscheck`.
// For each chain the L2 base fee read through ArbGasInfo must equal the baseFeePerGas that the
// other provider reports for the very same block, and both providers must agree on the ArbOS
// version and the base fee floor.

import { type Rpc, type Sample, scrape } from "../src/arbitrum.ts";

const CHAINS = [
  ["arbitrum-one", "https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  ["arbitrum-nova", "https://nova.arbitrum.io/rpc", "https://arbitrum-nova-rpc.publicnode.com"],
  ["arbitrum-sepolia", "https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"],
];

const rpc =
  (url: string): Rpc =>
  async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  };

const get = (samples: Sample[], name: string) => samples.find((s) => s.name === name && !s.labels)?.value;

/** The other provider may be a block or two behind, so ask again for a few seconds. */
async function header(other: Rpc, block: bigint): Promise<{ baseFeePerGas: string }> {
  for (let attempt = 0; ; attempt++) {
    const found = await other("eth_getBlockByNumber", ["0x" + block.toString(16), false]);
    if (found) return found as { baseFeePerGas: string };
    if (attempt === 10) throw new Error(`block ${block} never appeared`);
    await new Promise((wait) => setTimeout(wait, 500));
  }
}

interface Tx {
  hash: string;
  to: string | null;
  input: string;
  value: string;
}

/** The L1 gas that real plain ETH transfers paid in the blocks up to `block`, from receipts. */
async function realTransfers(chain: Rpc, block: bigint): Promise<bigint[]> {
  const used: bigint[] = [];
  for (let b = block; used.length < 8 && b > block - 60n; b--) {
    const found = (await chain("eth_getBlockByNumber", ["0x" + b.toString(16), true])) as { transactions: Tx[] } | null;
    for (const tx of found?.transactions ?? []) {
      if (used.length >= 8 || tx.input !== "0x" || !tx.to || BigInt(tx.value) === 0n) continue;
      const receipt = (await chain("eth_getTransactionReceipt", [tx.hash])) as { gasUsed: string; gasUsedForL1: string };
      // A transfer to a contract runs code; only 21000 + the L1 part is a plain transfer.
      if (BigInt(receipt.gasUsed) === 21_000n + BigInt(receipt.gasUsedForL1)) used.push(BigInt(receipt.gasUsedForL1));
    }
  }
  return used.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

let failed = 0;
for (const [chain, primary, secondary] of CHAINS) {
  const ours = await scrape(rpc(primary));
  const theirs = await scrape(rpc(secondary));
  const block = get(ours, "block_number") as bigint;
  const { baseFeePerGas } = await header(rpc(secondary), block);
  const checks: [string, unknown, unknown][] = [
    [`base fee at block ${block}, vs the other provider's header`, get(ours, "l2_base_fee_wei"), BigInt(baseFeePerGas)],
    ["ArbOS version, between providers", get(ours, "arbos_version"), get(theirs, "arbos_version")],
    ["base fee floor, between providers", get(ours, "l2_minimum_base_fee_wei"), get(theirs, "l2_minimum_base_fee_wei")],
  ];
  for (const [what, a, b] of checks) {
    const ok = a === b && a !== undefined;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${chain}: ${what}: ${a}${ok ? "" : ` vs ${b}`}`);
  }

  // NodeInterface pads its estimate by 10% and sizes it for a worst-case transaction, so it
  // should sit at or above what real transfers paid, but not wildly so.
  const estimate = get(ours, "eth_transfer_l1_gas_estimate") as bigint | undefined;
  const real = await realTransfers(rpc(primary), block);
  if (real.length === 0) {
    console.log(`skip ${chain}: no plain transfers in the last 60 blocks`);
    continue;
  }
  const median = real[real.length >> 1];
  const ok = estimate !== undefined && estimate >= median && estimate <= (median * 5n) / 2n;
  if (!ok) failed++;
  const range = `${real.length} real transfers paid ${real[0]} to ${real.at(-1)}, median ${median}`;
  console.log(`${ok ? "ok  " : "FAIL"} ${chain}: transfer L1 gas estimate ${estimate}; ${range}`);
}
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exitCode = 1;
}
