// WALLET SECURITY NOTE (read before using this beyond the hackathon):
//
// This derives a private key per Telegram user from a single master seed
// using HMAC-SHA256(masterSeed, telegramUserId). That means:
//   - No private keys are ever written to disk — they're recomputed
//     on demand from the seed + user ID, then discarded from memory.
//   - Anyone who obtains WALLET_MASTER_SEED can derive every user's
//     wallet. Treat that env var like a bank vault key: never commit it,
//     never log it, never put it anywhere but your local .env.
//   - This is a custodial model — Sendo controls user funds, not the
//     users themselves. That's a real product/regulatory decision, not
//     just a technical one. Fine for a hackathon demo; worth revisiting
//     before anyone puts real money through this for real.

import { createHmac } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

function derivePrivateKey(telegramUserId) {
  const seed = process.env.WALLET_MASTER_SEED;
  if (!seed) {
    throw new Error('WALLET_MASTER_SEED is not set — check your .env file.');
  }

  const derivedKey = createHmac('sha256', seed)
    .update(String(telegramUserId))
    .digest('hex');

  return `0x${derivedKey}`;
}

export function walletForTelegramUser(telegramUserId) {
  return privateKeyToAccount(derivePrivateKey(telegramUserId));
}

// Returns the raw private key so a user can import their Sendo wallet
// into a normal wallet app (MetaMask, Rabby, etc.) and move funds out —
// including tokens Sendo itself doesn't have a command for, like sending
// cUSD or USDC directly. This is what makes the custodial model honest:
// users aren't locked in, they can always leave with everything that's
// theirs. Only ever call this from a flow the user explicitly confirmed —
// see /exportwallet in bot.mjs.
export function exportPrivateKeyForTelegramUser(telegramUserId) {
  return derivePrivateKey(telegramUserId);
}
