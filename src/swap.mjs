// Auto-converts a user's deposited stablecoin (USDT, USDC, or cUSD —
// whichever they actually sent) into cNGN, keeping a small reserve of
// that same stablecoin behind for future transaction fees. Checks both
// Uniswap V3 and Ubeswap (V2) for real liquidity, since different pairs
// have ended up on different DEXs — cNGN/USDT liquidity was found on
// Uniswap V3, but that pool doesn't include cUSD or USDC at all, so this
// checks Ubeswap too rather than assuming one DEX has everything.
//
// This calls the DEX's own existing router directly on the user's
// behalf — Sendo already controls the wallet's private key (see WALLET
// SECURITY note in wallet.mjs), so no separate contract needs deploying.

import { createWalletClient, http, parseUnits, formatUnits, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem';
import { celo } from 'viem/chains';
import {
  RPC_URL,
  CNGN_TOKEN_ADDRESS,
  CUSD_TOKEN_ADDRESS,
  USDT_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
  USDC_FEE_ADAPTER_ADDRESS,
  USDT_FEE_ADAPTER_ADDRESS,
  UBESWAP_V2_FACTORY_ADDRESS,
  UBESWAP_V2_ROUTER_ADDRESS,
  ERC20_ABI,
  FEE_CURRENCY_DIRECTORY_ADDRESS,
  FEE_CURRENCY_DIRECTORY_ABI,
} from './config.mjs';
import { publicClient } from './celo.mjs';
import { withGasRetry } from './errors.mjs';

const UNISWAP_V3_FACTORY = '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc';
const UNISWAP_V3_ROUTER = '0x5615CDAb10dc425a742d643d949a7F474C01abc4';
const UNISWAP_V3_QUOTER = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8';

// Direct single-hop swaps through the plain SwapRouter02 (exactInputSingle)
// were found to fail with "STF" for the USDT/cNGN pool specifically, even
// though the pool itself is healthy — Uniswap's own website swaps this
// exact pair successfully, but through their Universal Router + Permit2
// stack instead. This uses that same path rather than SwapRouter02 for
// single-hop swaps.
//
// Address confirmed via two independent sources: Uniswap's own
// @uniswap/universal-router-sdk package (routerConfigs[42220][V2_1_1]),
// and a real successful transaction on this exact pool that hit this
// exact address. Celo's own docs page was listing the PREVIOUS version
// (V2.0, at 0xcb695bc5...) — that's what caused the earlier failure.
const UNIVERSAL_ROUTER_ADDRESS = '0x8B844f885672f333Bc0042cB669255f93a4C1E6b';
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const V3_SWAP_EXACT_IN_COMMAND = '0x00';
const UNIVERSAL_ROUTER_DEADLINE_SECONDS = 60 * 20; // 20 minutes

// Stablecoins /topup will look for, in priority order — checked against
// whichever one the user actually has a meaningful balance of.
// feeCurrencyAddress is what goes in the transaction's feeCurrency field:
// USDT/USDC need their special adapter address, not their plain token
// address, since they use 6 decimals instead of Celo's native 18.
const STABLE_CANDIDATES = [
  { symbol: 'USDT', address: USDT_TOKEN_ADDRESS, feeCurrencyAddress: USDT_FEE_ADAPTER_ADDRESS },
  { symbol: 'USDC', address: USDC_TOKEN_ADDRESS, feeCurrencyAddress: USDC_FEE_ADAPTER_ADDRESS },
  { symbol: 'cUSD', address: CUSD_TOKEN_ADDRESS, feeCurrencyAddress: CUSD_TOKEN_ADDRESS },
];

const DUST_THRESHOLD = 0.1; // ignore balances below this many whole tokens

// How much of the deposited stablecoin to keep behind for future gas.
// Real Celo gas costs are tiny (roughly 0.0001-0.001 per transaction) —
// this is a comfortable buffer for many future transactions, not a
// reflection of what gas actually costs.
const TOPUP_GAS_RESERVE = '0.2';

// Uniswap V3's actual MIN/MAX sqrt price ratio constants (from TickMath.sol).
// Passing plain 0 for sqrtPriceLimitX96 is a common mistake — it only
// happens to work for ONE of the two swap directions. For the other
// direction, the pool's own safety check requires the limit to be
// strictly greater than MIN_SQRT_RATIO, and 0 fails that, reverting
// with "SPL". Always compute the correct one instead of guessing.
const MIN_SQRT_RATIO_PLUS_ONE = 4295128740n;
const MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341n;

// Uniswap V3 pools always order their two tokens by address — the lower
// address is "token0". Swapping token0 for token1 ("zeroForOne") needs
// the MIN-side limit; the reverse needs the MAX-side limit.
function sqrtPriceLimitFor(tokenIn, tokenOut) {
  const zeroForOne = tokenIn.toLowerCase() < tokenOut.toLowerCase();
  return zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
}
const SLIPPAGE_TOLERANCE = 0.02; // 2%
const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000];
const V2_SWAP_DEADLINE_SECONDS = 60 * 10; // 10 minutes from execution

const UNISWAP_FACTORY_ABI = [
  {
    name: 'getPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
];

const UNISWAP_QUOTER_ABI = [
  {
    // Celo's Quoter address is actually QuoterV2, not the older "Quoter"
    // contract most chains use at similar addresses — QuoterV2 takes one
    // struct argument (with a different field order: amountIn before fee)
    // instead of five separate arguments, and returns four values instead
    // of one. Calling it with the wrong shape doesn't error clearly — it
    // just reverts, since the function selector doesn't match anything.
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    // Multi-hop version — path is the packed-encoded sequence of
    // token/fee/token/fee/token, same format Uniswap's own UI produces.
    // This signature is unchanged between Quoter and QuoterV2 — only
    // the single-hop version differs.
    name: 'quoteExactInput',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

const UNISWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    // Multi-hop version — no deadline field, matching SwapRouter02's
    // interface (confirmed by the working single-hop call above, which
    // also has no deadline field).
    name: 'exactInput',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

// Standard Uniswap V2 Router02 interface — Ubeswap is a direct fork, so
// this interface is unchanged from the original.
const V2_FACTORY_ABI = [
  {
    name: 'getPair',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    outputs: [{ name: 'pair', type: 'address' }],
  },
];

const V2_ROUTER_ABI = [
  {
    name: 'getAmountsOut',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    name: 'swapExactTokensForTokens',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
];

// Permit2's own on-chain approve — separate from the standard ERC20
// approve. This grants a specific spender (the Universal Router) an
// allowance inside Permit2's own ledger, with an expiration timestamp.
const PERMIT2_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
];

// Universal Router's command-based execute function — verified against
// Uniswap's own universal-router GitHub source. Commands are packed as
// single bytes; each command's parameters are ABI-encoded separately
// into the matching entry of the inputs array.
const UNIVERSAL_ROUTER_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
];

let cachedAllowlistedFeeCurrencies = null;

// Builds Uniswap's packed path format for a 2-hop swap: tokenIn, then the
// fee tier for hop 1, then the bridge token, then the fee tier for hop 2,
// then the final token. Same format Uniswap's own frontend produces.
function buildTwoHopPath(tokenIn, fee1, bridgeToken, fee2, tokenOut) {
  return encodePacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [tokenIn, fee1, bridgeToken, fee2, tokenOut]
  );
}

async function getAllowlistedFeeCurrencies() {
  if (cachedAllowlistedFeeCurrencies) return cachedAllowlistedFeeCurrencies;
  const list = await publicClient.readContract({
    address: FEE_CURRENCY_DIRECTORY_ADDRESS,
    abi: FEE_CURRENCY_DIRECTORY_ABI,
    functionName: 'getCurrencies',
  });
  cachedAllowlistedFeeCurrencies = list.map((a) => a.toLowerCase());
  return cachedAllowlistedFeeCurrencies;
}

async function findUniswapV3Route(tokenA, tokenB) {
  for (const fee of UNISWAP_FEE_TIERS) {
    const pool = await publicClient.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: UNISWAP_FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenA, tokenB, fee],
    });
    if (pool !== '0x0000000000000000000000000000000000000000') {
      return fee;
    }
  }
  return null;
}

async function findUbeswapV2Route(tokenAddress) {
  const pair = await publicClient.readContract({
    address: UBESWAP_V2_FACTORY_ADDRESS,
    abi: V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [tokenAddress, CNGN_TOKEN_ADDRESS],
  });
  if (pair !== '0x0000000000000000000000000000000000000000') {
    return { dex: 'ubeswap-v2' };
  }
  return null;
}

// Checks, in order: a direct Uniswap pool, a direct Ubeswap pool, and —
// for anything that isn't USDT itself — a 2-hop Uniswap route bridged
// through USDT, since that's where confirmed liquidity exists against
// both cNGN and the major stablecoins.
async function findRoute(tokenAddress) {
  const directFee = await findUniswapV3Route(tokenAddress, CNGN_TOKEN_ADDRESS);
  if (directFee !== null) return { dex: 'universal-router', fee: directFee };

  const ubeswapRoute = await findUbeswapV2Route(tokenAddress);
  if (ubeswapRoute) return ubeswapRoute;

  if (tokenAddress.toLowerCase() !== USDT_TOKEN_ADDRESS.toLowerCase()) {
    const feeToUsdt = await findUniswapV3Route(tokenAddress, USDT_TOKEN_ADDRESS);
    const feeUsdtToCngn = await findUniswapV3Route(USDT_TOKEN_ADDRESS, CNGN_TOKEN_ADDRESS);
    if (feeToUsdt !== null && feeUsdtToCngn !== null) {
      return { dex: 'uniswap-v3-2hop', fee1: feeToUsdt, fee2: feeUsdtToCngn };
    }
  }

  return null;
}

// Works out which of the user's stablecoins is actually usable for a
// top-up: it needs a real balance, a real swap route to cNGN on some DEX,
// AND to be able to pay its own gas — otherwise the swap transaction
// itself couldn't be submitted.
async function findUsableStable(walletAddress) {
  const allowlisted = await getAllowlistedFeeCurrencies();
  const attempts = [];

  for (const candidate of STABLE_CANDIDATES) {
    const decimals = await publicClient.readContract({
      address: candidate.address,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    const balanceRaw = await publicClient.readContract({
      address: candidate.address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    });
    const balanceDisplay = Number(formatUnits(balanceRaw, decimals));

    if (balanceDisplay < DUST_THRESHOLD) {
      attempts.push(`${candidate.symbol}: no meaningful balance`);
      continue;
    }

    const route = await findRoute(candidate.address);
    if (!route) {
      attempts.push(`${candidate.symbol}: balance found (${balanceDisplay}), but no direct or USDT-bridged cNGN route exists yet`);
      continue;
    }

    const canPayGas = allowlisted.includes(candidate.feeCurrencyAddress.toLowerCase());
    if (!canPayGas) {
      attempts.push(`${candidate.symbol}: balance and pool found, but it isn't currently approved to pay its own gas`);
      continue;
    }

    return { ...candidate, decimals, balanceRaw, route };
  }

  // Full diagnostic detail goes to the server console for debugging —
  // never shown to the user, who doesn't need to know about DEXs, pools,
  // or fee-currency adapters.
  console.error('No usable stablecoin for /topup. Details:\n' + attempts.join('\n'));

  throw new Error(
    "We couldn't find cUSD, USDT, or USDC in your wallet to convert yet. " +
    'Send one of those in and try again.'
  );
}

// Step 1: figure out how much cNGN a swap would produce right now,
// without moving anything yet — this is what powers the /confirm preview.
export async function quoteTopup(account) {
  const stable = await findUsableStable(account.address);

  const reserve = parseUnits(TOPUP_GAS_RESERVE, stable.decimals);
  if (stable.balanceRaw <= reserve) {
    throw new Error(
      `Your ${stable.symbol} balance isn't enough to swap after keeping ${TOPUP_GAS_RESERVE} ${stable.symbol} in reserve for future fees.`
    );
  }
  const amountToSwap = stable.balanceRaw - reserve;

  let quotedOut;
  if (stable.route.dex === 'universal-router') {
    const [amountOut] = await publicClient.readContract({
      address: UNISWAP_V3_QUOTER,
      abi: UNISWAP_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: stable.address,
          tokenOut: CNGN_TOKEN_ADDRESS,
          amountIn: amountToSwap,
          fee: stable.route.fee,
          sqrtPriceLimitX96: sqrtPriceLimitFor(stable.address, CNGN_TOKEN_ADDRESS),
        },
      ],
    });
    quotedOut = amountOut;
  } else if (stable.route.dex === 'uniswap-v3-2hop') {
    const path = buildTwoHopPath(
      stable.address,
      stable.route.fee1,
      USDT_TOKEN_ADDRESS,
      stable.route.fee2,
      CNGN_TOKEN_ADDRESS
    );
    quotedOut = await publicClient.readContract({
      address: UNISWAP_V3_QUOTER,
      abi: UNISWAP_QUOTER_ABI,
      functionName: 'quoteExactInput',
      args: [path, amountToSwap],
    });
  } else {
    const amounts = await publicClient.readContract({
      address: UBESWAP_V2_ROUTER_ADDRESS,
      abi: V2_ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [amountToSwap, [stable.address, CNGN_TOKEN_ADDRESS]],
    });
    quotedOut = amounts[amounts.length - 1];
  }

  const cngnDecimals = await publicClient.readContract({
    address: CNGN_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });

  return {
    stableSymbol: stable.symbol,
    tokenAddress: stable.address,
    feeCurrencyAddress: stable.feeCurrencyAddress,
    decimals: stable.decimals,
    route: stable.route,
    amountToSwap,
    amountToSwapDisplay: formatUnits(amountToSwap, stable.decimals),
    quotedOut,
    quotedOutDisplay: formatUnits(quotedOut, cngnDecimals),
    reserveDisplay: TOPUP_GAS_RESERVE,
  };
}

// Step 2: actually execute the swap, using the same quote just shown to
// the user — with a minimum-output floor so a price move mid-transaction
// can't silently give them a much worse deal than what they approved.
export async function executeTopup(account, quote) {
  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(RPC_URL),
  });

  const amountOutMinimum =
    (quote.quotedOut * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 10000))) / 10000n;

  // The Universal Router path needs a different, longer approval chain
  // than the others (ERC20 → Permit2 → Universal Router, then the swap
  // itself) — handled entirely separately rather than forcing it into
  // the single-approve pattern the other routes share.
  if (quote.route.dex === 'universal-router') {
    const permit2ApproveHash = await withGasRetry(() =>
      walletClient.writeContract({
        address: quote.tokenAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [PERMIT2_ADDRESS, quote.amountToSwap],
        feeCurrency: quote.feeCurrencyAddress,
      })
    );
    await publicClient.waitForTransactionReceipt({ hash: permit2ApproveHash });

    const expiration = Math.floor(Date.now() / 1000) + UNIVERSAL_ROUTER_DEADLINE_SECONDS;
    const routerApproveHash = await withGasRetry(() =>
      walletClient.writeContract({
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [quote.tokenAddress, UNIVERSAL_ROUTER_ADDRESS, quote.amountToSwap, expiration],
        feeCurrency: quote.feeCurrencyAddress,
      })
    );
    await publicClient.waitForTransactionReceipt({ hash: routerApproveHash });

    const path = encodePacked(
      ['address', 'uint24', 'address'],
      [quote.tokenAddress, quote.route.fee, CNGN_TOKEN_ADDRESS]
    );
    const swapInput = encodeAbiParameters(
      parseAbiParameters('address, uint256, uint256, bytes, bool'),
      [account.address, quote.amountToSwap, amountOutMinimum, path, true]
    );
    const deadline = BigInt(Math.floor(Date.now() / 1000) + UNIVERSAL_ROUTER_DEADLINE_SECONDS);

    const swapHash = await withGasRetry(() =>
      walletClient.writeContract({
        address: UNIVERSAL_ROUTER_ADDRESS,
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: 'execute',
        args: [V3_SWAP_EXACT_IN_COMMAND, [swapInput], deadline],
        feeCurrency: quote.feeCurrencyAddress,
      })
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    return { approveHash: permit2ApproveHash, swapHash, receipt };
  }

  // Uniswap V3 2-hop and Ubeswap V2 both use a single, simple approval
  // directly to their own router — the pattern that's already proven
  // reliable (this is how the successful cUSD 2-hop swap worked).
  const routerAddress = quote.route.dex === 'ubeswap-v2' ? UBESWAP_V2_ROUTER_ADDRESS : UNISWAP_V3_ROUTER;

  const approveHash = await withGasRetry(() =>
    walletClient.writeContract({
      address: quote.tokenAddress,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [routerAddress, quote.amountToSwap],
      feeCurrency: quote.feeCurrencyAddress,
    })
  );
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  let swapHash;
  if (quote.route.dex === 'uniswap-v3-2hop') {
    const path = buildTwoHopPath(
      quote.tokenAddress,
      quote.route.fee1,
      USDT_TOKEN_ADDRESS,
      quote.route.fee2,
      CNGN_TOKEN_ADDRESS
    );
    swapHash = await withGasRetry(() =>
      walletClient.writeContract({
        address: UNISWAP_V3_ROUTER,
        abi: UNISWAP_ROUTER_ABI,
        functionName: 'exactInput',
        args: [
          {
            path,
            recipient: account.address,
            amountIn: quote.amountToSwap,
            amountOutMinimum,
          },
        ],
        feeCurrency: quote.feeCurrencyAddress,
      })
    );
  } else {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + V2_SWAP_DEADLINE_SECONDS);
    swapHash = await withGasRetry(() =>
      walletClient.writeContract({
        address: UBESWAP_V2_ROUTER_ADDRESS,
        abi: V2_ROUTER_ABI,
        functionName: 'swapExactTokensForTokens',
        args: [quote.amountToSwap, amountOutMinimum, [quote.tokenAddress, CNGN_TOKEN_ADDRESS], account.address, deadline],
        feeCurrency: quote.feeCurrencyAddress,
      })
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  return { approveHash, swapHash, receipt };
}
