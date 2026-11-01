import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell, CalendarClock, Check, ChevronRight, CircleDollarSign, LayoutDashboard, Plus, ReceiptText, Settings, ShieldCheck, Wallet, X } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db, initializeDb, type Account, type Bill, type Transaction, type TxKind } from './db';
import { getGoogleClientId, getLastSyncAt, requestGoogleDriveToken, syncWithGoogleDrive } from './driveSync';

type Tab = 'Overview' | 'Transactions' | 'Bills' | 'Settings';
const categories = ['Salary','Freelance','Investment income','Groceries','Housing / Rent','Utilities','Transport','Dining','Shopping','Healthcare','Education','Entertainment','Insurance','EMI interest','Other'];
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const money = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
const monthKey = (d: string) => d.slice(0, 7);

export default function App() {
  const [tab, setTab] = useState<Tab>('Overview');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [settings, setSettings] = useState({ dailyEnabled: true, dailyTime: '20:30', billsEnabled: true, daysBefore: 3 });
  const [modal, setModal] = useState<'transaction'|'bill'|null>(null);
  const [kind, setKind] = useState<TxKind>('expense');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncPassphrase, setSyncPassphrase] = useState('');
  const [driveToken, setDriveToken] = useState<string | null>(null);
  const googleClientId = getGoogleClientId();

  async function refresh() {
    const [a, t, b, s] = await Promise.all([db.accounts.toArray(), db.transactions.orderBy('date').reverse().toArray(), db.bills.orderBy('dueDate').toArray(), db.settings.get('main')]);
    setAccounts(a); setTransactions(t); setBills(b);
    if (s) setSettings({ dailyEnabled: s.dailyEnabled, dailyTime: s.dailyTime, billsEnabled: s.billsEnabled, daysBefore: s.daysBefore });
  }
  useEffect(() => { initializeDb().then(refresh).then(() => { setLastSyncedAt(getLastSyncAt()); setReady(true); }); const openAdd = () => { setKind('expense'); setModal('transaction'); }; window.addEventListener('add-transaction', openAdd); return () => window.removeEventListener('add-transaction', openAdd); }, []);

  useEffect(() => {
    if (!ready || !driveToken || syncPassphrase.length < 12) return;
    let running = false;
    const runAutoSync = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const result = await syncWithGoogleDrive(driveToken, syncPassphrase);
        setLastSyncedAt(result.lastSyncedAt);
        await refresh();
      } catch (error) {
        setNotice(error instanceof Error ? `Auto-sync paused: ${error.message}` : 'Auto-sync paused. Open Settings and sync again.');
      } finally { running = false; }
    };
    const timer = window.setInterval(runAutoSync, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', runAutoSync);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', runAutoSync); };
  }, [ready, driveToken, syncPassphrase]);

  const currentMonth = today().slice(0, 7);
  const monthTx = transactions.filter(t => monthKey(t.date) === currentMonth);
  const income = monthTx.filter(t => t.kind === 'income').reduce((s,t) => s+t.amount,0);
  const expense = monthTx.filter(t => t.kind === 'expense').reduce((s,t) => s+t.amount,0);
  const accountBalances = useMemo(() => accounts.map(a => ({...a, balance: a.openingBalance + transactions.reduce((sum,t) => {
    if (t.kind === 'transfer') return sum + (t.accountId === a.id ? -t.amount : t.toAccountId === a.id ? t.amount : 0);
    return sum + (t.accountId === a.id ? (t.kind === 'income' ? t.amount : -t.amount) : 0);
  },0)})), [accounts, transactions]);
  const totalBalance = accountBalances.reduce((s,a) => s+a.balance,0);
  const upcoming = bills.filter(b => b.status === 'upcoming').sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  const chartData = Array.from({length: 6}, (_,i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5-i)); const key = d.toISOString().slice(0,7);
    const items = transactions.filter(t => monthKey(t.date) === key);
    return { month: d.toLocaleDateString('en-IN',{month:'short'}), Income: items.filter(t=>t.kind==='income').reduce((s,t)=>s+t.amount,0), Expenses: items.filter(t=>t.kind==='expense').reduce((s,t)=>s+t.amount,0) };
  });

  useEffect(() => {
    if (!ready) return;
    const check = async () => {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const now = new Date(); const date = today();
      const latest = await db.settings.get('main');
      if (latest?.dailyEnabled && now.toTimeString().slice(0,5) >= latest.dailyTime) {
        const key = `daily-reminder-${date}`;
        if (localStorage.getItem(key) !== 'sent') { new Notification('Pocket Ledger', { body: 'Take a minute to log today’s income and expenses.' }); localStorage.setItem(key,'sent'); }
      }
      if (latest?.billsEnabled) {
        const all = await db.bills.where('status').equals('upcoming').toArray();
        for (const bill of all) {
          const days = Math.ceil((new Date(`${bill.dueDate}T00:00:00`).getTime() - new Date(`${date}T00:00:00`).getTime()) / 86400000);
          const key = `bill-reminder-${bill.id}-${date}`;
          if (days >= 0 && days <= latest.daysBefore && localStorage.getItem(key) !== 'sent') {
            new Notification(`Bill due: ${bill.name}`, { body: `${money(bill.amount)} due ${days === 0 ? 'today' : `in ${days} day(s)`}.` }); localStorage.setItem(key,'sent');
          }
        }
      }
    };
    check(); const timer = window.setInterval(check, 60_000); document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [ready]);

  async function saveTransaction(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const amount = Number(f.get('amount')); const accountId = Number(f.get('accountId'));
    if (!Number.isFinite(amount) || amount <= 0 || !accountId) return;
    const createdAt = new Date().toISOString();
    const record: Transaction = { kind, amount, accountId, category: kind === 'transfer' ? 'Transfer' : String(f.get('category')), date: String(f.get('date')), note: String(f.get('note') || ''), toAccountId: kind === 'transfer' ? Number(f.get('toAccountId')) : undefined, createdAt, syncId: crypto.randomUUID(), updatedAt: createdAt };
    if (kind === 'transfer' && (!record.toAccountId || record.toAccountId === accountId)) { setNotice('Choose two different accounts for a transfer.'); return; }
    await db.transactions.add(record); setModal(null); setNotice('Transaction saved on this device.'); await refresh();
  }
  async function saveBill(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const amount = Number(f.get('amount'));
    if (amount <= 0 || !Number(f.get('accountId'))) return;
    const createdAt = new Date().toISOString();
    await db.bills.add({ name: String(f.get('name')), category: String(f.get('category')), amount, dueDate: String(f.get('dueDate')), recurrence: String(f.get('recurrence')) as Bill['recurrence'], status: 'upcoming', accountId: Number(f.get('accountId')), createdAt, syncId: crypto.randomUUID(), updatedAt: createdAt });
    setModal(null); setNotice('Bill saved.'); await refresh();
  }
  async function payBill(bill: Bill) {
    if (bill.status === 'paid' || !bill.id) return;
    await db.transaction('rw', db.bills, db.transactions, async () => {
      const latest = await db.bills.get(bill.id!);
      if (!latest || latest.status === 'paid') return;
      const stamp = new Date().toISOString();
      const txId = await db.transactions.add({ kind:'expense', amount:latest.amount, category:latest.category, date:today(), note:`Bill payment: ${latest.name}`, accountId:latest.accountId, billId:latest.id, createdAt:stamp, syncId:crypto.randomUUID(), updatedAt:stamp });
      await db.bills.update(latest.id!, { status:'paid', paidTransactionId: txId as number, updatedAt:stamp });
    });
    setNotice(`${bill.name} marked paid and recorded as one expense.`); await refresh();
  }
  async function enableNotifications() {
    if (!('Notification' in window)) { setNotice('Notifications are not supported in this browser.'); return; }
    const result = await Notification.requestPermission(); setNotice(result === 'granted' ? 'Notifications enabled. Keep this app open or recently active for reminders.' : 'Notification permission was not granted.');
  }
  async function saveSettings(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const next = { id:'main' as const, dailyEnabled:f.get('dailyEnabled')==='on', dailyTime:String(f.get('dailyTime')), billsEnabled:f.get('billsEnabled')==='on', daysBefore:Number(f.get('daysBefore')), syncId:'main-settings', updatedAt:new Date().toISOString() };
    await db.settings.put(next); setSettings({ dailyEnabled:next.dailyEnabled, dailyTime:next.dailyTime, billsEnabled:next.billsEnabled, daysBefore:next.daysBefore }); setNotice('Reminder settings saved on this device.');
  }
  async function syncDrive() {
    if (!googleClientId) { setNotice('Google Drive is not configured yet. Add VITE_GOOGLE_CLIENT_ID to your .env.local file, then restart the app.'); return; }
    if (syncPassphrase.length < 12) { setNotice('Choose a sync passphrase of at least 12 characters and use the same passphrase on both devices.'); return; }
    setSyncing(true);
    try {
      const token = await requestGoogleDriveToken(googleClientId);
      setDriveToken(token);
      const result = await syncWithGoogleDrive(token, syncPassphrase);
      await refresh(); setLastSyncedAt(result.lastSyncedAt); setNotice(result.message);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Google Drive sync failed. Please try again.'); }
    finally { setSyncing(false); }
  }
  async function exportData() {
    const data = { exportedAt:new Date().toISOString(), accounts:await db.accounts.toArray(), transactions:await db.transactions.toArray(), bills:await db.bills.toArray(), settings:await db.settings.toArray() };
    const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=`pocket-ledger-backup-${today()}.json`; a.click(); URL.revokeObjectURL(url);
  }
  if (!ready) return <div className="loading">Opening your private ledger…</div>;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-icon"><Wallet size={22}/></div><div><b>Pocket Ledger</b><small>Personal finance, privately</small></div></div>
      <nav>{([{name:'Overview',icon:LayoutDashboard},{name:'Transactions',icon:ArrowLeftRight},{name:'Bills',icon:ReceiptText},{name:'Settings',icon:Settings}] as const).map(item=><button key={item.name} className={`nav-item ${tab===item.name?'active':''}`} onClick={()=>setTab(item.name)}><item.icon size={18}/>{item.name}<ChevronRight className="nav-chevron" size={15}/></button>)}</nav>
      <div className="privacy-note"><ShieldCheck size={17}/><div><b>Local-first storage</b><p>Records stay on this device until you choose to sync them to your Google Drive.</p></div></div>
      <div className="sidebar-bottom">POCKET LEDGER <span>•</span> v0.1</div>
    </aside>
    <main className="main"><header className="topbar"><div><div className="eyebrow">YOUR MONEY, AT A GLANCE</div><h1>{tab==='Overview'?'Overview':tab}</h1></div><div className="header-actions"><span className="local-pill"><span/> {lastSyncedAt ? 'Drive synced' : 'Stored locally'}</span><button className="icon-button" title="Enable notifications" onClick={enableNotifications}><Bell size={18}/></button><button className="primary" onClick={()=>{setKind('expense');setModal('transaction')}}><Plus size={17}/> Add transaction</button></div></header>
      {notice && <div className="notice" role="status">{notice}<button onClick={()=>setNotice('')}><X size={15}/></button></div>}
      {tab==='Overview' && <>
        <div className="welcome-row"><div><h2>Good {new Date().getHours()<12?'morning':new Date().getHours()<17?'afternoon':'evening'} 👋</h2><p>Here’s how your finances are looking this month.</p></div><div className="date-label"><CalendarClock size={16}/>{new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</div></div>
        <section className="stats-grid"><Stat icon={<Wallet/>} label="Total account balance" value={money(totalBalance)} note={`${accounts.length} accounts`} tone="teal"/><Stat icon={<ArrowDownLeft/>} label="Income this month" value={money(income)} note="Money received" tone="green"/><Stat icon={<ArrowUpRight/>} label="Expenses this month" value={money(expense)} note="Money spent" tone="orange"/><Stat icon={<Activity/>} label="Net cash flow" value={money(income-expense)} note="Income minus expenses" tone={income-expense>=0?'green':'orange'}/></section>
        <section className="content-grid"><div className="panel chart-panel"><div className="panel-heading"><div><h3>Cash flow</h3><p>Income vs expenses · last 6 months</p></div><span className="subtle-tag">Monthly</span></div><div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} barGap={5}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e9eeed"/><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fill:'#87938f',fontSize:12}}/><YAxis axisLine={false} tickLine={false} tick={{fill:'#87938f',fontSize:11}} tickFormatter={v=>v>=1000?`₹${v/1000}k`:`₹${v}`}/><Tooltip formatter={(v)=>money(Number(v))}/><Bar dataKey="Income" fill="#0f9b82" radius={[5,5,0,0]}/><Bar dataKey="Expenses" fill="#f59e63" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></div><div className="chart-legend"><span><i className="dot income-dot"/> Income</span><span><i className="dot expense-dot"/> Expenses</span></div></div>
          <div className="panel"><div className="panel-heading"><div><h3>Upcoming payments</h3><p>Keep ahead of your due dates</p></div><button className="text-button" onClick={()=>setTab('Bills')}>View all <ChevronRight size={15}/></button></div>{upcoming.length===0?<Empty icon={<CalendarClock/>} title="Nothing due yet" text="Add a bill to keep track of payments." action="Add bill" onClick={()=>setModal('bill')}/>:<div className="bill-list">{upcoming.slice(0,4).map(b=><div className="bill-row" key={b.id}><div className="bill-icon"><ReceiptText size={17}/></div><div className="bill-info"><b>{b.name}</b><small>Due {new Date(`${b.dueDate}T00:00:00`).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</small></div><div className="bill-amount"><b>{money(b.amount)}</b><small className={b.dueDate<today()?'overdue':'due'}>{b.dueDate<today()?'Overdue':'Upcoming'}</small></div></div>)}</div>}<button className="secondary full-button" onClick={()=>setModal('bill')}><Plus size={16}/> Add a bill</button></div></section>
        <section className="panel recent-panel"><div className="panel-heading"><div><h3>Recent transactions</h3><p>Your latest money movements</p></div><button className="text-button" onClick={()=>setTab('Transactions')}>All transactions <ChevronRight size={15}/></button></div><TransactionTable transactions={transactions.slice(0,5)} accounts={accounts}/></section>
      </>}
      {tab==='Transactions' && <section className="panel page-panel"><div className="panel-heading"><div><h3>Transaction history</h3><p>Income, expenses, and account transfers</p></div><button className="primary" onClick={()=>{setKind('expense');setModal('transaction')}}><Plus size={16}/> Add transaction</button></div><TransactionTable transactions={transactions} accounts={accounts}/></section>}
      {tab==='Bills' && <section className="panel page-panel"><div className="panel-heading"><div><h3>Bills & recurring payments</h3><p>Track utilities and payment due dates</p></div><button className="primary" onClick={()=>setModal('bill')}><Plus size={16}/> Add bill</button></div>{bills.length===0?<Empty icon={<ReceiptText/>} title="No bills added" text="Start with electricity, internet, rent, or an EMI." action="Add your first bill" onClick={()=>setModal('bill')}/>:<div className="table-wrap"><table><thead><tr><th>Bill</th><th>Due date</th><th>Frequency</th><th>Amount</th><th>Status</th><th/></tr></thead><tbody>{bills.map(b=><tr key={b.id}><td><b>{b.name}</b><small className="cell-sub">{b.category}</small></td><td>{new Date(`${b.dueDate}T00:00:00`).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</td><td className="capitalize">{b.recurrence}</td><td className="amount-cell">{money(b.amount)}</td><td><span className={`status ${b.status==='paid'?'status-paid':b.dueDate<today()?'status-overdue':'status-pending'}`}>{b.status==='paid'?'Paid':b.dueDate<today()?'Overdue':'Upcoming'}</span></td><td>{b.status==='upcoming'&&<button className="small-button" onClick={()=>payBill(b)}><Check size={14}/> Mark paid</button>}</td></tr>)}</tbody></table></div>}</section>}
      {tab==='Settings' && <section className="panel page-panel settings-panel"><div className="panel-heading"><div><h3>Settings & data</h3><p>Manage reminders and keep your data safe</p></div></div><form onSubmit={saveSettings} className="settings-form"><h4><Bell size={17}/> Reminder preferences</h4><label className="check-row"><input type="checkbox" name="dailyEnabled" defaultChecked={settings.dailyEnabled}/> Daily reminder to log transactions</label><label>Reminder time<input name="dailyTime" type="time" defaultValue={settings.dailyTime}/></label><label className="check-row"><input type="checkbox" name="billsEnabled" defaultChecked={settings.billsEnabled}/> Remind me about upcoming bills</label><label>Remind me this many days before due date<input name="daysBefore" type="number" min="0" max="30" defaultValue={settings.daysBefore}/></label><button className="primary" type="submit">Save preferences</button></form><div className="settings-divider"/><div className="backup-row"><div><h4>Google Drive sync</h4><p>{googleClientId ? 'Connect your Google account to sync now and automatically every 5 minutes while this app is open.' : 'Google Drive needs a one-time OAuth client ID setup before it can sync.'}{lastSyncedAt ? ` Last synced ${new Date(lastSyncedAt).toLocaleString('en-IN')}.` : ''}</p><label className="sync-passphrase-label">Encryption passphrase<input className="sync-passphrase" type="password" autoComplete="current-password" minLength={12} value={syncPassphrase} onChange={e=>setSyncPassphrase(e.target.value)} placeholder="At least 12 characters"/><small>Used to encrypt your sync file before upload. Not saved; use the same passphrase on both devices. If you lose it, the cloud copy cannot be decrypted.</small></label></div><button className="primary" onClick={syncDrive} disabled={syncing || !googleClientId}>{syncing ? 'Syncing…' : 'Connect & sync'}</button></div><div className="settings-divider"/><div className="backup-row"><div><h4>Local data backup</h4><p>Export accounts, transactions, bills, and settings as a JSON backup file.</p></div><button className="secondary" onClick={exportData}>Export backup</button></div><div className="security-callout"><ShieldCheck size={20}/><div><b>Your data stays local unless you sync</b><p>Google Drive sync uploads an end-to-end encrypted Pocket Ledger JSON file to the Google account you authorize. Encryption uses your passphrase and AES-GCM; the passphrase and access token are not saved. Use the same Google account, OAuth app, and passphrase on both devices. Browser data can still be lost if site data is cleared, so export backups regularly.</p></div></div></section>}
      <footer>Made for mindful money management <span>·</span> INR <span>·</span> Local-first</footer>
    </main>
    {modal && <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="modal" role="dialog" aria-modal="true"><div className="modal-header"><div><h2>{modal==='transaction'?'Add transaction':'Add bill or payment'}</h2><p>Saved locally on this device. Sync to Google Drive from Settings.</p></div><button className="icon-button" onClick={()=>setModal(null)}><X size={18}/></button></div>{modal==='transaction'?<form onSubmit={saveTransaction} className="modal-form"><div className="segmented">{(['expense','income','transfer'] as TxKind[]).map(k=><button type="button" className={kind===k?'selected':''} onClick={()=>setKind(k)} key={k}>{k==='expense'?'Expense':k==='income'?'Income':'Transfer'}</button>)}</div><label>Amount (₹)<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required autoFocus/></label><div className="form-grid"><label>Date<input name="date" type="date" defaultValue={today()} required/></label><label>{kind==='transfer'?'From account':'Account'}<select name="accountId" required>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>{kind==='transfer'?<label>To account<select name="toAccountId" required>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>:<label>Category<select name="category" required>{categories.filter(c=>kind==='income'?['Salary','Freelance','Investment income','Other'].includes(c):!['Salary','Freelance','Investment income'].includes(c)).map(c=><option key={c}>{c}</option>)}</select></label>}<label>Note (optional)<input name="note" placeholder="What was this for?"/></label><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setModal(null)}>Cancel</button><button type="submit" className="primary">Save transaction</button></div></form>:<form onSubmit={saveBill} className="modal-form"><label>Bill name<input name="name" placeholder="e.g. Electricity bill" required autoFocus/></label><div className="form-grid"><label>Amount (₹)<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"/></label><label>Due date<input name="dueDate" type="date" defaultValue={today()} required/></label></div><div className="form-grid"><label>Category<select name="category">{['Utilities','Housing / Rent','EMI','Credit card','Insurance','Mobile / Internet','Subscription','Other'].map(c=><option key={c}>{c}</option>)}</select></label><label>Repeats<select name="recurrence"><option value="once">One time</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label></div><label>Pay from account<select name="accountId" required>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><p className="form-hint">Marking a bill as paid creates exactly one linked expense transaction. Recurrence is recorded for now; automatic generation of future occurrences is a planned enhancement.</p><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setModal(null)}>Cancel</button><button type="submit" className="primary">Save bill</button></div></form>}</section></div>}
  </div>;
}
function Stat({icon,label,value,note,tone}:{icon:React.ReactNode;label:string;value:string;note:string;tone:string}) { return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong><span className="stat-note">{note}</span></div> }
function Empty({icon,title,text,action,onClick}:{icon:React.ReactNode;title:string;text:string;action:string;onClick:()=>void}) { return <div className="empty"><div className="empty-icon">{icon}</div><b>{title}</b><p>{text}</p><button className="text-button" onClick={onClick}>{action} <ChevronRight size={15}/></button></div> }
function TransactionTable({transactions,accounts}:{transactions:Transaction[];accounts:Account[]}) { if(!transactions.length)return <Empty icon={<CircleDollarSign/>} title="No transactions yet" text="Your transactions will appear here once you add them." action="Add a transaction" onClick={()=>window.dispatchEvent(new CustomEvent('add-transaction'))}/>; return <div className="table-wrap"><table><thead><tr><th>Transaction</th><th>Category</th><th>Date</th><th>Account</th><th className="right">Amount</th></tr></thead><tbody>{transactions.map(t=><tr key={t.id}><td><div className="transaction-title"><span className={`tx-icon ${t.kind}`}>{t.kind==='income'?<ArrowDownLeft size={16}/>:t.kind==='transfer'?<ArrowLeftRight size={16}/>:<ArrowUpRight size={16}/>}</span><div><b>{t.note||t.category}</b><small className="cell-sub">{t.kind==='income'?'Income':t.kind==='transfer'?'Account transfer':'Expense'}</small></div></div></td><td><span className="category-pill">{t.category}</span></td><td>{new Date(`${t.date}T00:00:00`).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</td><td>{accounts.find(a=>a.id===t.accountId)?.name||'Account'}{t.kind==='transfer'&&t.toAccountId?` → ${accounts.find(a=>a.id===t.toAccountId)?.name||'Account'}`:''}</td><td className={`right amount-cell ${t.kind==='income'?'positive':t.kind==='expense'?'negative':''}`}>{t.kind==='income'?'+':t.kind==='expense'?'-':''}{money(t.amount)}</td></tr>)}</tbody></table></div> }
