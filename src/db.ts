import Dexie, { type EntityTable } from 'dexie';

export type TxKind = 'income' | 'expense' | 'transfer';
export interface Account { id?: number; name: string; openingBalance: number; createdAt: string; syncId?: string; updatedAt?: string }
export interface Transaction {
  id?: number; kind: TxKind; amount: number; category: string; date: string; note: string;
  accountId: number; toAccountId?: number; billId?: number; createdAt: string; syncId?: string; updatedAt?: string;
}
export interface Bill {
  id?: number; name: string; category: string; amount: number; dueDate: string;
  recurrence: 'once' | 'monthly' | 'yearly'; status: 'upcoming' | 'paid'; accountId: number;
  paidTransactionId?: number; lastNotifiedDate?: string; createdAt: string; syncId?: string; updatedAt?: string;
}
export interface ReminderSetting { id: 'main'; dailyEnabled: boolean; dailyTime: string; billsEnabled: boolean; daysBefore: number; syncId?: string; updatedAt?: string }

class LedgerDB extends Dexie {
  accounts!: EntityTable<Account, 'id'>;
  transactions!: EntityTable<Transaction, 'id'>;
  bills!: EntityTable<Bill, 'id'>;
  settings!: EntityTable<ReminderSetting, 'id'>;
  constructor() {
    super('pocket-ledger');
    this.version(1).stores({
      accounts: '++id, name',
      transactions: '++id, date, kind, category, accountId, billId',
      bills: '++id, dueDate, status, category',
      settings: 'id'
    });
  }
}
export const db = new LedgerDB();
export async function initializeDb() {
  if ((await db.accounts.count()) === 0) {
    await db.accounts.bulkAdd([
      { name: 'Cash', openingBalance: 0, createdAt: new Date().toISOString(), syncId: 'default-account-cash', updatedAt: new Date().toISOString() },
      { name: 'Bank account', openingBalance: 0, createdAt: new Date().toISOString(), syncId: 'default-account-bank', updatedAt: new Date().toISOString() }
    ]);
  }
  if (!(await db.settings.get('main'))) await db.settings.put({ id: 'main', dailyEnabled: true, dailyTime: '20:30', billsEnabled: true, daysBefore: 3, syncId: 'main-settings', updatedAt: new Date().toISOString() });
}
