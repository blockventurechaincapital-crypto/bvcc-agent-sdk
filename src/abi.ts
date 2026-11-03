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
  // ── V3 only ───────────────────────────────────────────────────────────────
  // Reverts on V2 wallets (function absent) — that revert is how `detectWalletVersion`
  // tells the two apart, since walletType() returns 1 for both.
  //
  // `setCallPolicy` is deliberately NOT here: only the wallet itself can call it,
  // authenticated by Face ID / WebAuthn. This SDK is agent-side and must never
  // present policy-writing as something an agent key could do.
  {
    type: "function",
    name: "getCallPolicy",
    stateMutability: "view",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * BVCCValidatorRegistry — fixed-address dispatch point for DEEP call policies.
 *
 * Read-only subset. Governance (propose/activate/freeze) belongs to the BVCC admin
 * wallet, not to agents, so it is not exposed here.
 */
export const validatorRegistryAbi = [
  {
    type: "function",
    name: "validators",
    stateMutability: "view",
    inputs: [{ name: "target", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "validate",
    stateMutability: "view",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
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
  // exactOutputSingle — asks the pool for an exact output. Basis of the clean
  // token→ETH batch (no leftover WETH dust). Recipient sits at calldata word 3,
  // same as exactInputSingle (this struct is fully static).
  {
    type: "function",
    name: "exactOutputSingle",
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
          { name: "amountOut", type: "uint256" },
          { name: "amountInMaximum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
  // Multi-hop variants. Their struct holds `bytes path`, so the whole tuple is
  // encoded dynamically and an offset word slides in front: the recipient lands on
  // word 2, NOT word 3. Verified by encoding real calldata — pinning word 3 here
  // would pin the wrong argument.
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "exactOutput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountOut", type: "uint256" },
          { name: "amountInMaximum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
] as const;

/**
 * Uniswap v3 NonfungiblePositionManager (LP) — only the entrypoints the agent LP
 * helpers touch. `increaseLiquidity` is deliberately omitted: unlike the others it
 * has NO `isAuthorizedForToken` check on-chain, so it would let an agent pull the
 * wallet's approved tokens into an attacker-owned tokenId (a recipient-whitelist
 * bypass that can't be bitmap-pinned). The frontend NFPM preset excludes it too.
 * `mint.recipient` is calldata word 9 and `collect.recipient` word 1 — both pinned
 * to the wallet by the on-chain call policy.
 */
export const nfpmAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "decreaseLiquidity",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "burn",
    stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/** Uniswap v3 factory — resolve a pool address to read its current price. */
export const v3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

/** Uniswap v4 StateView — reads a pool's slot0 by poolId (keccak of the PoolKey). */
export const v4StateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

/** Uniswap v4 PositionManager — read a position's pool key and liquidity. */
export const v4PositionManagerReadAbi = [
  {
    type: "function",
    name: "getPoolAndPositionInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
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
      { name: "info", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getPositionLiquidity",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/** Uniswap v3 pool — slot0 carries the current sqrtPriceX96 and tick. */
export const v3PoolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

/**
 * BVCC Agent Wallet **V5** — the reads and the entrypoint whose shape differs from V4
 * (generated from the frozen V5 build). V5 is detected from the wallet's EIP-712
 * domain (`BVCCSmartWalletV5`); see `detectWalletVersion`.
 */
export const agentWalletV5Abi = [
  {
    "type": "function",
    "name": "VALIDATOR_REGISTRY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "executeAsAgent",
    "inputs": [
      {
        "name": "mode",
        "type": "bytes32"
      },
      {
        "name": "executionData",
        "type": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getAgentCallPolicy",
    "inputs": [
      {
        "name": "agent",
        "type": "address"
      },
      {
        "name": "target",
        "type": "address"
      },
      {
        "name": "selector",
        "type": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getAgentPermission",
    "inputs": [
      {
        "name": "agent",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "maxPerTxWei",
            "type": "uint128"
          },
          {
            "name": "dailyLimitWei",
            "type": "uint128"
          },
          {
            "name": "totalBudgetWei",
            "type": "uint128"
          },
          {
            "name": "periodBudgetWei",
            "type": "uint128"
          },
          {
            "name": "periodDuration",
            "type": "uint64"
          },
          {
            "name": "expiry",
            "type": "uint64"
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "allowedTokens",
            "type": "address[]"
          },
          {
            "name": "tokenMaxAmounts",
            "type": "uint128[]"
          },
          {
            "name": "tokenDailyLimits",
            "type": "uint128[]"
          },
          {
            "name": "tokenTotalBudgets",
            "type": "uint128[]"
          },
          {
            "name": "allowedProtocols",
            "type": "address[]"
          },
          {
            "name": "allowedRecipients",
            "type": "address[]"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getAgentSpending",
    "inputs": [
      {
        "name": "agent",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "totalSpentWei",
            "type": "uint128"
          },
          {
            "name": "periodSpentWei",
            "type": "uint128"
          },
          {
            "name": "periodStart",
            "type": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getDailySpent",
    "inputs": [
      {
        "name": "agent",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getTokenSpent",
    "inputs": [
      {
        "name": "agent",
        "type": "address"
      },
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "daily",
        "type": "uint128"
      },
      {
        "name": "total",
        "type": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isTargetBlocked",
    "inputs": [
      {
        "name": "target",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "walletType",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "pure"
  }
] as const;

/** V5 validator registry: `validate` takes the agent and returns the validator's verdict. */
export const validatorRegistryV5Abi = [
  {
    "type": "function",
    "name": "validate",
    "inputs": [
      {
        "name": "agent",
        "type": "address"
      },
      {
        "name": "wallet",
        "type": "address"
      },
      {
        "name": "target",
        "type": "address"
      },
      {
        "name": "value",
        "type": "uint256"
      },
      {
        "name": "data",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "ok",
        "type": "bool"
      },
      {
        "name": "tokensToMeasure",
        "type": "address[]"
      },
      {
        "name": "costs",
        "type": "tuple[]",
        "components": [
          {
            "name": "token",
            "type": "address"
          },
          {
            "name": "amount",
            "type": "uint256"
          }
        ]
      },
      {
        "name": "wantsPostCheck",
        "type": "bool"
      },
      {
        "name": "chargeInflow",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "validators",
    "inputs": [
      {
        "name": "target",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  }
] as const;
