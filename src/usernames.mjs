// Simple username registry — lets Sendo users send to "@somebody" instead
// of a long 0x address. Stored as a local JSON file rather than a real
// database, since that's plenty for a hackathon build; swap for a proper
// database before this handles real users at any scale.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'usernames.json');

function load() {
  if (!existsSync(DATA_FILE)) return {};
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

function save(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Usernames: lowercase letters, numbers, underscores, 3-20 characters.
// Keeps things simple and avoids lookalike-character tricks.
const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export function setUsername(telegramUserId, rawUsername) {
  const username = rawUsername.toLowerCase().replace(/^@/, '');

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      'Usernames must be 3-20 characters, lowercase letters/numbers/underscores only.'
    );
  }

  const data = load();

  const existingOwner = Object.entries(data).find(([, id]) => id === telegramUserId);
  const takenBy = data[username];

  if (takenBy && takenBy !== telegramUserId) {
    throw new Error(`@${username} is already taken.`);
  }

  // Remove any previous username this user had — one active username each.
  if (existingOwner) {
    delete data[existingOwner[0]];
  }

  data[username] = telegramUserId;
  save(data);

  return username;
}

export function resolveUsername(rawUsername) {
  const username = rawUsername.toLowerCase().replace(/^@/, '');
  const data = load();
  return data[username] || null;
}

export function getUsernameFor(telegramUserId) {
  const data = load();
  const entry = Object.entries(data).find(([, id]) => id === telegramUserId);
  return entry ? entry[0] : null;
}
