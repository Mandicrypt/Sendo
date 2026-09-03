import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { walletForTelegramUser } from './wallet.mjs';
import { getCngnBalance, sendCngn } from './celo.mjs';
import { buyAirtime, verifyMeter, payElectricity } from './vtpass.mjs';
import { TREASURY_WALLET_ID } from './config.mjs';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('Set TELEGRAM_BOT_TOKEN in your .env file — get one from @BotFather.');
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    "Welcome to Sendo — send and receive cNGN right here in Telegram, no CELO required for gas.\n\n" +
    'Commands:\n' +
    '/wallet — see your Sendo wallet address\n' +
    '/balance — check your cNGN balance\n' +
    '/send <address> <amount> — send cNGN to another address\n' +
    '/airtime <network> <phone> <amount> — top up airtime (mtn, glo, airtel, 9mobile)\n' +
    '/bill <disco> <prepaid|postpaid> <meter> <amount> <phone> — pay an electricity bill'
  );
});

bot.command('wallet', (ctx) => {
  const account = walletForTelegramUser(ctx.from.id);
  ctx.reply(`Your Sendo wallet address:\n${account.address}\n\nFund this with cNGN to start sending.`);
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

bot.command('send', async (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const [, toAddress, amount] = parts;

  if (!toAddress || !amount || !toAddress.startsWith('0x')) {
    ctx.reply('Usage: /send <address> <amount>\nExample: /send 0xabc123... 500');
    return;
  }

  const account = walletForTelegramUser(ctx.from.id);
  ctx.reply(`Sending ${amount} cNGN to ${toAddress}...`);

  try {
    const { hash } = await sendCngn({ account, toAddress, amount });
    ctx.reply(`✅ Sent! Transaction: https://celoscan.io/tx/${hash}`);
  } catch (err) {
    console.error(err);
    ctx.reply(
      "That didn't go through — make sure your wallet has enough cNGN " +
      '(and check /balance). Error: ' + err.message
    );
  }
});

bot.command('airtime', async (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const [, network, phone, amount] = parts;

  if (!network || !phone || !amount) {
    ctx.reply('Usage: /airtime <network> <phone> <amount>\nExample: /airtime mtn 08011111111 500');
    return;
  }

  const account = walletForTelegramUser(ctx.from.id);
  const treasury = walletForTelegramUser(TREASURY_WALLET_ID);

  ctx.reply(`Moving ${amount} cNGN to cover this top-up...`);

  // Step 1: move the user's cNGN into Sendo's treasury wallet on-chain.
  // This is the real, tagged, on-chain transaction that counts toward
  // the hackathon's Value Moved metrics.
  let onChainResult;
  try {
    onChainResult = await sendCngn({ account, toAddress: treasury.address, amount });
  } catch (err) {
    console.error(err);
    ctx.reply(
      "Couldn't move the funds — make sure your wallet has enough cNGN " +
      '(and check /balance). Error: ' + err.message
    );
    return;
  }

  ctx.reply(`Payment received on-chain. Buying ${network} airtime for ${phone}...`);

  // Step 2: fulfill the actual airtime purchase through VTpass, paid from
  // Sendo's own VTpass Naira balance — this part never touches crypto.
  try {
    const result = await buyAirtime({ network, phone, amount });
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

  // Step 1: verify the meter BEFORE touching any money. This is the safety
  // check that /airtime doesn't need but bill payment does — a mistyped
  // meter number means paying for a stranger's electricity, with no way
  // to get that money back.
  let meterInfo;
  try {
    meterInfo = await verifyMeter({ disco, meterNumber, meterType });
  } catch (err) {
    console.error(err);
    ctx.reply("Couldn't verify that meter — double-check the number. Error: " + err.message);
    return;
  }

  ctx.reply(
    `Meter verified: ${meterInfo.customerName}${meterInfo.customerAddress ? ' — ' + meterInfo.customerAddress : ''}\n` +
    `Moving ${amount} cNGN to cover this bill...`
  );

  const account = walletForTelegramUser(ctx.from.id);
  const treasury = walletForTelegramUser(TREASURY_WALLET_ID);

  // Step 2: now that we know who this meter belongs to, move the user's
  // cNGN on-chain — same pattern as /airtime, tagged for the hackathon.
  let onChainResult;
  try {
    onChainResult = await sendCngn({ account, toAddress: treasury.address, amount });
  } catch (err) {
    console.error(err);
    ctx.reply(
      "Couldn't move the funds — make sure your wallet has enough cNGN " +
      '(and check /balance). Error: ' + err.message
    );
    return;
  }

  ctx.reply('Payment received on-chain. Paying the electricity bill...');

  // Step 3: fulfill the actual bill payment through VTpass.
  try {
    const result = await payElectricity({ disco, meterNumber, meterType, amount, phone });
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
});

bot.launch();
console.log('Sendo is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
