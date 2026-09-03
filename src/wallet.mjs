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

export function walletForTelegramUser(telegramUserId) {
  const seed = process.env.WALLET_MASTER_SEED;
  if (!seed) {
    throw new Error('WALLET_MASTER_SEED is not set — check your .env file.');
  }

  const derivedKey = createHmac('sha256', seed)
    .update(String(telegramUserId))
    .digest('hex');

  const privateKey = `0x${derivedKey}`;
  return privateKeyToAccount(privateKey);
}
