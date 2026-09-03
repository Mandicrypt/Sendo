// Registers Sendo's ERC-8004 agent identity on Celo mainnet.
//
// This script talks to the IdentityRegistry contract directly using a
// minimal ABI (verified against erc-8004/erc-8004-contracts on GitHub).
// We deliberately do NOT import @chaoschain/sdk here — that package's
// bundle throws "Dynamic require of util is not supported" when loaded
// via a real ESM `import` statement, so we skip it and use ethers alone.
//
// SETUP:
//   1. npm install ethers dotenv   (you no longer need @chaoschain/sdk
//      for this script — fine to leave it installed, just unused here)
//   2. Create a .env file (same folder) with:
//        PRIVATE_KEY=0xyourprivatekey
//   3. Push agent-registration.json to the Sendo repo first, so it has a
//      public URL. AGENT_URI below already points at that raw GitHub URL.
//   4. Fund the wallet behind PRIVATE_KEY with a small amount of CELO
//      (a few cents worth is enough for gas on this one transaction).
//   5. Run: node register.mjs
//
// Never commit .env or paste your private key anywhere outside your own
// machine's environment variables.

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';

const RPC_URL = 'https://forno.celo.org'; // Celo mainnet, free public RPC
const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'; // Celo mainnet

const AGENT_URI = 'https://raw.githubusercontent.com/Mandicrypt/Sendo/main/agent-registration.json';

// Minimal ABI — just the register(string) function and the Registered
// event — pulled verbatim from erc-8004/erc-8004-contracts/abis/IdentityRegistry.json
const IDENTITY_REGISTRY_ABI = [
  {
    inputs: [{ internalType: 'string', name: 'agentURI', type: 'string' }],
    name: 'register',
    outputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { indexed: false, internalType: 'string', name: 'agentURI', type: 'string' },
      { indexed: true, internalType: 'address', name: 'owner', type: 'address' },
    ],
    name: 'Registered',
    type: 'event',
  },
];

async function main() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error('Set PRIVATE_KEY in your .env file before running this.');
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

  console.log('Registering agent from wallet:', wallet.address);

  const registry = new Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ABI, wallet);

  const tx = await registry.register(AGENT_URI);
  console.log('Transaction sent:', tx.hash);

  const receipt = await tx.wait();

  const registeredLog = receipt.logs
    .map((log) => {
      try {
        return registry.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'Registered');

  if (!registeredLog) {
    console.log('Transaction confirmed, but could not find the Registered event to read the agentId.');
    console.log('Check the transaction on a Celo block explorer using this hash:', tx.hash);
    return;
  }

  const agentId = registeredLog.args.agentId.toString();

  console.log('✅ Sendo registered!');
  console.log('Agent ID:', agentId);
  console.log('Transaction hash:', tx.hash);
  console.log('\nSave this Agent ID — you will need it for hackathon registration.');
}

main().catch((err) => {
  console.error('Registration failed:', err);
  process.exit(1);
});
