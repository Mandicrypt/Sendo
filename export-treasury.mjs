// Prints the treasury wallet's private key directly to your terminal —
// deliberately NOT a bot command, since this key is worth more than any
// single user's (it holds everyone's accumulated airtime/bill payments)
// and shouldn't ever pass through Telegram's chat history.
//
// Run this locally: node export-treasury.mjs
// Requires your local .env to have the same WALLET_MASTER_SEED that's
// set in Railway's environment variables — if they don't match, this
// will print the WRONG key for a wallet that doesn't hold your funds.

import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import { exportPrivateKeyForTelegramUser } from './src/wallet.mjs';
import { TREASURY_WALLET_ID } from './src/config.mjs';

const privateKey = exportPrivateKeyForTelegramUser(TREASURY_WALLET_ID);
const account = privateKeyToAccount(privateKey);

console.log('\n⚠️  TREASURY WALLET — handle this like the master key to your business funds.\n');
console.log('Address:', account.address);
console.log('Private key:', privateKey);
console.log('\nImport the private key into MetaMask/Rabby under "Import Account."');
console.log('Once saved somewhere secure, clear your terminal (type: clear) and close this window.\n');
