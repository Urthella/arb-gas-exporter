# arb-gas-exporter

A Prometheus exporter for gas prices on Arbitrum chains. It reads the L2 base fee, the
parent-chain data price, the pricing backlogs and the ArbOS version straight from the chain's
`ArbGasInfo` and `ArbSys` precompiles, and serves them on `/metrics`.

I couldn't find an existing exporter for these precompiles. Gas trackers show a price; this
gives you the series behind it, for alerting and dashboards. It covers Arbitrum One, Nova,
Sepolia and Arbitrum chains built on Orbit.

## Quick start

Node 24 runs the TypeScript directly, and there are no runtime dependencies to install.

```sh
git clone https://github.com/Urthella/arb-gas-exporter && cd arb-gas-exporter
npm start -- --chain arbitrum-one=https://arb1.arbitrum.io/rpc --chain arbitrum-nova=https://nova.arbitrum.io/rpc
curl http://127.0.0.1:9850/metrics
```

| Flag | Default | |
|---|---|---|
| `--chain NAME=RPC_URL` | `arbitrum-one=https://arb1.arbitrum.io/rpc` | Repeat for more chains. `NAME` becomes the `chain` label. |
| `--address` | `127.0.0.1` | Where to listen. |
| `--port` | `9850` | `0` picks a free port, which the startup line prints. |

```yaml
scrape_configs:
  - job_name: arbitrum-gas
    scrape_interval: 15s
    static_configs:
      - targets: ["127.0.0.1:9850"]
```

Each scrape reads every chain again; nothing is cached. That's nine `eth_call`s and one
`eth_blockNumber` per chain per scrape.

## Metrics

Every metric is a gauge with a `chain` label.

| Metric | Extra labels | What it is |
|---|---|---|
| `arbitrum_up` | | 1 if the last scrape of the chain's RPC worked, 0 if it didn't. |
| `arbitrum_scrape_duration_seconds` | | How long reading the chain took. |
| `arbitrum_block_number` | | The block every other value was read at. |
| `arbitrum_arbos_version` | | The ArbOS version the chain runs. |
| `arbitrum_l2_base_fee_wei` | | The L2 base fee per gas. |
| `arbitrum_l2_minimum_base_fee_wei` | | The floor the L2 base fee can't go below. |
| `arbitrum_l1_base_fee_estimate_wei` | | ArbOS's estimate of the parent chain's base fee. |
| `arbitrum_l1_cost_simple_tx_wei` | | The parent-chain part of a simple transaction's fee (140 bytes of calldata). |
| `arbitrum_l1_calldata_byte_price_wei` | | The parent-chain price of one byte of calldata. |
| `arbitrum_storage_slot_price_wei` | | The price of allocating one storage slot. |
| `arbitrum_l1_pricing_surplus_wei` | | What the L1 pricer holds minus what it owes for posting data; negative is a deficit. |
| `arbitrum_gas_backlog` | | Gas used beyond the speed limit, not yet worked off (single-constraint pricing). |
| `arbitrum_gas_speed_limit_per_second` | | The gas per second the L2 base fee is tuned to (single-constraint pricing). |
| `arbitrum_gas_constraint_target_per_second` | `constraint`, `window_seconds` | Target gas per second of one pricing constraint (ArbOS 50+). |
| `arbitrum_gas_constraint_backlog` | `constraint`, `window_seconds` | Backlog in gas of one pricing constraint (ArbOS 50+). |
| `arbitrum_multigas_base_fee_wei` | `resource` | Base fee per gas of one resource kind, such as `computation` or `storage_growth` (ArbOS 60+). |

## Notes

- **One block per scrape.** The exporter reads `eth_blockNumber` first and makes every
  call at that block. Calls at `latest` can land on different blocks, since Arbitrum makes
  a block about every 250 ms, and then the values wouldn't describe the same moment.
- **Missing pieces are left out, not errors.** Per Offchain Labs' interface docs, the
  pricing constraints arrived in ArbOS 50 and the multi-gas base fees in ArbOS 60. On an
  older chain those calls revert, and their metrics are simply absent. Only a failed
  block-number or price read marks the chain down.
- **Single-constraint versus multi-constraint pricing.**
  - `gas_backlog` and `gas_speed_limit_per_second` belong to the single-constraint model.
    Since ArbOS 50 they report that model even on chains priced by constraints.
  - On Arbitrum One, `gas_backlog` read 90804295 at every check across about 2,500
    blocks, while the per-constraint backlogs kept changing. Read
    `gas_constraint_backlog` there.
  - Nova has no constraints and still uses the single model.
- **The surplus is signed.** Nova's was negative, a deficit, when the test fixture was
  captured.
- **Where the numbers come from.**
  - `arbOSVersion()` returns 55 plus the version, so 116 means ArbOS 61.
  - `getPricesInWei()` returns six values. The exporter takes the L1 cost of a simple
    transaction (Nitro's `AssumedSimpleTxSize` is 140 bytes), the calldata byte price, the
    storage slot price and the current base fee. The floor comes from
    `getMinimumGasPrice()`, because before ArbOS 4 the "base" field held the current price
    instead.

## How it's checked

- **Captured replies.** `test/fixtures` holds every reply Arbitrum One and Nova gave at one
  block, along with that block's `baseFeePerGas` from `eth_getBlockByNumber`. The tests
  check:
  - the base fee read through `ArbGasInfo` equals the block's own;
  - the simple transaction's L1 cost is exactly 140 times the byte price;
  - the floor equals the "base" field of `getPricesInWei()`;
  - Nova's surplus decodes as negative;
  - every call is pinned to one block and sent to the right precompile.
- **Selectors.** Each function selector is checked against the Keccak-256 of its signature,
  computed with [`@noble/hashes`](https://github.com/paulmillr/noble-hashes).
- **Older ArbOS and other chains.** Calls that revert or return nothing are left out without
  failing the scrape. A chain that isn't Arbitrum, or an RPC with no block, is marked down.
  Malformed ABI arrays are rejected.
- **The real exporter.** A black-box test runs it against fake JSON-RPC servers, one
  working, one answering HTTP 500 and one returning a JSON-RPC error. It reads `/metrics`
  and checks:
  - every line of the text format;
  - one HELP per metric;
  - label escaping;
  - `arbitrum_up` for each chain;
  - the error each failure logs.
- **A second provider, live.** `npm run crosscheck` reads Arbitrum One, Nova and Sepolia
  through Arbitrum's own RPCs. It then asks [PublicNode](https://www.publicnode.com) for the
  header of that exact block. The base fee must match it, and both providers must report the
  same ArbOS version and floor. All 9 checks passed.
- **Mutation testing.** Twenty-two deliberate bugs were planted one at a time, and the tests
  caught every one. The bugs included:
  - the wrong version offset;
  - unsigned surplus;
  - unpinned calls;
  - swapped constraint fields;
  - an ignored array length;
  - a failed price read treated as fine;
  - unescaped labels.

## Develop

```sh
npm install
npm test
npm run typecheck
npm run crosscheck   # live, needs network
```

Or `nix develop` for Node 24.

## Credits

The function signatures and their documentation come from Offchain Labs'
[nitro-precompile-interfaces](https://github.com/OffchainLabs/nitro-precompile-interfaces).
The field meanings were checked against [Nitro's source](https://github.com/OffchainLabs/nitro/blob/master/precompiles/ArbGasInfo.go).

## License

MIT
