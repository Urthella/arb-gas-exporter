// What the exporter reads from an Arbitrum chain: gas prices from the ArbGasInfo precompile and
// the ArbOS version from ArbSys, every call pinned to the same block so the numbers agree.

export const ARB_SYS = "0x0000000000000000000000000000000000000064";
export const ARB_GAS_INFO = "0x000000000000000000000000000000000000006c";

/** Each function's selector: the first four bytes of the Keccak-256 of its signature. */
export const SELECTORS = {
  "arbOSVersion()": "0x051038f2",
  "getPricesInWei()": "0x41b247a8",
  "getMinimumGasPrice()": "0xf918379a",
  "getL1BaseFeeEstimate()": "0xf5d6ded7",
  "getL1PricingSurplus()": "0x520acdd7",
  "getGasBacklog()": "0x1d5b5c20",
  "getGasAccountingParams()": "0x612af178",
  "getGasPricingConstraints()": "0x232027d1",
  "getMultiGasBaseFee()": "0xc0e10bbb",
} as const;
type Signature = keyof typeof SELECTORS;

/** The order of ArbMultiGasConstraintsTypes.ResourceKind, which indexes getMultiGasBaseFee. */
export const RESOURCE_KINDS = [
  "unknown",
  "computation",
  "history_growth",
  "storage_access_read",
  "storage_access_write",
  "storage_growth",
  "single_dim",
  "l2_calldata",
  "wasm_computation",
];

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface Sample {
  name: string;
  labels?: Record<string, string>;
  value: bigint | number;
}

/** The 32-byte words of an ABI-encoded return value. */
export function words(hex: unknown): bigint[] {
  if (typeof hex !== "string" || !/^0x(?:[0-9a-fA-F]{64})*$/.test(hex)) {
    throw new Error(`not ABI-encoded words: ${String(hex).slice(0, 24)}`);
  }
  return (hex.slice(2).match(/.{64}/g) ?? []).map((word) => BigInt("0x" + word));
}

function fixed(hex: unknown, count: number): bigint[] {
  const w = words(hex);
  if (w.length !== count) throw new Error(`expected ${count} words, got ${w.length}`);
  return w;
}

/** Two's complement, for int256. */
export function signed(word: bigint): bigint {
  return word >= 1n << 255n ? word - (1n << 256n) : word;
}

/** A dynamic array whose items are `width` words each: an offset, a length, then the items. */
export function array(hex: unknown, width: number): bigint[][] {
  const w = words(hex);
  const start = w.length > 0 && w[0] % 32n === 0n ? Number(w[0] / 32n) : -1;
  if (start < 0 || start >= w.length) throw new Error("malformed ABI array");
  const length = w[start];
  const items = w.slice(start + 1);
  if (BigInt(items.length) !== length * BigInt(width)) throw new Error("malformed ABI array");
  return Array.from({ length: Number(length) }, (_, i) => items.slice(i * width, (i + 1) * width));
}

/** Reads one chain. Fails if the block or the prices can't be read; anything else this ArbOS
 * version doesn't have (a revert, an empty or odd reply) is left out. */
export async function scrape(rpc: Rpc): Promise<Sample[]> {
  const block = await rpc("eth_blockNumber", []);
  if (typeof block !== "string" || !/^0x[0-9a-fA-F]+$/.test(block)) throw new Error("no block number");
  const call = (to: string, signature: Signature) =>
    rpc("eth_call", [{ to, data: SELECTORS[signature] }, block]);
  const gas = (signature: Signature) => call(ARB_GAS_INFO, signature);

  const [prices, ...optional] = await Promise.allSettled([
    gas("getPricesInWei()"),
    call(ARB_SYS, "arbOSVersion()"),
    gas("getMinimumGasPrice()"),
    gas("getL1BaseFeeEstimate()"),
    gas("getL1PricingSurplus()"),
    gas("getGasBacklog()"),
    gas("getGasAccountingParams()"),
    gas("getGasPricingConstraints()"),
    gas("getMultiGasBaseFee()"),
  ]);
  if (prices.status === "rejected") throw prices.reason;
  const [perSimpleTx, perCalldataByte, perStorageSlot, , , baseFee] = fixed(prices.value, 6);
  const samples: Sample[] = [
    { name: "block_number", value: BigInt(block) },
    { name: "l2_base_fee_wei", value: baseFee },
    { name: "l1_cost_simple_tx_wei", value: perSimpleTx },
    { name: "l1_calldata_byte_price_wei", value: perCalldataByte },
    { name: "storage_slot_price_wei", value: perStorageSlot },
  ];

  const readers: ((hex: unknown) => Sample[])[] = [
    (hex) => [{ name: "arbos_version", value: fixed(hex, 1)[0] - 55n }],
    (hex) => [{ name: "l2_minimum_base_fee_wei", value: fixed(hex, 1)[0] }],
    (hex) => [{ name: "l1_base_fee_estimate_wei", value: fixed(hex, 1)[0] }],
    (hex) => [{ name: "l1_pricing_surplus_wei", value: signed(fixed(hex, 1)[0]) }],
    (hex) => [{ name: "gas_backlog", value: fixed(hex, 1)[0] }],
    (hex) => [{ name: "gas_speed_limit_per_second", value: fixed(hex, 3)[0] }],
    (hex) =>
      array(hex, 3).flatMap(([target, window, backlog], i) => {
        const labels = { constraint: String(i), window_seconds: String(window) };
        return [
          { name: "gas_constraint_target_per_second", labels, value: target },
          { name: "gas_constraint_backlog", labels, value: backlog },
        ];
      }),
    (hex) =>
      array(hex, 1).map(([fee], i) => ({
        name: "multigas_base_fee_wei",
        labels: { resource: RESOURCE_KINDS[i] ?? `kind_${i}` },
        value: fee,
      })),
  ];
  optional.forEach((result, i) => {
    if (result.status === "rejected") return;
    try {
      samples.push(...readers[i](result.value));
    } catch {
      // Not on this chain's ArbOS version, or not an Arbitrum chain at all.
    }
  });
  return samples;
}
