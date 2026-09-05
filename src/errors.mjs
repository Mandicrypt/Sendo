// Viem's raw error objects are extremely detailed — useful for debugging,
// completely wrong to show a Telegram user directly. This pulls out just
// the short, human part.
export function shortenError(err) {
  // viem attaches a clean one-line summary as .shortMessage on most of
  // its errors — prefer that over the full multi-paragraph .message.
  if (err.shortMessage) return err.shortMessage;

  // Fall back to just the first line of whatever we got, in case it's a
  // plain Error from somewhere else in the code instead of a viem one.
  return String(err.message || err).split('\n')[0];
}

// Celo's base fee can shift between when a transaction is built and when
// it's actually submitted, especially under load. When that happens,
// viem's fee estimate can end up just barely too low — retrying once,
// which re-fetches fresh gas numbers, resolves it almost every time.
// Quiet on success; only surfaces an error if it fails twice in a row.
export async function withGasRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const message = shortenError(err).toLowerCase();
    if (message.includes('base fee') || message.includes('fee cap')) {
      return await fn();
    }
    throw err;
  }
}
