// Turns a plain-English message ("pay my ikeja light bill, 2000 naira,
// meter 1111111111111") into the same structured action shape the slash
// commands already produce — so it can flow into the exact same
// confirmation step, with no separate code path to trust or maintain.

const SYSTEM_PROMPT = `You turn a Nigerian user's plain-English message into a structured action for Sendo, a Telegram bot that sends cNGN, buys airtime, and pays electricity bills on Celo.

Respond with ONLY a JSON object, no other text, matching one of these shapes:

Send money: {"type":"send","target":"<address starting with 0x, or @username>","amount":"<number as a string>"}
Buy airtime: {"type":"airtime","network":"<mtn|glo|airtel|9mobile>","phone":"<phone number>","amount":"<number as a string>"}
Pay a bill: {"type":"bill","disco":"<ikeja|eko|ibadan|kaduna|abuja|kano|enugu|portharcourt|aba>","meterType":"<prepaid|postpaid>","meterNumber":"<meter number>","amount":"<number as a string>","phone":"<phone number>"}
Check balance: {"type":"balance"}
Check wallet address: {"type":"wallet"}
Set a username: {"type":"setusername","username":"<desired username, lowercase, no @ symbol>"}
General greeting, "what can you do", or asking for help: {"type":"help"}
Unclear or missing required info: {"type":"unknown","reason":"<short reason, e.g. missing amount>"}

Rules:
- If any required field for a type is missing or ambiguous, respond with the top-level {"type":"unknown","reason":"..."} shape instead — never put a placeholder word like "unknown" as the VALUE of a field inside another type (e.g. never {"type":"airtime","network":"unknown",...} or {"type":"bill","disco":"unknown",...}). If you can't confidently fill in every required field, the whole response must be {"type":"unknown", ...}.
- "light bill", "electric bill", "NEPA", "PHCN" all mean an electricity bill.
- If no disco (electricity provider) is named, default disco to "ikeja" only if the user is clearly in Lagos; otherwise respond with {"type":"unknown","reason":"which electricity provider (disco)?"}.
- Amounts are in cNGN (1 cNGN = 1 Naira). Strip currency symbols/words, keep just the number.
- Never invent a phone number, meter number, or wallet address that wasn't in the message.
- Use "help" for anything that's asking about the bot itself rather than asking it to do something — "hi", "what can you do", "help", "how does this work" all count.`;

export async function parseIntent(message) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Set ANTHROPIC_API_KEY in your .env file to enable natural language.');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const rawText = data.content?.[0]?.text?.trim() || '';

  // Claude sometimes wraps JSON in markdown code fences even when told not
  // to — strip those before parsing rather than let a formatting quirk
  // silently produce a false "I didn't understand that."
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('Could not parse NLP response as JSON. Raw response was:', rawText);
    return { type: 'unknown', reason: "couldn't understand that as a valid request" };
  }
}
