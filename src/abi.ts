/**
 * Minimal ABIs the SDK needs. Kept hand-trimmed so the bundle stays small and
 * the typed surface is exactly what we call — no full artifact imports.
 */

/** BVCCAgentWalletV2 — only the agent-facing entrypoint and read methods. */
export const agentWalletAbi = [
  {
    type: "function",
    name: "executeAsAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentPermission",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "maxPerTxWei", type: "uint128" },
          { name: "dailyLimitWei", type: "uint128" },
          { name: "totalBudgetWei", type: "uint128" },
          { name: "totalSpentWei", type: "uint128" },
          { name: "periodBudgetWei", type: "uint128" },
          { name: "periodSpentWei", type: "uint128" },
          { name: "allowedTokens", type: "address[]" },
          { name: "tokenMaxAmounts", type: "uint128[]" },
          { name: "tokenDailyLimits", type: "uint128[]" },
          { name: "tokenTotalBudgets", type: "uint128[]" },
          { name: "allowedProtocols", type: "address[]" },
          { name: "allowedRecipients", type: "address[]" },
          { name: "expiry", type: "uint64" },
          { name: "periodDuration", type: "uint64" },
          { name: "periodStart", type: "uint64" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDailySpent",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getTokenSpent",
    stateMutability: "view",
    inputs: [
      { name: "agent", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "dailySpent", type: "uint128" },
      { name: "totalSpent", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "getAgents",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "walletType",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** ERC-20 subset used by the token/swap helpers. */
export const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Permit2 `allowance` read: (amount, expiration, nonce). */
export const permit2AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

/** Uniswap v3 QuoterV2 — quoteExactInputSingle (state-mutating; use via simulate). */
export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Uniswap v4 Quoter — quoteExactInputSingle (state-mutating; use via simulate). */
export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Uniswap v3 SwapRouter02 — exactInputSingle only. */
export const swapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;
