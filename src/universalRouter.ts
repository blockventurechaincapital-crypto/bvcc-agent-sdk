import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

import { erc20Abi } from "./abi.js";
import type { Execution } from "./types.js";

/**
 * Uniswap Universal Router encoder (Permit2 funding model).
 *
 * Builds the `execute(commands, inputs, deadline)` calldata plus the surrounding
 * batch so a BVCC Agent Wallet can swap through the Universal Router — the same
 * router the BVCC frontend whitelists.
 *
 * For token input the wallet authorizes the router **through Permit2** rather
 * than transferring tokens to the router. Nothing is sent "blind": a wrong
 * router address makes the swap revert instead of losing funds. Permit2's
 * address is the same on every chain, so it is safe to hardcode.
 *
 * For native input the ETH is wrapped inside the router (WRAP_ETH); no Permit2
 * is involved on that leg.
 */

// Universal Router command bytes (stable across UR versions).
const CMD_V3_SWAP_EXACT_IN = 0x00;
const CMD_WRAP_ETH = 0x0b;
const CMD_UNWRAP_WETH = 0x0c;

// Universal Router recipient sentinels.
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";

/** Canonical Permit2 — identical on every chain. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

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

/** Encode a Uniswap v3 path: token0, fee0, token1, [fee1, token2, ...]. */
export function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error("encodeV3Path: need N tokens and N-1 fees");
  }
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  for (let i = 0; i < fees.length; i++) {
    types.push("address", "uint24");
    values.push(tokens[i], fees[i]);
  }
  types.push("address");
  values.push(tokens[tokens.length - 1]);
  return encodePacked(types, values);
}

function commandsHex(cmds: number[]): Hex {
  return concatHex(cmds.map((c) => (("0x" + c.toString(16).padStart(2, "0")) as Hex)));
}

const v3ExactInInput = (
  recipient: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  path: Hex,
  payerIsUser: boolean,
): Hex =>
  encodeAbiParameters(
    parseAbiParameters("address, uint256, uint256, bytes, bool"),
    [recipient, amountIn, amountOutMin, path, payerIsUser],
  );

const wrapUnwrapInput = (recipient: Address, amountMin: bigint): Hex =>
  encodeAbiParameters(parseAbiParameters("address, uint256"), [recipient, amountMin]);

export interface UniversalRouterSwapParams {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  /** Single-hop fee tier (ignored if `path` is given). Default 3000 (0.3%). */
  fee?: number;
  /** Multi-hop override. `tokens[0]` must be tokenIn, last must be tokenOut. */
  path?: { tokens: Address[]; fees: number[] };
  /** Input is native ETH/BNB: prepend WRAP_ETH and send `value = amountIn`. */
  nativeIn?: boolean;
  /** Output should be unwrapped to native: append UNWRAP_WETH. */
  nativeOut?: boolean;
  /** Where the wallet receives the output. Defaults to the wallet (MSG_SENDER). */
  recipient?: Address;
  /** Unix seconds. Defaults to now + 20 min. */
  deadline?: bigint;
}

const MAX_UINT160 = (1n << 160n) - 1n;

/**
 * Build the `Execution[]` batch for a Universal Router v3 exact-input swap using
 * the Permit2 funding model. Pass the result to `BvccAgentClient.execute(...)`.
 *
 * The agent's `allowedProtocols` must include **both Permit2 and the router**,
 * and (for token input) `tokenIn` must be in `allowedTokens` — the leading
 * `approve(Permit2, amountIn)` is an ERC-20 approve the wallet validates and
 * counts toward the token budget. Output returns to the wallet.
 */
export function buildUniversalRouterSwap(p: UniversalRouterSwapParams): Execution[] {
  const fee = p.fee ?? 3000;
  const path = p.path
    ? encodeV3Path(p.path.tokens, p.path.fees)
    : encodeV3Path([p.tokenIn, p.tokenOut], [fee]);

  const deadline = p.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1200);
  const finalRecipient = p.recipient ?? MSG_SENDER;

  if (p.amountIn > MAX_UINT160) {
    throw new Error("amountIn exceeds uint160 (Permit2 limit)");
  }

  const cmds: number[] = [];
  const inputs: Hex[] = [];

  if (p.nativeIn) {
    // Wrap the sent ETH into WETH held by the router, then swap from router balance.
    cmds.push(CMD_WRAP_ETH);
    inputs.push(wrapUnwrapInput(ADDRESS_THIS, p.amountIn));
  }

  // If we still need to unwrap at the end, the swap output must stay in the router.
  const swapRecipient = p.nativeOut ? ADDRESS_THIS : finalRecipient;
  cmds.push(CMD_V3_SWAP_EXACT_IN);
  inputs.push(
    v3ExactInInput(
      swapRecipient,
      p.amountIn,
      p.nativeOut ? 0n : p.amountOutMinimum, // min enforced on the unwrap step instead
      path,
      // Native input is already wrapped into the router (payerIsUser=false).
      // Token input is pulled from the wallet via Permit2 (payerIsUser=true).
      !p.nativeIn,
    ),
  );

  if (p.nativeOut) {
    cmds.push(CMD_UNWRAP_WETH);
    inputs.push(wrapUnwrapInput(finalRecipient, p.amountOutMinimum));
  }

  const executeData = encodeFunctionData({
    abi: URROUTER_ABI,
    functionName: "execute",
    args: [commandsHex(cmds), inputs, deadline],
  });

  const executions: Execution[] = [];

  // Token input: authorize the router through Permit2 (no blind transfer).
  if (!p.nativeIn) {
    executions.push({
      target: p.tokenIn,
      value: 0n,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2, p.amountIn],
      }),
    });
    executions.push({
      target: PERMIT2,
      value: 0n,
      callData: encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [p.tokenIn, p.router, p.amountIn, Number(deadline)],
      }),
    });
  }

  executions.push({
    target: p.router,
    value: p.nativeIn ? p.amountIn : 0n,
    callData: executeData,
  });

  return executions;
}

export { MSG_SENDER, ADDRESS_THIS };
