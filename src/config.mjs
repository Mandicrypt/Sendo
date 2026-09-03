// All addresses verified against docs.celo.org and the erc-8004-contracts
// repo as of Sept 2026. Re-verify against a block explorer before relying
// on these for anything beyond the hackathon.

export const RPC_URL = 'https://forno.celo.org'; // Celo mainnet, free public RPC
export const CHAIN_ID = 42220; // Celo mainnet

// cNGN — Naira-backed stablecoin, issued by Africa Stablecoin Consortium
export const CNGN_TOKEN_ADDRESS = '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f';

// Governance-controlled directory of tokens that can pay gas.
// We check this live at runtime rather than assuming cNGN is on it —
// it may or may not be allowlisted for fee abstraction specifically,
// even though it's a normal transferable token either way.
export const FEE_CURRENCY_DIRECTORY_ADDRESS = '0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276';

// cUSD — fallback fee currency if cNGN isn't on the allowlist.
// Confirmed allowlisted for gas since Celo's L1 days.
export const CUSD_TOKEN_ADDRESS = '0x765DE816845861e75A25fCA122bb6898B8B1282a';

// ERC-8004 Identity Registry — Sendo's own on-chain agent identity.
export const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const SENDO_AGENT_ID = 9810;

export const HACKATHON_ATTRIBUTION_TAG = process.env.HACKATHON_ATTRIBUTION_TAG || '';

// Sendo's own treasury wallet is derived the same way user wallets are —
// via a fixed, reserved "user ID" that no real Telegram account can have.
// This is where cNGN lands when a user pays for airtime, before Sendo
// fulfills the purchase through VTpass using its own Naira balance.
export const TREASURY_WALLET_ID = 'sendo-treasury-v1';

// Minimal ERC-20 ABI — just what we need for transfers and balance checks.
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
