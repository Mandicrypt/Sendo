// Watches every user who has ever interacted with Sendo, and pings them
// on Telegram when their cNGN or cUSD balance goes up — since blockchain
// transfers don't otherwise notify anyone, unlike a real bank or wallet
// app. Runs on a simple interval rather than a real blockchain event
// subscription, which is plenty for a hackathon's worth of users.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { walletForTelegramUser } from './wallet.mjs';
import { getCngnBalance, getCusdBalance } from './celo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKED_USERS_FILE = join(__dirname, '..', 'data', 'tracked-users.json');

// Balances we last saw for each user — resets on restart, which just
// means a restart could re-announce whatever arrived since the last
// check right after startup, not a big deal for a hackathon build.
const lastKnownBalances = new Map();

function loadTrackedUsers() {
  if (!existsSync(TRACKED_USERS_FILE)) return [];
  return JSON.parse(readFileSync(TRACKED_USERS_FILE, 'utf8'));
}

function saveTrackedUsers(users) {
  writeFileSync(TRACKED_USERS_FILE, JSON.stringify(users, null, 2));
}

// Call this whenever a user interacts with the bot at all, so we know to
// start watching their wallet.
export function trackUser(telegramUserId) {
  const users = loadTrackedUsers();
  if (!users.includes(telegramUserId)) {
    users.push(telegramUserId);
    saveTrackedUsers(users);
  }
}

async function checkOneUser(bot, telegramUserId) {
  const account = walletForTelegramUser(telegramUserId);

  let cngn, cusd;
  try {
    [cngn, cusd] = await Promise.all([
      getCngnBalance(account.address),
      getCusdBalance(account.address),
    ]);
  } catch (err) {
    console.error(`Balance check failed for user ${telegramUserId}:`, err.message);
    return;
  }

  const previous = lastKnownBalances.get(telegramUserId);
  lastKnownBalances.set(telegramUserId, { cngn, cusd });

  if (!previous) return; // first check for this user this run — nothing to compare against yet

  if (Number(cngn) > Number(previous.cngn)) {
    const received = (Number(cngn) - Number(previous.cngn)).toFixed(2);
    bot.telegram.sendMessage(telegramUserId, `💰 You received ${received} cNGN. New balance: ${cngn}`).catch(() => {});
  }

  if (Number(cusd) > Number(previous.cusd)) {
    const received = (Number(cusd) - Number(previous.cusd)).toFixed(2);
    bot.telegram
      .sendMessage(telegramUserId, `💰 You received ${received} cUSD. New balance: ${cusd}\n\nWant to convert it to cNGN? Try /topup.`)
      .catch(() => {});
  }
}

export function startBalanceWatcher(bot, intervalMs = 30_000) {
  setInterval(async () => {
    const users = loadTrackedUsers();
    for (const userId of users) {
      await checkOneUser(bot, userId);
    }
  }, intervalMs);

  console.log(`Watching ${loadTrackedUsers().length} user(s) for incoming deposits, every ${intervalMs / 1000}s.`);
}
