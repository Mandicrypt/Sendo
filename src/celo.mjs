import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from 'viem';
import { celo } from 'viem/chains';
import {
  RPC_URL,
  CNGN_TOKEN_ADDRESS,
  CUSD_TOKEN_ADDRESS,
  USDT_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
  USDC_FEE_ADAPTER_ADDRESS,
  USDT_FEE_ADAPTER_ADDRESS,
  FEE_CURRENCY_DIRECTORY_ADDRESS,
  FEE_CURRENCY_DIRECTORY_ABI,
  ERC20_ABI,
  HACKATHON_ATTRIBUTION_TAG,
} from './config.mjs';
import { withGasRetry } from './errors.mjs';

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(RPC_URL),
});

// Cache the allowlist itself — that doesn't change mid-hackathon — but
// NOT the choice of currency, since that depends on what a specific
// wallet actually holds, which varies user to user.
let cachedAllowlist = null;

async function getAllowlist() {
  if (cachedAllowlist) return cachedAllowlist;
  const list = await publicClient.readContract({
    address: FEE_CURRENCY_DIRECTORY_ADDRESS,
    abi: FEE_CURRENCY_DIRECTORY_ABI,
    functionName: 'getCurrencies',
  });
  cachedAllowlist = list.map((a) => a.toLowerCase());
  return cachedAllowlist;
}

// A wallet might hold any mix of cUSD, USDT, or USDC — this picks
// whichever one it actually has enough of to cover gas, rather than
// assuming cUSD specifically. USDT/USDC use their special adapter
// address in feeCurrency (see config.mjs), not their plain token address.
const GAS_CANDIDATES = [
  { symbol: 'cUSD', tokenAddress: CUSD_TOKEN_ADDRESS, feeCurrencyAddress: CUSD_TOKEN_ADDRESS, decimals: 18 },
  { symbol: 'USDT', tokenAddress: USDT_TOKEN_ADDRESS, feeCurrencyAddress: USDT_FEE_ADAPTER_ADDRESS, decimals: 6 },
  { symbol: 'USDC', tokenAddress: USDC_TOKEN_ADDRESS, feeCurrencyAddress: USDC_FEE_ADAPTER_ADDRESS, decimals: 6 },
];

// Small buffer to confirm there's enough for gas — not exact, just a
// sensible floor well above what one transaction actually costs.
const MIN_GAS_BUFFER = 0.05;

async function resolveFeeCurrency(walletAddress) {
  const allowlisted = await getAllowlist();

  if (allowlisted.includes(CNGN_TOKEN_ADDRESS.toLowerCase())) {
    return CNGN_TOKEN_ADDRESS;
  }

  for (const candidate of GAS_CANDIDATES) {
    if (!allowlisted.includes(candidate.feeCurrencyAddress.toLowerCase())) continue;

    const balanceRaw = await publicClient.readContract({
      address: candidate.tokenAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    });
    const balanceDisplay = Number(formatUnits(balanceRaw, candidate.decimals));

    if (balanceDisplay >= MIN_GAS_BUFFER) {
      return candidate.feeCurrencyAddress;
    }
  }

  throw new Error(
    "This wallet doesn't have enough of any supported currency (cUSD, USDT, or USDC) to cover transaction fees yet. " +
    'Deposit a small amount of one of these first.'
  );
}

export async function getCngnBalance(address) {
  const raw = await publicClient.readContract({
    address: CNGN_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
  const decimals = await publicClient.readContract({
    address: CNGN_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
  return formatUnits(raw, decimals);
}

export async function getCusdBalance(address) {
  const raw = await publicClient.readContract({
    address: CUSD_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
  return formatUnits(raw, 18); // cUSD always uses 18 decimals
}

// Checks all three stables /topup can convert from, so /balance and the
// notification watcher can show a complete picture instead of just cUSD.
export async function getStableBalances(address) {
  const stables = [
    { symbol: 'USDT', address: USDT_TOKEN_ADDRESS, decimals: 6 },
    { symbol: 'cUSD', address: CUSD_TOKEN_ADDRESS, decimals: 18 },
    { symbol: 'USDC', address: USDC_TOKEN_ADDRESS, decimals: 6 },
  ];

  const balances = await Promise.all(
    stables.map(async (stable) => {
      const raw = await publicClient.readContract({
        address: stable.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      });
      return { symbol: stable.symbol, balance: formatUnits(raw, stable.decimals) };
    })
  );

  return balances;
}

// Sends cNGN from one Sendo-managed wallet to any address, paying gas via
// fee abstraction (so the sender never needs to hold CELO), and appending
// the hackathon attribution tag to the transaction calldata so it counts
// on the leaderboard.
export async function sendCngn({ account, toAddress, amount }) {
  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(RPC_URL),
  });

  const feeCurrency = await resolveFeeCurrency(account.address);

  const decimals = await publicClient.readContract({
    address: CNGN_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
  const value = parseUnits(String(amount), decimals);

  // Attribution tag goes in calldata as a suffix, per the hackathon's
  // toDataSuffix convention — it has to be present on the transaction
  // that's actually sent, since there's no way to add it after the fact.
  const attributionSuffix = HACKATHON_ATTRIBUTION_TAG
    ? `0x${Buffer.from(HACKATHON_ATTRIBUTION_TAG, 'utf8').toString('hex')}`
    : '0x';

  const hash = await withGasRetry(() =>
    walletClient.writeContract({
      address: CNGN_TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [toAddress, value],
      feeCurrency,
      dataSuffix: attributionSuffix,
    })
  );

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return { hash, receipt };
}
