# Sendo

A Telegram-based agent for sending cNGN, buying airtime, and paying electricity
bills — built for the **Celo Agents at Work Hackathon**.

Sendo is built for people who don't want to think about crypto at all. You
don't need to hold CELO, understand gas, or manage a wallet app. You just talk
to a Telegram bot — in plain English or exact commands — and Sendo handles the
blockchain part invisibly.

## What it does

- **Send cNGN** to another Sendo user by wallet address or `@username`
- **Buy airtime** (MTN, Glo, Airtel, 9mobile) — paid for in cNGN, delivered via VTpass
- **Pay electricity bills** — verifies the meter and customer name *before* any
  money moves, across 9 major Nigerian discos
- **Top up automatically** — deposit USDT, USDC, or cUSD, and Sendo swaps it
  into cNGN for you (via Uniswap, auto-detecting the best route — including a
  2-hop route through USDT when no direct pool exists), keeping a small
  reserve behind to cover future fees
- **Understand plain English** — "pay my ikeja light bill, 2000, meter
  111..." works exactly like the equivalent slash command
- **Notify you automatically** when cNGN or a stablecoin lands in your wallet
- **Always confirm before moving money** — every send, top-up, or payment
  shows exactly what will happen and waits for an explicit `/confirm`

## Why this matters

cNGN just launched on Celo, and right now the only way most people can get it
is through a handful of licensed exchanges (Quidax, Busha). That's real
friction for the person actually meant to benefit — someone in Nigeria who
just wants to top up airtime or pay a bill.

Sendo's design puts that friction on whoever is *funding* a wallet, not on
the person using it day to day. Once cNGN (or a stablecoin that can become
cNGN) is in a Sendo wallet, everything downstream — sending, paying bills,
buying airtime — works without the recipient ever touching an exchange,
holding CELO, or thinking about gas.

## Built for

**Celo Agents at Work Hackathon** (Aug 28 – Sep 14, 2026)

- **Real World Adoption** (primary) — real, returning users transacting
  through a Telegram channel
- **Value Moved** — real cNGN transfers, bill payments, and airtime
  purchases between independent users
- **Judges' Favorite** — fee abstraction and automatic multi-DEX routing so
  users never need to hold CELO or hunt for the "right" stablecoin

## Stack

- Telegraf (Telegram bot framework)
- viem (Celo mainnet interaction, fee abstraction)
- Uniswap V3 + Ubeswap (V2) — auto-routed stablecoin → cNGN swaps
- VTpass (airtime and electricity bill fulfillment)
- Anthropic API (natural-language command parsing)
- ERC-8004 (on-chain agent identity — [Agent ID 9810](https://8004scan.io/agents/celo/9810))

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` (from @BotFather)
   - `WALLET_MASTER_SEED` (any long random string — derives per-user wallets)
   - `VTPASS_USERNAME` / `VTPASS_PASSWORD` (from vtpass.com or sandbox.vtpass.com)
   - `ANTHROPIC_API_KEY` (from console.anthropic.com)
   - `HACKATHON_ATTRIBUTION_TAG` (already filled in)
3. `npm start`

## Security note

Wallets are derived deterministically per Telegram user from
`WALLET_MASTER_SEED` — this is a custodial model appropriate for a hackathon
build, not a production security posture. See `src/wallet.mjs` for details.

## Team

Built by [Offia Monday](https://github.com/Mandicrypt) — Web3 growth
strategist and Nigeria market-entry specialist.
