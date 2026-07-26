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
  /**
   * BVCCValidatorRegistry — only on chains where wallet V3 is deployed.
   *
   * V3 wallets compile this address in as a constant, so it is the same on every
   * chain by CREATE2; it is listed per-network anyway because a chain still on V2
   * has no registry at all, and `undefined` is what tells the SDK to skip every
   * DEEP-policy check there.
   */
  validatorRegistry?: `0x${string}`;
  /**
   * Uniswap v3 NonfungiblePositionManager (LP), when known. Required only for the
   * v3 liquidity helpers. Must be in the agent's `allowedProtocols`, with the call
   * policies from the frontend NFPM preset registered (mint/collect pin the
   * recipient to the wallet; increaseLiquidity is intentionally NOT exposed).
   */
  nfpm?: `0x${string}`;
  /**
   * Uniswap v3 factory. Used only to read a pool's current price when sizing an
   * LP mint, so the two deposit amounts are matched to the pool ratio (and the
   * amount minimums hold). Same canonical address on most chains.
   */
  v3Factory?: `0x${string}`;
  /**
   * Uniswap v4 PositionManager (LP), when known. Required only for the v4 liquidity
   * helpers (native-ETH LP). Must be in `allowedProtocols` with a DEEP_VALIDATION
   * policy backed by the BVCCPositionManagerValidator (registered via 48h governance)
   * — until then, agent v4 LP fails closed.
   */
  positionManagerV4?: `0x${string}`;
  /**
   * Uniswap v4 StateView — reads a pool's slot0 (current price) by poolId, to size
   * a v4 mint to the pool ratio. Only needed alongside `positionManagerV4`.
   */
  v4StateView?: `0x${string}`;
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
    // Uniswap's canonical v4 Universal Router on Arbitrum (the one listed in the
    // official v4 deployments docs). The UR validator is bound to exactly this
    // address; the frontend policy preset + capability compose use the same one.
    universalRouter: "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v4Quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
    // BVCCValidatorRegistry — same CREATE2 address on every chain. Now set on all five
    // mainnets locally (V3 config staged, UR validators registered); VPS/prod still V2.
    validatorRegistry: "0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2",
    // Uniswap v3 NonfungiblePositionManager (verified on-chain).
    nfpm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    // Uniswap v3 factory (pool-price reads for LP sizing).
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    // Uniswap v4 PositionManager + StateView (native LP; DEEP validator).
    positionManagerV4: "0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869",
    v4StateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
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
    // Uniswap's canonical v4 Universal Router on BNB Chain (official v4 docs). Its UR
    // validator is registered in the registry (0x6945…D815), bound to this exact address.
    universalRouter: "0x1906c1d672b88cD1B9aC7593301cA990F94Eae07",
    weth: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    validatorRegistry: "0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2",
    // Uniswap v3 NonfungiblePositionManager (verified on-chain).
    nfpm: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
    // Uniswap v3 factory (pool-price reads for LP sizing).
    v3Factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    // Uniswap v4 PositionManager + StateView (native LP; DEEP validator).
    positionManagerV4: "0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b",
    v4StateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
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
    // Uniswap's canonical v4 Universal Router on Ethereum (official v4 docs). Its UR
    // validator is registered in the registry (0x3615…2ffb), bound to this exact address.
    universalRouter: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    validatorRegistry: "0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2",
    // Uniswap v3 NonfungiblePositionManager (verified on-chain).
    nfpm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    // Uniswap v3 factory (pool-price reads for LP sizing).
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    // Uniswap v4 PositionManager + StateView (native LP; DEEP validator).
    positionManagerV4: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
    v4StateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
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
    // Uniswap's canonical v4 Universal Router on Base (official v4 docs). Its UR
    // validator is registered in the registry (0x4A2F…A6D8), bound to this exact address.
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    weth: "0x4200000000000000000000000000000000000006",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    validatorRegistry: "0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2",
    // Uniswap v3 NonfungiblePositionManager (verified on-chain).
    nfpm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    // Uniswap v3 factory (pool-price reads for LP sizing).
    v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    // Uniswap v4 PositionManager + StateView (native LP; DEEP validator).
    positionManagerV4: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
    v4StateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  },
  137: {
    chainId: 137,
    name: "Polygon",
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    agentFactory: AGENT_FACTORY,
    smartWalletFactory: SMART_FACTORY,
    entryPoint: ENTRY_POINT,
    currency: "POL",
    explorer: "https://polygonscan.com",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    // Uniswap's canonical v4 Universal Router on Polygon (official v4 docs). Its UR
    // validator is registered in the registry (0xC1C5…02fF), bound to this exact address.
    universalRouter: "0x1095692A6237d83C6a72F3F5eFEdb9A670C49223",
    weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WPOL (wrapped native POL)
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    validatorRegistry: "0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2",
    // Uniswap v3 NonfungiblePositionManager (verified on-chain).
    nfpm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    // Uniswap v3 factory (pool-price reads for LP sizing).
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    // Uniswap v4 PositionManager + StateView (native LP; DEEP validator).
    positionManagerV4: "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9",
    v4StateView: "0x5eA1bD7974c8A611cBAB0bDCAFcB1D9CC9b3BA5a",
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
    // Uniswap's canonical v4 Universal Router on Arbitrum Sepolia (official v4 docs).
    // Its UR validator is registered in the registry (0x8755…d86E), bound to this address.
    universalRouter: "0xeFd1D4bD4cf1e86Da286BB4CB1B8BcED9C10BA47",
    weth: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    quoterV2: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B",
    validatorRegistry: "0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2",
    // Uniswap v3 NonfungiblePositionManager (verified on-chain).
    nfpm: "0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65",
    // Uniswap v3 factory (pool-price reads for LP sizing).
    v3Factory: "0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e",
    // Uniswap v4 PositionManager + StateView (native LP; DEEP validator).
    positionManagerV4: "0xAc631556d3d4019C95769033B5E719dD77124BAc",
    v4StateView: "0x9D467FA9062b6e9B1a46E26007aD82db116c67cB",
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
