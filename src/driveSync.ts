import { db, type Account, type Bill, type ReminderSetting, type Transaction } from './db';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FILE_NAME = 'Pocket Ledger Sync.json';
const MIME = 'application/json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface DriveFile { id: string; name: string; modifiedTime?: string }
export interface SyncResult { message: string; lastSyncedAt: string; conflicts: number }

type Synced<T> = T & { syncId: string; updatedAt: string };
type PortableAccount = Omit<Synced<Account>, 'id'>;
type PortableBill = Omit<Synced<Bill>, 'id' | 'accountId' | 'paidTransactionId'> & {
  accountSyncId: string;
  paidTransactionSyncId?: string;
};
type PortableTransaction = Omit<Synced<Transaction>, 'id' | 'accountId' | 'toAccountId' | 'billId'> & {
  accountSyncId: string;
  toAccountSyncId?: string;
  billSyncId?: string;
};
type PortableSettings = Omit<Synced<ReminderSetting>, 'updatedAt'> & { updatedAt: string };
interface PortableSnapshot {
  format: 'pocket-ledger-sync';
  version: 1;
  updatedAt: string;
  writerId: string;
  accounts: PortableAccount[];
  bills: PortableBill[];
  transactions: PortableTransaction[];
  settings: PortableSettings | null;
}
interface DriveFileList { files?: DriveFile[] }
interface EncryptedEnvelope { format: 'pocket-ledger-encrypted-sync'; version: 1; kdf: 'PBKDF2-SHA-256'; iterations: number; salt: string; iv: string; ciphertext: string }
const PBKDF2_ITERATIONS = 310_000;

function uuid() { return crypto.randomUUID(); }
function withoutId<T extends { id?: number }>(record: T): Omit<T, 'id'> { const copy = { ...record }; delete copy.id; return copy; }
function now() { return new Date().toISOString(); }
function deviceId() {
  const key = 'pocket-ledger-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = uuid(); localStorage.setItem(key, id); }
  return id;
}
function authHeaders(token: string, json = false): HeadersInit {
  return { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}
async function driveRequest<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...authHeaders(token), ...(init.headers || {}) } });
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Google Drive request failed (${response.status}). ${details.slice(0, 240)}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function ensureSyncMetadata() {
  const stamp = now();
  await db.transaction('rw', db.accounts, db.transactions, db.bills, db.settings, async () => {
    for (const table of [db.accounts, db.transactions, db.bills] as const) {
      const rows = await table.toArray();
      for (const row of rows) {
        const item = row as typeof row & { syncId?: string; updatedAt?: string };
        if (!item.syncId || !item.updatedAt) {
          let stableId = item.syncId || uuid();
          if (table === db.accounts) {
            const account = row as Account;
            // Preserve identity for the two default accounts created by older starter builds.
            if (account.name === 'Cash') stableId = 'default-account-cash';
            else if (account.name === 'Bank account') stableId = 'default-account-bank';
          }
          await table.update(row.id!, { syncId: stableId, updatedAt: item.updatedAt || item.createdAt || stamp } as never);
        }
      }
    }
    const setting = await db.settings.get('main');
    if (setting && (!setting.syncId || !setting.updatedAt)) await db.settings.put({ ...setting, syncId: setting.syncId || 'main-settings', updatedAt: setting.updatedAt || stamp });
  });
}

async function makeLocalSnapshot(): Promise<PortableSnapshot> {
  await ensureSyncMetadata();
  const [accounts, transactions, bills, settings] = await Promise.all([
    db.accounts.toArray(), db.transactions.toArray(), db.bills.toArray(), db.settings.get('main')
  ]);
  const accountById = new Map(accounts.map(a => [a.id!, a.syncId!]));
  const txById = new Map(transactions.map(t => [t.id!, t.syncId!]));
  const billById = new Map(bills.map(b => [b.id!, b.syncId!]));
  return {
    format: 'pocket-ledger-sync', version: 1, updatedAt: now(), writerId: deviceId(),
    accounts: accounts.map(a => { const record = withoutId(a); return { ...record, syncId: a.syncId!, updatedAt: a.updatedAt || a.createdAt }; }),
    bills: bills.map(bill => { const { accountId, paidTransactionId, ...b } = withoutId(bill); return {
      ...b, syncId: bill.syncId!, updatedAt: bill.updatedAt || bill.createdAt,
      accountSyncId: accountById.get(accountId) || '',
      paidTransactionSyncId: paidTransactionId ? txById.get(paidTransactionId) : undefined,
    }; }),
    transactions: transactions.map(tx => { const { accountId, toAccountId, billId, ...t } = withoutId(tx); return {
      ...t, syncId: tx.syncId!, updatedAt: tx.updatedAt || tx.createdAt,
      accountSyncId: accountById.get(accountId) || '',
      toAccountSyncId: toAccountId ? accountById.get(toAccountId) : undefined,
      billSyncId: billId ? billById.get(billId) : undefined,
    }; }),
    settings: settings ? { ...settings, syncId: settings.syncId || 'main-settings', updatedAt: settings.updatedAt || stampFrom(settings) } : null,
  };
}
function stampFrom(setting: ReminderSetting) { return 'updatedAt' in setting && setting.updatedAt ? String(setting.updatedAt) : now(); }

function mergeRows<T extends { syncId: string; updatedAt: string }>(local: T[], remote: T[]): { rows: T[]; conflicts: number } {
  const byId = new Map<string, T>();
  let conflicts = 0;
  for (const row of local) byId.set(row.syncId, row);
  for (const row of remote) {
    const existing = byId.get(row.syncId);
    if (!existing) { byId.set(row.syncId, row); continue; }
    const localJson = JSON.stringify(existing);
    const remoteJson = JSON.stringify(row);
    if (localJson === remoteJson) continue;
    if (existing.updatedAt === row.updatedAt) {
      conflicts++;
      // Deterministic tie-break avoids different devices selecting different copies.
      byId.set(row.syncId, localJson.localeCompare(remoteJson) <= 0 ? existing : row);
    } else {
      byId.set(row.syncId, existing.updatedAt > row.updatedAt ? existing : row);
    }
  }
  return { rows: [...byId.values()], conflicts };
}

async function applyMergedSnapshot(snapshot: PortableSnapshot) {
  await db.transaction('rw', db.accounts, db.transactions, db.bills, db.settings, async () => {
    const localAccounts = await db.accounts.toArray();
    const accountIdBySync = new Map(localAccounts.filter(a => a.syncId).map(a => [a.syncId!, a.id!]));
    for (const a of snapshot.accounts) {
      const existingId = accountIdBySync.get(a.syncId);
      const { syncId, updatedAt, ...fields } = a;
      if (existingId !== undefined) await db.accounts.put({ ...fields, id: existingId, syncId, updatedAt } as Account);
      else {
        const id = await db.accounts.add({ ...fields, syncId, updatedAt } as Account);
        accountIdBySync.set(syncId, id);
      }
    }
    // Refresh map in case records were inserted above.
    for (const a of await db.accounts.toArray()) if (a.syncId) accountIdBySync.set(a.syncId, a.id!);

    const localBills = await db.bills.toArray();
    const billIdBySync = new Map(localBills.filter(b => b.syncId).map(b => [b.syncId!, b.id!]));
    for (const b of snapshot.bills) {
      const existingId = billIdBySync.get(b.syncId);
      const { syncId, updatedAt, accountSyncId, paidTransactionSyncId, ...fields } = b;
      const accountId = accountIdBySync.get(accountSyncId);
      if (!accountId) continue;
      const existing = existingId === undefined ? undefined : await db.bills.get(existingId);
      const record = { ...fields, id: existingId, syncId, updatedAt, accountId, paidTransactionId: existing?.paidTransactionId } as Bill;
      if (existingId !== undefined) await db.bills.put(record);
      else {
        const id = await db.bills.add(record);
        billIdBySync.set(syncId, id);
      }
    }
    for (const b of await db.bills.toArray()) if (b.syncId) billIdBySync.set(b.syncId, b.id!);

    const localTransactions = await db.transactions.toArray();
    const txIdBySync = new Map(localTransactions.filter(t => t.syncId).map(t => [t.syncId!, t.id!]));
    for (const t of snapshot.transactions) {
      const existingId = txIdBySync.get(t.syncId);
      const { syncId, updatedAt, accountSyncId, toAccountSyncId, billSyncId, ...fields } = t;
      const accountId = accountIdBySync.get(accountSyncId);
      if (!accountId) continue;
      const record = {
        ...fields, id: existingId, syncId, updatedAt, accountId,
        toAccountId: toAccountSyncId ? accountIdBySync.get(toAccountSyncId) : undefined,
        billId: billSyncId ? billIdBySync.get(billSyncId) : undefined,
      } as Transaction;
      if (existingId !== undefined) await db.transactions.put(record);
      else {
        const id = await db.transactions.add(record);
        txIdBySync.set(syncId, id);
      }
    }
    // Resolve paidTransactionId after transaction IDs are known.
    for (const b of snapshot.bills) {
      const localId = billIdBySync.get(b.syncId);
      if (!localId) continue;
      const paidId = b.paidTransactionSyncId ? txIdBySync.get(b.paidTransactionSyncId) : undefined;
      const localBill = await db.bills.get(localId);
      if (localBill && paidId && localBill.paidTransactionId !== paidId) await db.bills.update(localId, { paidTransactionId: paidId });
    }
    if (snapshot.settings) {
      const local = await db.settings.get('main');
      if (!local || snapshot.settings.updatedAt >= (local.updatedAt || '')) {
        const setting = { ...snapshot.settings };
        const updatedAt = setting.updatedAt;
        delete (setting as Partial<PortableSettings>).syncId;
        delete (setting as Partial<PortableSettings>).updatedAt;
        await db.settings.put({ ...setting, id: 'main', syncId: 'main-settings', updatedAt } as ReminderSetting);
      }
    }
  });
}

async function findSyncFile(token: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(`name = '${FILE_NAME}' and trashed = false`);
  const result = await driveRequest<DriveFileList>(`${DRIVE_API}/files?q=${q}&spaces=drive&pageSize=100&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`, token);
  return result.files?.[0] || null;
}
function toBase64(bytes: Uint8Array) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string) { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
async function deriveKey(passphrase: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptSnapshot(snapshot: PortableSnapshot, passphrase: string): Promise<EncryptedEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { format: 'pocket-ledger-encrypted-sync', version: 1, kdf: 'PBKDF2-SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
}
async function decryptSnapshot(envelope: EncryptedEnvelope, passphrase: string): Promise<PortableSnapshot> {
  if (envelope.format !== 'pocket-ledger-encrypted-sync' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA-256') throw new Error('The Drive file is not a supported encrypted Pocket Ledger sync file.');
  try {
    const key = await deriveKey(passphrase, fromBase64(envelope.salt));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.ciphertext));
    const data = JSON.parse(new TextDecoder().decode(plaintext)) as PortableSnapshot;
    if (data.format !== 'pocket-ledger-sync' || data.version !== 1 || !Array.isArray(data.accounts) || !Array.isArray(data.transactions) || !Array.isArray(data.bills)) throw new Error('invalid data');
    return data;
  } catch { throw new Error('Could not decrypt the Google Drive sync file. Check that you entered the same passphrase used on the other device. No local data was changed.'); }
}
async function readFile(token: string, id: string, passphrase: string): Promise<PortableSnapshot> {
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`Could not read the Pocket Ledger sync file (${response.status}).`);
  const data = await response.json() as EncryptedEnvelope;
  return decryptSnapshot(data, passphrase);
}
async function createSyncFile(token: string): Promise<DriveFile> {
  return driveRequest<DriveFile>(`${DRIVE_API}/files?fields=id,name,modifiedTime`, token, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ name: FILE_NAME, mimeType: MIME, description: 'Pocket Ledger private finance sync data' })
  });
}
async function uploadSnapshot(token: string, id: string, snapshot: EncryptedEnvelope) {
  const response = await fetch(`${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media`, {
    method: 'PATCH', headers: { ...authHeaders(token), 'Content-Type': MIME }, body: JSON.stringify(snapshot)
  });
  if (!response.ok) throw new Error(`Could not upload Pocket Ledger data (${response.status}).`);
}

export async function syncWithGoogleDrive(token: string, passphrase: string): Promise<SyncResult> {
  const local = await makeLocalSnapshot();
  let file = await findSyncFile(token);
  let remote: PortableSnapshot | null = null;
  let initialModifiedTime: string | undefined;
  if (file) {
    initialModifiedTime = file.modifiedTime;
    remote = await readFile(token, file.id, passphrase);
  }
  const mergedAccounts = mergeRows(local.accounts, remote?.accounts || []);
  const mergedBills = mergeRows(local.bills, remote?.bills || []);
  const mergedTransactions = mergeRows(local.transactions, remote?.transactions || []);
  const settings = local.settings && remote?.settings
    ? (local.settings.updatedAt >= remote.settings.updatedAt ? local.settings : remote.settings)
    : local.settings || remote?.settings || null;
  const conflicts = mergedAccounts.conflicts + mergedBills.conflicts + mergedTransactions.conflicts;
  const merged: PortableSnapshot = {
    format: 'pocket-ledger-sync', version: 1, updatedAt: now(), writerId: deviceId(),
    accounts: mergedAccounts.rows, bills: mergedBills.rows, transactions: mergedTransactions.rows, settings
  };

  // Recheck the cloud revision before uploading to reduce accidental overwrites from concurrent devices.
  if (file) {
    const latest = await findSyncFile(token);
    if (!latest || (initialModifiedTime && latest.modifiedTime && latest.modifiedTime !== initialModifiedTime)) {
      throw new Error('The Google Drive sync file changed on another device during this sync. Tap Sync now again to merge the latest changes safely.');
    }
  } else {
    file = await createSyncFile(token);
  }
  const encrypted = await encryptSnapshot(merged, passphrase);
  await uploadSnapshot(token, file.id, encrypted);
  await applyMergedSnapshot(merged);
  const syncedAt = now();
  localStorage.setItem('pocket-ledger-last-sync', syncedAt);
  return { message: conflicts ? `Synced with ${conflicts} same-time conflict(s) resolved deterministically. Review recent records if both devices edited the same item.` : 'Google Drive sync completed.', lastSyncedAt: syncedAt, conflicts };
}

export function requestGoogleDriveToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google sign-in library did not load. Check your internet connection and reload the app.'));
      return;
    }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => response.error ? reject(new Error(response.error_description || response.error)) : response.access_token ? resolve(response.access_token) : reject(new Error('Google did not return an access token.')),
      error_callback: error => reject(new Error(error.message || 'Google sign-in was cancelled.')),
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
}

export function getGoogleClientId() { return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || ''; }
export function getLastSyncAt() { return localStorage.getItem('pocket-ledger-last-sync'); }
