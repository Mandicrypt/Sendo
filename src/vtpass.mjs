// VTpass integration — airtime top-up and electricity bill payment.
//
// VTpass sits between Sendo and the real providers (telcos for airtime,
// electricity distribution companies — "discos" — for bills). Sendo pays
// VTpass in Naira from its own VTpass account balance, and VTpass delivers
// the actual airtime or electricity token to the user.
//
// SETUP:
//   1. Create an account at vtpass.com (sandbox first: sandbox.vtpass.com)
//   2. Fund your VTpass account balance with real Naira before going live
//   3. Add credentials to .env — see .env.example

const VTPASS_MODE = process.env.VTPASS_MODE || 'sandbox';
const VTPASS_BASE_URL =
  VTPASS_MODE === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';

function getBasicAuthHeader() {
  const username = process.env.VTPASS_USERNAME;
  const password = process.env.VTPASS_PASSWORD;
  if (!username || !password) {
    throw new Error('Set VTPASS_USERNAME and VTPASS_PASSWORD in your .env file.');
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// VTpass requires a unique request_id per transaction, formatted as:
// YYYYMMDDHHII (today's date + hour + minute, Africa/Lagos time) followed
// by any alphanumeric string, 12+ characters total.
function generateRequestId() {
  const now = new Date();
  const lagosTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const pad = (n) => String(n).padStart(2, '0');
  const prefix =
    lagosTime.getFullYear() +
    pad(lagosTime.getMonth() + 1) +
    pad(lagosTime.getDate()) +
    pad(lagosTime.getHours()) +
    pad(lagosTime.getMinutes());
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}${suffix}`;
}

// ─── Airtime ────────────────────────────────────────────────────────────

const AIRTIME_SERVICE_IDS = {
  mtn: 'mtn',
  glo: 'glo',
  airtel: 'airtel',
  '9mobile': 'etisalat',
};

export async function buyAirtime({ network, phone, amount }) {
  const serviceID = AIRTIME_SERVICE_IDS[network.toLowerCase()];
  if (!serviceID) {
    throw new Error(`Unknown network "${network}". Use one of: mtn, glo, airtel, 9mobile.`);
  }

  const requestId = generateRequestId();

  const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getBasicAuthHeader(),
    },
    body: JSON.stringify({
      request_id: requestId,
      serviceID,
      amount,
      phone,
    }),
  });

  const data = await response.json();

  if (data.code !== '000') {
    throw new Error(`VTpass rejected the request: ${data.response_description || 'unknown error'}`);
  }

  return {
    requestId,
    status: data.content?.transactions?.status,
    transactionId: data.content?.transactions?.transactionId,
  };
}

// ─── Electricity ────────────────────────────────────────────────────────

// VTpass's service IDs for major Nigerian electricity distribution
// companies (discos). Not exhaustive — these are the ones with confirmed,
// documented service IDs as of this build.
const ELECTRICITY_SERVICE_IDS = {
  ikeja: 'ikeja-electric',
  eko: 'eko-electric',
  ibadan: 'ibadan-electric',
  kaduna: 'kaduna-electric',
  abuja: 'abuja-electric',
  kano: 'kano-electric',
  enugu: 'enugu-electric',
  portharcourt: 'portharcourt-electric',
  aba: 'aba-electric',
};

// Step 1 of electricity payment: confirm the meter number is real and see
// whose name it's registered to, before any money moves. This matters —
// VTpass's own docs stress always validating the meter first, since a
// mistyped meter number means paying for the wrong person's electricity.
//
// VTpass's own sandbox test meter numbers:
//   prepaid:  1111111111111
//   postpaid: 1010101010101
// Any other number simulates a failed verification, by design.
export async function verifyMeter({ disco, meterNumber, meterType }) {
  const serviceID = ELECTRICITY_SERVICE_IDS[disco.toLowerCase()];
  if (!serviceID) {
    throw new Error(
      `Unknown disco "${disco}". Use one of: ${Object.keys(ELECTRICITY_SERVICE_IDS).join(', ')}.`
    );
  }

  const response = await fetch(`${VTPASS_BASE_URL}/merchant-verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getBasicAuthHeader(),
    },
    body: JSON.stringify({
      billersCode: meterNumber,
      serviceID,
      type: meterType,
    }),
  });

  const data = await response.json();

  if (data.code !== '000') {
    throw new Error(`Meter verification failed: ${data.response_description || 'meter not found'}`);
  }

  return {
    serviceID,
    customerName: data.content?.Customer_Name || 'Unknown',
    customerAddress: data.content?.Address || '',
  };
}

// Step 2: the actual payment — only call this after verifyMeter succeeds,
// so the user (or the code) has a chance to confirm the customer name
// before real cNGN moves.
export async function payElectricity({ disco, meterNumber, meterType, amount, phone }) {
  const serviceID = ELECTRICITY_SERVICE_IDS[disco.toLowerCase()];
  const requestId = generateRequestId();

  const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getBasicAuthHeader(),
    },
    body: JSON.stringify({
      request_id: requestId,
      serviceID,
      billersCode: meterNumber,
      variation_code: meterType,
      amount,
      phone,
    }),
  });

  const data = await response.json();

  if (data.code !== '000') {
    throw new Error(`Payment failed: ${data.response_description || 'unknown error'}`);
  }

  return {
    requestId,
    status: data.content?.transactions?.status,
    transactionId: data.content?.transactions?.transactionId,
    token: data.token || data.purchased_code || null,
  };
}
