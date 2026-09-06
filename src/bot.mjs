import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { walletForTelegramUser, exportPrivateKeyForTelegramUser } from './wallet.mjs';
import { getCngnBalance, getCusdBalance, getStableBalances, sendCngn } from './celo.mjs';
import { buyAirtime, verifyMeter, payElectricity } from './vtpass.mjs';
import { TREASURY_WALLET_ID } from './config.mjs';
import { setUsername, resolveUsername, getUsernameFor } from './usernames.mjs';
import { parseIntent } from './nlp.mjs';
import { quoteTopup, executeTopup } from './swap.mjs';
import { shortenError } from './errors.mjs';
import { trackUser, startBalanceWatcher } from './notifications.mjs';
import { generateReceipt } from './receipt.mjs';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('Set TELEGRAM_BOT_TOKEN in your .env file — get one from @BotFather.');
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Every interaction registers the user for balance-change notifications —
// this has to come before any command handlers so it runs on every message.
bot.use((ctx, next) => {
  if (ctx.from) trackUser(ctx.from.id);
  return next();
});

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

// Gates any real action behind having a username set — this is what
// lets receipts show "@someone" instead of a raw wallet address, and
// gives everyone a human-readable identity within Sendo. Never gates
// /start, /setusername, /cancel, or /confirm themselves — a user must
// always be able to learn about the bot or set a username in the first
// place, and /confirm only fires on actions that were already vetted
// when the pending action was created.
function requireUsername(ctx) {
  if (getUsernameFor(ctx.from.id)) return true;
  ctx.reply(
    "Before that, let's get you a username — it's what shows up on receipts instead of a long wallet address.\n\n" +
    'Run /setusername <name> — e.g. /setusername chinedu_o'
  );
  return false;
}

function welcomeMessage() {
  return (
    "Welcome to Sendo — send and receive cNGN right here in Telegram, no CELO required for gas.\n\n" +
    'Commands:\n' +
    '/wallet — see your Sendo wallet address\n' +
    '/balance — check your cNGN and cUSD balance\n' +
    '/topup — deposited cUSD? Convert it to cNGN automatically\n' +
    '/exportwallet — get your private key to use this wallet outside Sendo (e.g. to send cUSD or USDC directly)\n' +
    '/setusername <name> — pick a username so others can send to you by name\n' +
    '/send <address or @username> <amount> — send cNGN\n' +
    '/airtime <network> <phone> <amount> — top up airtime (mtn, glo, airtel, 9mobile)\n' +
    '/bill <disco> <prepaid|postpaid> <meter> <amount> <phone> — pay an electricity bill\n\n' +
    'Or just type what you want in plain English — "send 500 to @chinedu", "buy 200 naira MTN airtime for 08011111111", "pay my ikeja light bill, 2000, meter 1111111111111", "set my username to chinedu_o".\n\n' +
    'Every send, top-up, or bill payment asks for /confirm before anything moves.'
  );
}

bot.start((ctx) => {
  ctx.reply(welcomeMessage());
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
    const [cngnBalance, stables] = await Promise.all([
      getCngnBalance(account.address),
      getStableBalances(account.address),
    ]);
    const stablesLine = stables.map((s) => `Your ${s.symbol} balance: ${s.balance}`).join('\n');
    const hasSpareStable = stables.some((s) => Number(s.balance) > 0.5);
    ctx.reply(
      `Your cNGN balance: ${cngnBalance}\n` +
      stablesLine +
      (hasSpareStable ? '\n\nHave a stablecoin you want converted to cNGN? Try /topup.' : '')
    );
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
    ctx.reply(shortenError(err));
  }
});

bot.command('cancel', (ctx) => {
  if (pendingActions.delete(ctx.from.id)) {
    ctx.reply('Cancelled — nothing was sent.');
  } else {
    ctx.reply('Nothing pending to cancel.');
  }
});

bot.command('exportwallet', (ctx) => {
  if (!requireUsername(ctx)) return;
  setPending(ctx.from.id, { type: 'exportwallet' });
  ctx.reply(
    '⚠️ This will send you your wallet\'s private key — the master password for everything in it.\n\n' +
    'Anyone who sees this key can take everything in your wallet, permanently, with no way to reverse it. ' +
    'Only continue if you\'re somewhere private, and delete the message as soon as you\'ve saved the key ' +
    '(e.g. by importing it into MetaMask or another wallet app) somewhere safe.\n\n' +
    'This is how you can move cUSD, USDC, or anything else Sendo doesn\'t have a command for — you always ' +
    'have full access to your own funds outside of Sendo, whenever you want.\n\n' +
    'Reply /confirm to receive it, or /cancel. This expires in 2 minutes.'
  );
});

bot.command('topup', async (ctx) => {
  if (!requireUsername(ctx)) return;
  const account = walletForTelegramUser(ctx.from.id);

  ctx.reply('Checking your stablecoin balances and current cNGN rates...');

  let quote;
  try {
    quote = await quoteTopup(account);
  } catch (err) {
    console.error(err);
    // quoteTopup usually throws its own clear, multi-line explanation
    // (not a raw viem error) — show that in full. But if something
    // unexpected comes from viem itself (which attaches a clean
    // .shortMessage), prefer that over the full multi-paragraph dump.
    ctx.reply(err.shortMessage || err.message);
    return;
  }

  setPending(ctx.from.id, { type: 'topup', quote });
  ctx.reply(
    `Deposit found: ${quote.amountToSwapDisplay} ${quote.stableSymbol}\n` +
    `You'll get approximately: ${quote.quotedOutDisplay} cNGN\n` +
    `Kept in reserve for fees: ${quote.reserveDisplay} ${quote.stableSymbol}\n\n` +
    'Rates can shift slightly by the time this executes — you\'re protected up to 2% price movement.\n\n' +
    'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
  );
});

bot.command('send', (ctx) => {
  if (!requireUsername(ctx)) return;
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

  setPending(ctx.from.id, { type: 'send', toAddress: recipient.address, label: recipient.label, amount });
  ctx.reply(
    `Confirm: send ${amount} cNGN to ${recipient.label}?\n` +
    'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
  );
});

bot.command('airtime', (ctx) => {
  if (!requireUsername(ctx)) return;
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
  if (!requireUsername(ctx)) return;
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
    ctx.reply("Couldn't verify that meter — double-check the number. Error: " + shortenError(err));
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

  if (pending.type === 'exportwallet') {
    const privateKey = exportPrivateKeyForTelegramUser(ctx.from.id);
    await ctx.reply(
      `Your private key:\n\n\`${privateKey}\`\n\n` +
      'Import this into MetaMask, Rabby, or any wallet app under "Import Account" / "Import Private Key" ' +
      '— never type it into a website, never share it in any chat again, and delete this message once you\'ve saved it.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const account = walletForTelegramUser(ctx.from.id);

  if (pending.type === 'topup') {
    ctx.reply(`Swapping your ${pending.quote.stableSymbol} for cNGN...`);
    try {
      const { swapHash } = await executeTopup(account, pending.quote);
      ctx.reply(
        `✅ Swap complete! You now have cNGN in your wallet, with ${pending.quote.reserveDisplay} ${pending.quote.stableSymbol} ` +
        'kept back for future transaction fees.\n' +
        `Transaction: https://celoscan.io/tx/${swapHash}`
      );
      const receipt = await generateReceipt({
        title: 'Wallet Topped Up',
        amount: pending.quote.quotedOutDisplay,
        rows: [
          { label: 'Converted From', value: `${pending.quote.amountToSwapDisplay} ${pending.quote.stableSymbol}` },
          { label: 'Received', value: `NGN ${Number(pending.quote.quotedOutDisplay).toLocaleString('en-NG', { maximumFractionDigits: 2 })}` },
          { label: 'Kept for Fees', value: `${pending.quote.reserveDisplay} ${pending.quote.stableSymbol}` },
          { label: 'Status', value: 'Completed' },
        ],
        reference: swapHash.slice(2, 10),
      });
      await ctx.replyWithPhoto({ source: receipt }, { caption: 'Your receipt — save or forward this to anyone.' });
    } catch (err) {
      console.error(err);
      ctx.reply(
        "The swap didn't go through: " + shortenError(err) + '\n\n' +
        `Your ${pending.quote.stableSymbol} should still be in your wallet — check /balance and try /topup again.`
      );
    }
    return;
  }

  if (pending.type === 'send') {
    ctx.reply(`Sending ${pending.amount} cNGN...`);
    try {
      const { hash } = await sendCngn({ account, toAddress: pending.toAddress, amount: pending.amount });
      ctx.reply(`✅ Sent! Transaction: https://celoscan.io/tx/${hash}`);
      const receipt = await generateReceipt({
        title: 'Money Sent',
        amount: pending.amount,
        rows: [
          { label: 'From', value: '@' + getUsernameFor(ctx.from.id) },
          { label: 'To', value: pending.label || pending.toAddress },
          { label: 'Currency', value: 'cNGN' },
          { label: 'Status', value: 'Completed' },
        ],
        reference: hash.slice(2, 10),
      });
      await ctx.replyWithPhoto({ source: receipt }, { caption: 'Your receipt — save or forward this to anyone.' });
    } catch (err) {
      console.error(err);
      ctx.reply(
        "That didn't go through — make sure your wallet has enough cNGN " +
        '(and check /balance). Error: ' + shortenError(err)
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
        '(and check /balance). Error: ' + shortenError(err)
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
      const receipt = await generateReceipt({
        title: 'Airtime Top-Up Successful',
        amount: pending.amount,
        rows: [
          { label: 'Network', value: pending.network.toUpperCase() },
          { label: 'Phone Number', value: pending.phone },
          { label: 'Paid With', value: 'cNGN via Sendo' },
          { label: 'Status', value: result.status || 'Delivered' },
        ],
        reference: result.transactionId || onChainResult.hash.slice(2, 10),
      });
      await ctx.replyWithPhoto({ source: receipt }, { caption: 'Your receipt — save or forward this to anyone.' });
    } catch (err) {
      console.error(err);
      ctx.reply(
        'Your cNGN payment went through on-chain, but the airtime purchase itself failed: ' +
        shortenError(err) +
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
        '(and check /balance). Error: ' + shortenError(err)
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
      const receiptRows = [
        { label: 'Disco', value: pending.disco.charAt(0).toUpperCase() + pending.disco.slice(1) },
        { label: 'Meter Number', value: pending.meterNumber },
        { label: 'Meter Type', value: pending.meterType.charAt(0).toUpperCase() + pending.meterType.slice(1) },
      ];
      if (result.token) receiptRows.push({ label: 'Token', value: result.token });
      receiptRows.push({ label: 'Status', value: result.status || 'Completed' });
      const receipt = await generateReceipt({
        title: 'Bill Payment Successful',
        amount: pending.amount,
        rows: receiptRows,
        reference: result.transactionId || onChainResult.hash.slice(2, 10),
      });
      await ctx.replyWithPhoto({ source: receipt }, { caption: 'Your receipt — save or forward this to anyone.' });
    } catch (err) {
      console.error(err);
      ctx.reply(
        'Your cNGN payment went through on-chain, but the bill payment itself failed: ' +
        shortenError(err) +
        '\n\nThis needs a manual refund for now — that flow isn\'t built yet.'
      );
    }
  }
});

// Catches any message that isn't a recognized slash command and tries to
// understand it as plain English. Deliberately reuses the exact same
// setPending/confirm flow as the slash commands below — natural language
// is just a second way to fill out the same action, never a shortcut
// around confirmation.
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return; // an unrecognized command, not free text — leave it alone

  let intent;
  try {
    intent = await parseIntent(text);
  } catch (err) {
    console.error(err);
    ctx.reply("Couldn't process that right now: " + shortenError(err));
    return;
  }

  if (intent.type === 'help') {
    ctx.reply(welcomeMessage());
    return;
  }

  if (intent.type === 'unknown') {
    ctx.reply(
      `I didn't quite catch that${intent.reason ? ' — ' + intent.reason : ''}.\n\n` +
      'You can also use exact commands:\n' +
      '/send <address or @username> <amount>\n' +
      '/airtime <network> <phone> <amount>\n' +
      '/bill <disco> <prepaid|postpaid> <meter> <amount> <phone>'
    );
    return;
  }

  if (intent.type === 'balance') {
    const account = walletForTelegramUser(ctx.from.id);
    try {
      const [cngnBalance, stables] = await Promise.all([
        getCngnBalance(account.address),
        getStableBalances(account.address),
      ]);
      const stablesLine = stables.map((s) => `Your ${s.symbol} balance: ${s.balance}`).join('\n');
      ctx.reply(`Your cNGN balance: ${cngnBalance}\n${stablesLine}`);
    } catch (err) {
      console.error(err);
      ctx.reply('Could not fetch your balance right now — try again in a moment.');
    }
    return;
  }

  if (intent.type === 'wallet') {
    const account = walletForTelegramUser(ctx.from.id);
    const username = getUsernameFor(ctx.from.id);
    ctx.reply(
      `Your Sendo wallet address:\n${account.address}\n` +
      (username ? `Your username: @${username}` : 'You haven\'t set a username yet — try /setusername')
    );
    return;
  }

  if (intent.type === 'setusername') {
    try {
      const username = setUsername(ctx.from.id, intent.username);
      ctx.reply(`✅ You're now @${username}. Others can send to you with "send [amount] to @${username}" or /send @${username} <amount>.`);
    } catch (err) {
      ctx.reply(err.message);
    }
    return;
  }

  if (intent.type === 'send') {
    if (!requireUsername(ctx)) return;
    const recipient = resolveRecipient(intent.target);
    if (!recipient) {
      ctx.reply(`Couldn't find a user called "${intent.target}" — check the spelling, or use their full wallet address.`);
      return;
    }
    setPending(ctx.from.id, { type: 'send', toAddress: recipient.address, label: recipient.label, amount: intent.amount });
    ctx.reply(
      `Confirm: send ${intent.amount} cNGN to ${recipient.label}?\n` +
      'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
    );
    return;
  }

  if (intent.type === 'airtime') {
    if (!requireUsername(ctx)) return;
    setPending(ctx.from.id, { type: 'airtime', network: intent.network, phone: intent.phone, amount: intent.amount });
    ctx.reply(
      `Confirm: buy ${intent.amount} cNGN worth of ${intent.network} airtime for ${intent.phone}?\n` +
      'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
    );
    return;
  }

  if (intent.type === 'bill') {
    if (!requireUsername(ctx)) return;
    let meterInfo;
    try {
      meterInfo = await verifyMeter({ disco: intent.disco, meterNumber: intent.meterNumber, meterType: intent.meterType });
    } catch (err) {
      console.error(err);
      ctx.reply("Couldn't verify that meter — double-check the number. Error: " + shortenError(err));
      return;
    }
    setPending(ctx.from.id, {
      type: 'bill',
      disco: intent.disco,
      meterType: intent.meterType,
      meterNumber: intent.meterNumber,
      amount: intent.amount,
      phone: intent.phone,
    });
    ctx.reply(
      `Meter verified: ${meterInfo.customerName}${meterInfo.customerAddress ? ' — ' + meterInfo.customerAddress : ''}\n\n` +
      `Confirm: pay ${intent.amount} cNGN toward this bill?\n` +
      'Reply /confirm to proceed, or /cancel. This expires in 2 minutes.'
    );
  }
});

bot.launch();
console.log('Sendo is running.');
startBalanceWatcher(bot);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
