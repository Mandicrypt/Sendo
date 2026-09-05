// All addresses verified against docs.celo.org, celoscan.io, and the
// erc-8004-contracts repo as of Sept 2026. Re-verify against a block
// explorer before relying on these for anything beyond the hackathon.

export const RPC_URL = 'https://forno.celo.org'; // Celo mainnet, free public RPC
export const CHAIN_ID = 42220; // Celo mainnet

// cNGN — Naira-backed stablecoin, issued by Africa Stablecoin Consortium
export const CNGN_TOKEN_ADDRESS = '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f';

// Governance-controlled directory of tokens that can pay gas.
// We check this live at runtime rather than assuming any one token is on
// it — allowlisting can change, and different tokens may or may not
// qualify even if they're perfectly normal, transferable ERC-20s.
export const FEE_CURRENCY_DIRECTORY_ADDRESS = '0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276';

// cUSD — Celo's original stablecoin (18 decimals).
export const CUSD_TOKEN_ADDRESS = '0x765DE816845861e75A25fCA122bb6898B8B1282a';

// USDT — native Tether-issued USDT on Celo (6 decimals). Confirmed real
// Uniswap V3 liquidity against cNGN exists here (0.01% fee tier pool),
// verified directly against the pool contract's token0/token1.
export const USDT_TOKEN_ADDRESS = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';

// USDC — native Circle-issued USDC on Celo (6 decimals).
export const USDC_TOKEN_ADDRESS = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';

// Fee-currency adapters: USDT and USDC use 6 decimals, so Celo requires a
// separate "adapter" contract address (not the plain token address) in
// the feeCurrency field of a transaction. cUSD needs no adapter since it
// already uses 18 decimals. Verified against docs.celo.org.
export const USDC_FEE_ADAPTER_ADDRESS = '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B';
export const USDT_FEE_ADAPTER_ADDRESS = '0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72';

// Ubeswap — Celo's other major DEX (a Uniswap V2 fork). Checked alongside
// Uniswap V3 when looking for a working stablecoin/cNGN swap pool, since
// different pairs have ended up with liquidity on different DEXs.
// Verified against docs.ubeswap.org.
export const UBESWAP_V2_FACTORY_ADDRESS = '0x62d5b84bE28a183aBB507E125B384122D2C25fAE';
export const UBESWAP_V2_ROUTER_ADDRESS = '0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121';

// ERC-8004 Identity Registry — Sendo's own on-chain agent identity.
export const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const SENDO_AGENT_ID = 9810;

export const HACKATHON_ATTRIBUTION_TAG = process.env.HACKATHON_ATTRIBUTION_TAG || '';

// Sendo's own treasury wallet is derived the same way user wallets are —
// via a fixed, reserved "user ID" that no real Telegram account can have.
// This is where cNGN lands when a user pays for airtime or bills, before
// Sendo fulfills the purchase through VTpass using its own Naira balance.
export const TREASURY_WALLET_ID = 'sendo-treasury-v1';

// Minimal ERC-20 ABI — just what we need for transfers, approvals, and
// balance checks.
export const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
];

// Just the one function we need from FeeCurrencyDirectory.
export const FEE_CURRENCY_DIRECTORY_ABI = [
  {
    name: 'getCurrencies',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
];
