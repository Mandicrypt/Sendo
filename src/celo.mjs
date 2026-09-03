import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from 'viem';
import { celo } from 'viem/chains';
import {
  RPC_URL,
  CNGN_TOKEN_ADDRESS,
  CUSD_TOKEN_ADDRESS,
  FEE_CURRENCY_DIRECTORY_ADDRESS,
  FEE_CURRENCY_DIRECTORY_ABI,
  ERC20_ABI,
  HACKATHON_ATTRIBUTION_TAG,
} from './config.mjs';

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(RPC_URL),
});

// Cache this per process run rather than checking on every single transfer —
// the allowlist doesn't change mid-hackathon.
let cachedFeeCurrency = null;

async function resolveFeeCurrency() {
  if (cachedFeeCurrency) return cachedFeeCurrency;

  const allowlisted = await publicClient.readContract({
    address: FEE_CURRENCY_DIRECTORY_ADDRESS,
    abi: FEE_CURRENCY_DIRECTORY_ABI,
    functionName: 'getCurrencies',
  });

  const cngnAllowlisted = allowlisted
    .map((a) => a.toLowerCase())
    .includes(CNGN_TOKEN_ADDRESS.toLowerCase());

  if (cngnAllowlisted) {
    cachedFeeCurrency = CNGN_TOKEN_ADDRESS;
    console.log('cNGN is allowlisted for gas — users can pay fees entirely in cNGN.');
  } else {
    cachedFeeCurrency = CUSD_TOKEN_ADDRESS;
    console.log(
      'cNGN is not currently allowlisted as a fee currency — falling back to cUSD for gas. ' +
      'The cNGN value transfer itself is unaffected either way.'
    );
  }

  return cachedFeeCurrency;
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

  const feeCurrency = await resolveFeeCurrency();

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

  const hash = await walletClient.writeContract({
    address: CNGN_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [toAddress, value],
    feeCurrency,
    dataSuffix: attributionSuffix,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return { hash, receipt };
}
