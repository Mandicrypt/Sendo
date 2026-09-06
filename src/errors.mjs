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
// it's actually submitted, especially under real network load. A single
// immediate retry isn't always enough during sustained congestion — the
// base fee can still be rising by the time the retry lands. This retries
// several times with a short, increasing pause between attempts, giving
// the network a moment to settle before trying again. Quiet on success;
// only surfaces an error if every attempt fails.
export async function withGasRetry(fn, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = shortenError(err).toLowerCase();
      const isFeeIssue = message.includes('base fee') || message.includes('fee cap');
      if (!isFeeIssue || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = attempt * 1000; // 1s, 2s, 3s...
      console.log(`Gas fee retry ${attempt}/${maxAttempts - 1} after a ${delayMs}ms pause...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
