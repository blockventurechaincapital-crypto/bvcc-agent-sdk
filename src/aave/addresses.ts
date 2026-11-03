/**
 * Aave v3 addresses per chain.
 *
 * Only chains where the BVCC Agent Wallet supports Aave are listed. Each entry is
 * the Pool plus the read-side contracts (PoolDataProvider, AaveOracle). Every
 * address was resolved on-chain from the market's canonical PoolAddressesProvider
 * (`getPool` / `getPoolDataProvider` / `getPriceOracle`) and the Pool's own
 * `ADDRESSES_PROVIDER()`, so the four addresses per chain are mutually consistent
 * (verified 26 Jul 2026 across Arbitrum, Ethereum, BNB, Base, Polygon).
 *
 * The SDK does a `getPool()` sanity check at first use (see `resolveAave`) so a
 * stale address surfaces immediately instead of sending funds to the wrong Pool.
 */
import type { Address } from "viem";

export interface AaveAddresses {
  pool: Address;
  poolAddressesProvider: Address;
  poolDataProvider: Address;
  oracle: Address;
}

export const AAVE: Record<number, AaveAddresses> = {
  // Arbitrum One — Aave v3 Core market.
  42161: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    poolDataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    oracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
  },
  // Ethereum — Aave v3 Core market.
  1: {
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    poolAddressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    poolDataProvider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
    oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
  },
  // BNB Chain — Aave v3 market.
  56: {
    pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
    poolAddressesProvider: "0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D",
    poolDataProvider: "0xc90Df74A7c16245c5F5C5870327Ceb38Fe5d5328",
    oracle: "0x39bc1bfDa2130d6Bb6DBEfd366939b4c7aa7C697",
  },
  // Base — Aave v3 market.
  8453: {
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    poolAddressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    poolDataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
    oracle: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
  },
  // Polygon — Aave v3 market (Pool/provider/dataProvider share Arbitrum's CREATE2
  // addresses; the oracle differs).
  137: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    poolAddressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    poolDataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
    oracle: "0xb023e699F5a33916Ea823A16485e259257cA8Bd1",
  },
  // Arbitrum Sepolia (testnet) — Aave v3 market, resolved on-chain from the Pool's
  // ADDRESSES_PROVIDER (2 Nov 2026).
  421614: {
    pool: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
    poolAddressesProvider: "0xB25a5D144626a0D488e52AE717A051a2E9997076",
    poolDataProvider: "0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01",
    oracle: "0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00",
  },
};

/** Aave addresses for a chain, or undefined if the SDK has no Aave support there. */
export function getAaveAddresses(chainId: number): AaveAddresses | undefined {
  return AAVE[chainId];
}
