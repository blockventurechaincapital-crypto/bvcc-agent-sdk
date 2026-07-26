import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

import { erc20Abi } from "./abi.js";
import { PERMIT2 } from "./universalRouter.js";
import type { Execution } from "./types.js";

/**
 * Uniswap v4 swap encoder for the Universal Router (command V4_SWAP = 0x10).
 *
 * The v4 ExactInputParams layout is the canonical v4-periphery IV4Router struct.
 * (An earlier version carried a phantom `uint256[] minHopPriceX36` field that the
 * deployed routers do not have; it shifted `amountIn`/`amountOutMinimum` by one
 * slot, so the router read the array offset as `amountIn` — the swap under-filled
 * to dust and ignored the min. Removed; confirmed on-chain against the Arbitrum
 * UR 0xa51afafe…381a3.)
 *
 *   struct ExactInputParams {
 *     Currency currencyIn;
 *     PathKey[] path;
 *     uint128 amountIn;
 *     uint128 amountOutMinimum;
 *   }
 *   struct PathKey {
 *     Currency intermediateCurrency; uint24 fee; int24 tickSpacing;
 *     address hooks; bytes hookData;
 *   }
 *
 * Plan = SWAP_EXACT_IN (0x07) + SETTLE (0x0b) + TAKE (0x0e). Token input is
 * funded through Permit2 (no blind transfer). For native output the swap routes
 * through the native pool (output currency = address(0)) and the TAKE sends ETH
 * straight to the wallet — no WETH, no UNWRAP_WETH, no ADDRESS_THIS. This keeps
 * the calldata inside the UR validator's ERC-20-recipient rule (every output
 * lands in the wallet; nothing is ever parked in the router to be swept).
 */

// v4 Router actions.
const ACTION_SWAP_EXACT_IN = 0x07;
const ACTION_SETTLE = 0x0b;
const ACTION_TAKE = 0x0e;

// Universal Router commands.
const CMD_V4_SWAP = 0x10;

// Sentinels.
const OPEN_DELTA = 0n;

const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000"; // = native currency (v4 ETH side)
const MAX_UINT160 = (1n << 160n) - 1n;

const URROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

/** One hop of a v4 path. `hooks`/`hookData` default to none. */
export interface V4PathKey {
  intermediateCurrency: Address;
  fee: number;
  tickSpacing: number;
  hooks?: Address;
  hookData?: Hex;
}

const PATHKEY_T =
  "(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)";
const EXACT_IN_T = `(address currencyIn, ${PATHKEY_T}[] path, uint128 amountIn, uint128 amountOutMinimum)`;

function encodeActions(actions: number[]): Hex {
  return concatHex(actions.map((a) => (("0x" + a.toString(16).padStart(2, "0")) as Hex)));
}

function commandsHex(cmds: number[]): Hex {
  return concatHex(cmds.map((c) => (("0x" + c.toString(16).padStart(2, "0")) as Hex)));
}

export interface V4SwapExactInParams {
  router: Address;
  /** Input token (ERC-20). Native ETH input is not supported by this helper yet. */
  tokenIn: Address;
  /** Final output currency (ERC-20). Ignored when `nativeOut` is set (output = address(0)). */
  tokenOut: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  /** Single-hop pool params (ignored if `path` is given). */
  fee?: number;
  tickSpacing?: number;
  hooks?: Address;
  hookData?: Hex;
  /** Multi-hop override: ordered PathKeys ending at `tokenOut`. */
  path?: V4PathKey[];
  /** Deliver native ETH via the native (address(0)) pool — TAKE goes straight to
   *  the wallet, no WETH/UNWRAP_WETH. Pass the native pool's `fee`/`tickSpacing`. */
  nativeOut?: boolean;
  /** Output recipient (defaults to MSG_SENDER → the caller wallet). */
  recipient?: Address;
  /** Unix seconds. Defaults to now + 20 min. */
  deadline?: bigint;
}

/**
 * Build the `Execution[]` batch for a Uniswap v4 exact-input swap through the
 * Universal Router. Pass the result to `BvccAgentClient.execute(...)`.
 *
 * `allowedProtocols` must include **Permit2 and the router**; `tokenIn` must be
 * in `allowedTokens` (the leading `approve(Permit2, amountIn)` counts toward the
 * token budget). Output returns to the wallet.
 */
export function buildV4SwapExactIn(p: V4SwapExactInParams): Execution[] {
  if (p.amountIn > MAX_UINT160) throw new Error("amountIn exceeds uint160 (Permit2 limit)");

  // Native output routes through the native pool: the output currency is
  // address(0) and the TAKE delivers ETH straight to the wallet. ERC-20 output
  // uses tokenOut. Either way nothing is parked in the router (no ADDRESS_THIS,
  // no UNWRAP_WETH) — the UR validator requires every output to land in the wallet.
  const outputCurrency = p.nativeOut ? ZERO_ADDR : p.tokenOut;

  const path: V4PathKey[] =
    p.path ??
    [
      {
        intermediateCurrency: outputCurrency,
        fee: p.fee ?? 3000,
        tickSpacing: p.tickSpacing ?? 60,
        hooks: p.hooks ?? ZERO_ADDR,
        hookData: p.hookData ?? "0x",
      },
    ];

  const deadline = p.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1200);
  const finalRecipient = p.recipient ?? "0x0000000000000000000000000000000000000001"; // MSG_SENDER

  const swapParams = encodeAbiParameters(parseAbiParameters(EXACT_IN_T), [
    {
      currencyIn: p.tokenIn,
      path: path.map((k) => ({
        intermediateCurrency: k.intermediateCurrency,
        fee: k.fee,
        tickSpacing: k.tickSpacing,
        hooks: k.hooks ?? ZERO_ADDR,
        hookData: k.hookData ?? "0x",
      })),
      amountIn: p.amountIn,
      // The real slippage floor lives on the swap itself — TAKE goes to the wallet,
      // there is no unwrap leg to move the check to.
      amountOutMinimum: p.amountOutMinimum,
    },
  ] as never);

  const settleParams = encodeAbiParameters(
    parseAbiParameters("address currency, uint256 amount, bool payerIsUser"),
    [p.tokenIn, OPEN_DELTA, true],
  );
  const takeParams = encodeAbiParameters(
    parseAbiParameters("address currency, address recipient, uint256 amount"),
    [outputCurrency, finalRecipient, OPEN_DELTA],
  );

  const actions = encodeActions([ACTION_SWAP_EXACT_IN, ACTION_SETTLE, ACTION_TAKE]);
  const v4Input = encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), [
    actions,
    [swapParams, settleParams, takeParams],
  ]);

  const executeData = encodeFunctionData({
    abi: URROUTER_ABI,
    functionName: "execute",
    args: [commandsHex([CMD_V4_SWAP]), [v4Input], deadline],
  });

  // Permit2 funding for the ERC-20 input (no blind transfer to the router).
  return [
    {
      target: p.tokenIn,
      value: 0n,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2, p.amountIn],
      }),
    },
    {
      target: PERMIT2,
      value: 0n,
      callData: encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [p.tokenIn, p.router, p.amountIn, Number(deadline)],
      }),
    },
    { target: p.router, value: 0n, callData: executeData },
  ];
}
