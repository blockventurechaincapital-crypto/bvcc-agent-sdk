import { isAddress, type Address } from "viem";

/** A known token. Decimals matter — note Binance-Peg stables are 18 on BNB Chain. */
export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** Result of resolving a symbol-or-address. `symbol`/`decimals` are null if unknown. */
export interface ResolvedToken {
  address: Address;
  symbol: string | null;
  decimals: number | null;
}

/**
 * Minimal, verified token registry per chain. Addresses are canonical and
 * deliberately conservative — only well-known tokens are listed. Extend by
 * passing addresses directly to `resolveToken`. No invented addresses.
 */
export const TOKENS: Record<number, Record<string, TokenInfo>> = {
  // Arbitrum One
  42161: {
    WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18 },
    USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
    USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
    DAI: { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI", decimals: 18 },
    WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC", decimals: 8 },
  },
  // Ethereum
  1: {
    WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
    WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
  },
  // Base
  8453: {
    WETH: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
    DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  },
  // BNB Chain — Binance-Peg stables are 18 decimals.
  56: {
    WBNB: { address: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", decimals: 18 },
    WETH: { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "WETH", decimals: 18 },
    USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", decimals: 18 },
    USDT: { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
    DAI: { address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", symbol: "DAI", decimals: 18 },
  },
  // Arbitrum Sepolia (testnet) — only WETH is verified.
  421614: {
    WETH: { address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", symbol: "WETH", decimals: 18 },
  },
};

/**
 * Resolve a symbol (e.g. "USDC") or an address to a token. Addresses pass
 * through (with known metadata filled in when recognized). Unknown symbols throw
 * — pass the address instead.
 */
export function resolveToken(chainId: number, symbolOrAddress: string): ResolvedToken {
  const table = TOKENS[chainId] ?? {};

  if (isAddress(symbolOrAddress)) {
    const lower = symbolOrAddress.toLowerCase();
    for (const t of Object.values(table)) {
      if (t.address.toLowerCase() === lower) return { ...t };
    }
    return { address: symbolOrAddress as Address, symbol: null, decimals: null };
  }

  const t = table[symbolOrAddress.toUpperCase()];
  if (!t) {
    const known = Object.keys(table).join(", ") || "none";
    throw new Error(
      `Unknown token symbol "${symbolOrAddress}" on chain ${chainId}. ` +
        `Known: ${known}. Pass an address instead.`,
    );
  }
  return { ...t };
}
