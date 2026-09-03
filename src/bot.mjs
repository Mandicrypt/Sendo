import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { walletForTelegramUser } from './wallet.mjs';
import { getCngnBalance, sendCngn } from './celo.mjs';
import { buyAirtime, verifyMeter, payElectricity } from './vtpass.mjs';
import { TREASURY_WALLET_ID } from './config.mjs';
import { setUsername, resolveUsername, getUsernameFor } from './usernames.mjs';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('Set TELEGRAM_BOT_TOKEN in your .env file — get one from @BotFather.');
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Every money-moving command builds an "action" here instead of running
// immediately. Nothing actually happens until the user sends /confirm.
// Keyed per Telegram user, one pending action at a time, expires after a
// few minutes so a stale, forgotten confirmation can't fire by surprise.
const pendingActions = new Map();
const CONFIRMATION_WINDOW_MS = 2 * 60 * 1000;

function setPending(telegramUserId, action) {
  pendingActions.set(telegramUserId, { ...action, expiresAt: Date.now() + CONFIRMATION_WINDOW_MS });
}

function getPending(telegramUserId) {
  const pending = pendingActions.get(telegramUserId);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    pendingActions.delete(telegramUserId);
    return null;
  }
  return pending;
}

// Resolves a recipient the user typed — either a raw 0x address or an
// @username registered via /setusername — into an actual address.
function resolveRecipient(target) {
  if (target.startsWith('0x')) {
    return { address: target, label: target };
  }
  const ownerTelegramId = resolveUsername(target);
  if (!ownerTelegramId) {
    return null;
  }
  const account = walletForTelegramUser(ownerTelegramId);
  return { address: account.address, label: '@' + target.replace(/^@/, '') };
}

bot.start((ctx) => {
  ctx.reply(
    "Welcome to Sendo — send and receive cNGN right here in Telegram, no CELO required for gas.\n\n" +
    'Commands:\n' +
    '/wallet — see your Sendo wallet address\n' +
    '/balance — check your cNGN balance\n' +
    '/setusername <name> — pick a username so others can send to you by name\n' +
    '/send <address or @username> <amount> — send cNGN\n' +
    '/airtime <network> <phone> <amount> — top up airtime (mtn, glo, airtel, 9mobile)\n' +
    '/bill <disco> <prepaid|postpaid> <meter> <amount> <phone> — pay an electricity bill\n\n' +
    'Every send, top-up, or bill payment asks for /confirm before anything moves.'
  );
});

bot.command('wallet', (ctx) => {
  const account = walletForTelegramUser(ctx.from.id);
  const username = getUsernameFor(ctx.from.id);
  ctx.reply(
    `Your Sendo wallet address:\n${account.address}\n` +
    (username ? `Your username: @${username}\n` : 'You haven\'t set a username yet — try /setusername\n') +
    '\nFund this with cNGN to start sending.'
  );
});

bot.command('balance', async (ctx) => {
  const account = walletForTelegramUser(ctx.from.id);
  try {
    const balance = await getCngnBalance(account.address);
    ctx.reply(`Your cNGN balance: ${balance}`);
  } catch (err) {
    console.error(err);
    ctx.reply('Could not fetch your balance right now — try again in a moment.');
  }
});

bot.command('setusername', (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const [, requested] = parts;

  if (!requested) {
    ctx.reply('Usage: /setusername <name>\nExample: /setusername chinedu_o\n(lowercase letters, numbers, underscores — 3-20 characters)');
    return;
  }

  try {
    const username = setUsername(ctx.from.id, requested);
    ctx.reply(`✅ You're now @${username}. Others can send to you with /send @${username} <amount>.`);
  } catch (err) {
    ctx.reply(err.message);
  }
});

bot.command('cancel', (ctx) => {
  if (pendingActions.delete(ctx.from.id)) {
    ctx.reply('Cancelled — nothing was sent.');
  } else {
    ctx.reply('Nothing pending to cancel.');
  }
});

bot.command('send', (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const [, target, amount] = parts;

  if (!target || !amount) {
    ctx.reply('Usage: /send <address or @username> <amount>\nExample: /send @chinedu_o 500');
    return;
  }

  const recipient = resolveRecipient(target);
  if (!recipient) {
    ctx.reply(`Couldn't find a user called "${target}" — check the spelling, or use their full wallet address instead.`);
    return;
  }

  setPending(ctx.from.id, { type: 'send', toAddress: recipient.address, amount });
  ctx.reply(
    `Confirm: send ${amount} cNGN to ${recipient.label}?\n` +
    'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
  );
});

bot.command('airtime', (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const [, network, phone, amount] = parts;

  if (!network || !phone || !amount) {
    ctx.reply('Usage: /airtime <network> <phone> <amount>\nExample: /airtime mtn 08011111111 500');
    return;
  }

  setPending(ctx.from.id, { type: 'airtime', network, phone, amount });
  ctx.reply(
    `Confirm: buy ${amount} cNGN worth of ${network} airtime for ${phone}?\n` +
    'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
  );
});

bot.command('bill', async (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const [, disco, meterType, meterNumber, amount, phone] = parts;

  if (!disco || !meterType || !meterNumber || !amount || !phone) {
    ctx.reply(
      'Usage: /bill <disco> <prepaid|postpaid> <meter> <amount> <phone>\n' +
      'Example: /bill ikeja prepaid 1111111111111 2000 08011111111'
    );
    return;
  }

  if (meterType !== 'prepaid' && meterType !== 'postpaid') {
    ctx.reply('Meter type must be exactly "prepaid" or "postpaid".');
    return;
  }

  // Verifying the meter happens here, up front — before we even ask for
  // confirmation — so the confirmation message can show the real customer
  // name, not just the raw meter number the user typed.
  let meterInfo;
  try {
    meterInfo = await verifyMeter({ disco, meterNumber, meterType });
  } catch (err) {
    console.error(err);
    ctx.reply("Couldn't verify that meter — double-check the number. Error: " + err.message);
    return;
  }

  setPending(ctx.from.id, { type: 'bill', disco, meterType, meterNumber, amount, phone });
  ctx.reply(
    `Meter verified: ${meterInfo.customerName}${meterInfo.customerAddress ? ' — ' + meterInfo.customerAddress : ''}\n\n` +
    `Confirm: pay ${amount} cNGN toward this bill?\n` +
    'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
  );
});

bot.command('confirm', async (ctx) => {
  const pending = getPending(ctx.from.id);
  if (!pending) {
    ctx.reply('Nothing pending to confirm — it may have expired. Start again with /send, /airtime, or /bill.');
    return;
  }
  pendingActions.delete(ctx.from.id);

  const account = walletForTelegramUser(ctx.from.id);

  if (pending.type === 'send') {
    ctx.reply(`Sending ${pending.amount} cNGN...`);
    try {
      const { hash } = await sendCngn({ account, toAddress: pending.toAddress, amount: pending.amount });
      ctx.reply(`✅ Sent! Transaction: https://celoscan.io/tx/${hash}`);
    } catch (err) {
      console.error(err);
      ctx.reply(
        "That didn't go through — make sure your wallet has enough cNGN " +
        '(and check /balance). Error: ' + err.message
      );
    }
    return;
  }

  const treasury = walletForTelegramUser(TREASURY_WALLET_ID);

  if (pending.type === 'airtime') {
    ctx.reply(`Moving ${pending.amount} cNGN to cover this top-up...`);
    let onChainResult;
    try {
      onChainResult = await sendCngn({ account, toAddress: treasury.address, amount: pending.amount });
    } catch (err) {
      console.error(err);
      ctx.reply(
        "Couldn't move the funds — make sure your wallet has enough cNGN " +
        '(and check /balance). Error: ' + err.message
      );
      return;
    }

    ctx.reply(`Payment received on-chain. Buying ${pending.network} airtime for ${pending.phone}...`);
    try {
      const result = await buyAirtime({ network: pending.network, phone: pending.phone, amount: pending.amount });
      ctx.reply(
        `✅ Airtime delivered!\n` +
        `Status: ${result.status}\n` +
        `Reference: ${result.transactionId}\n` +
        `On-chain payment: https://celoscan.io/tx/${onChainResult.hash}`
      );
    } catch (err) {
      console.error(err);
      ctx.reply(
        'Your cNGN payment went through on-chain, but the airtime purchase itself failed: ' +
        err.message +
        '\n\nThis needs a manual refund for now — that flow isn\'t built yet.'
      );
    }
    return;
  }

  if (pending.type === 'bill') {
    ctx.reply(`Moving ${pending.amount} cNGN to cover this bill...`);
    let onChainResult;
    try {
      onChainResult = await sendCngn({ account, toAddress: treasury.address, amount: pending.amount });
    } catch (err) {
      console.error(err);
      ctx.reply(
        "Couldn't move the funds — make sure your wallet has enough cNGN " +
        '(and check /balance). Error: ' + err.message
      );
      return;
    }

    ctx.reply('Payment received on-chain. Paying the electricity bill...');
    try {
      const result = await payElectricity({
        disco: pending.disco,
        meterNumber: pending.meterNumber,
        meterType: pending.meterType,
        amount: pending.amount,
        phone: pending.phone,
      });
      ctx.reply(
        `✅ Bill paid!\n` +
        `Status: ${result.status}\n` +
        (result.token ? `Token: ${result.token}\n` : '') +
        `Reference: ${result.transactionId}\n` +
        `On-chain payment: https://celoscan.io/tx/${onChainResult.hash}`
      );
    } catch (err) {
      console.error(err);
      ctx.reply(
        'Your cNGN payment went through on-chain, but the bill payment itself failed: ' +
        err.message +
        '\n\nThis needs a manual refund for now — that flow isn\'t built yet.'
      );
    }
  }
});

bot.launch();
console.log('Sendo is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
