/**
 * Network registry for BVCC Agent Wallets.
 *
 * Factories are deployed deterministically (CREATE2) so they share the SAME
 * address on every chain. A user's Agent Wallet address is derived from their
 * WebAuthn public key — there is no database; the chain is the database.
 */

export interface BvccNetwork {
  chainId: number;
  name: string;
  /** Default public RPC. Override via the client `rpcUrl` option for production. */
  rpcUrl: string;
  /** BVCCAgentWalletFactoryV2 (same address on every chain — CREATE2). */
  agentFactory: `0x${string}`;
  /** BVCCSmartWalletFactoryV2. */
  smartWalletFactory: `0x${string}`;
  /** ERC-4337 EntryPoint (OZ v0.9). */
  entryPoint: `0x${string}`;
  /** Native currency symbol. */
  currency: string;
  /** Block explorer base URL. */
  explorer: string;
  /**
   * Uniswap v3 SwapRouter02, when known. Required only for the v3 swap helper.
   * The router must also be in the agent's `allowedProtocols` whitelist on-chain.
   */
  swapRouter02?: `0x${string}`;
  /**
   * Uniswap Universal Router, when known. Required only for the Universal Router
   * swap helper. Must be in `allowedProtocols`. Only set where verified — pass
   * `{ router }` explicitly on other chains.
   */
  universalRouter?: `0x${string}`;
  /** Wrapped native token (WETH/WBNB) — needed for native wrap/unwrap swaps. */
  weth?: `0x${string}`;
  /** Uniswap v3 QuoterV2 (read-only quoting), where verified. */
  quoterV2?: `0x${string}`;
  /** Uniswap v4 Quoter (read-only quoting), where verified. */
  v4Quoter?: `0x${string}`;
}

/** CREATE2 — identical on every deployed chain. */
const AGENT_FACTORY = "0x8D9e24022777173AD6336e00884b6C87c7EF054c" as const;
const SMART_FACTORY = "0x230b7010529AB6977Dd8581B3eF018ef865BdEf1" as const;
const ENTRY_POINT = "0x433709009B8330FDa32311DF1C2AFA402eD8D009" as const;

export const NETWORKS: Record<number, BvccNetwork> = {
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    agentFactory: AGENT_FACTORY,
    smartWalletFactory: SMART_FACTORY,
    entryPoint: ENTRY_POINT,
    currency: "ETH",
    explorer: "https://arbiscan.io",
    // Uniswap canonical SwapRouter02 on Arbitrum One.
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    // Same Universal Router the BVCC frontend uses / whitelists on Arbitrum.
    universalRouter: "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v4Quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
  },
  56: {
    chainId: 56,
    name: "BNB Chain",
    rpcUrl: "https://bsc-dataseed.binance.org",
    agentFactory: AGENT_FACTORY,
    smartWalletFactory: SMART_FACTORY,
    entryPoint: ENTRY_POINT,
    currency: "BNB",
    explorer: "https://bscscan.com",
    swapRouter02: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    weth: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
  },
  1: {
    chainId: 1,
    name: "Ethereum",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    agentFactory: AGENT_FACTORY,
    smartWalletFactory: SMART_FACTORY,
    entryPoint: ENTRY_POINT,
    currency: "ETH",
    explorer: "https://etherscan.io",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    // universalRouter intentionally unset on Ethereum — pass { router } explicitly
    // (a wrong UR address would lose funds via the transfer-to-router pattern).
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    agentFactory: AGENT_FACTORY,
    smartWalletFactory: SMART_FACTORY,
    entryPoint: ENTRY_POINT,
    currency: "ETH",
    explorer: "https://basescan.org",
    swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    // universalRouter intentionally unset on Base — pass { router } explicitly.
    weth: "0x4200000000000000000000000000000000000006",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  },
  421614: {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    agentFactory: AGENT_FACTORY,
    smartWalletFactory: SMART_FACTORY,
    entryPoint: ENTRY_POINT,
    currency: "ETH",
    explorer: "https://sepolia.arbiscan.io",
    swapRouter02: "0x101F443B4d1b059569D643917553c771E1b9663E",
    weth: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    quoterV2: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B",
  },
};

export function getNetwork(chainId: number): BvccNetwork {
  const n = NETWORKS[chainId];
  if (!n) {
    const known = Object.keys(NETWORKS).join(", ");
    throw new Error(
      `Unknown chainId ${chainId}. Known BVCC networks: ${known}. ` +
        `Pass a full BvccNetwork object to the client instead.`,
    );
  }
  return n;
}
