document.addEventListener('DOMContentLoaded', () => {
    const API_BASE = '/api';

    // ── Auth guard — only runs on /dashboard ─────────────────────────────────
    const token = localStorage.getItem('nexbank_token');
    const role  = localStorage.getItem('nexbank_role');
    const user  = localStorage.getItem('nexbank_user');

    if (!token) {
        window.location.replace('/');
        return;
    }

    // Show logged-in user
    const userNameEl = document.querySelector('.user-name');
    if (userNameEl) userNameEl.textContent = `${user} (${role})`;

    // Logout
    document.getElementById('logout-btn')?.addEventListener('click', () => {
        localStorage.clear();
        window.location.replace('/');
    });

    // Hide admin-only nav items for customer role
    if (role !== 'admin') {
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    }

    // ── Authenticated fetch — no redirect loop ────────────────────────────────
    let redirecting = false;
    async function apiFetch(url, options = {}) {
        const res = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(options.headers || {})
            }
        });
        if (res.status === 401 && !redirecting) {
            redirecting = true;
            localStorage.clear();
            window.location.replace('/');
        }
        return res;
    }

    // ── Sidebar navigation ────────────────────────────────────────────────────
    const navLinks = document.querySelectorAll('.nav-link');
    const views    = document.querySelectorAll('.view');
    const sidebar  = document.getElementById('sidebar');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navLinks.forEach(n => n.classList.remove('active'));
            views.forEach(v => v.classList.remove('active'));
            link.classList.add('active');
            const target = document.getElementById(link.getAttribute('data-target'));
            if (target) target.classList.add('active');
            if (window.innerWidth <= 768) sidebar?.classList.remove('open');
            if (link.getAttribute('data-target') === 'dashboard-view') updateDashboard();
        });
    });

    document.getElementById('menu-btn')?.addEventListener('click', () => sidebar?.classList.toggle('open'));

    // ── Toast notifications ───────────────────────────────────────────────────
    function showNotification(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `notification-toast ${type}`;
        const icon = type === 'error' ? 'fa-circle-xmark' : 'fa-circle-check';
        toast.innerHTML = `<i class="fa-solid ${icon}"></i> ${message}`;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 4000);
    }

    // ── Dashboard stats ───────────────────────────────────────────────────────
    async function updateDashboard() {
        try {
            const res = await apiFetch(`${API_BASE}/dashboard/stats`);
            if (!res.ok) return;
            const data = await res.json();
            document.getElementById('tot-customers').textContent = data.totCustomers ?? 0;
            document.getElementById('tot-accounts').textContent  = data.totAccounts  ?? 0;
            document.getElementById('tot-balance').textContent   = `$${Number(data.totBalance || 0).toLocaleString()}`;
            document.getElementById('tot-loans').textContent     = data.totLoans     ?? 0;
        } catch (err) { console.error('Dashboard error:', err); }
    }

    // ── Refresh accounts table after balance-changing ops ─────────────────────
    async function refreshAccounts() {
        const tbody = document.getElementById('account-tbody');
        if (!tbody) return;
        try {
            const res  = await apiFetch(`${API_BASE}/accounts`);
            if (!res.ok) return;
            const json = await res.json();
            const data = Array.isArray(json) ? json : (json.data ?? []);
            tbody.innerHTML = '';
            if (!data.length) {
                tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No records found.</td></tr>`;
                return;
            }
            data.forEach(item => {
                const tr = document.createElement('tr');
                ['id', 'type', 'balance', 'customerId'].forEach(col => {
                    const td = document.createElement('td');
                    td.textContent = item[col] !== undefined ? item[col] : '-';
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
        } catch (err) { console.error('refreshAccounts error:', err); }
    }

    // ── Generic module setup ──────────────────────────────────────────────────
    function setupBankModule(config) {
        const form  = document.getElementById(config.formId);
        const tbody = document.getElementById(config.tableBodyId);

        const renderTable = async () => {
            if (!tbody) return;
            try {
                const res  = await apiFetch(`${API_BASE}/${config.endpoint}`);
                if (!res.ok) return;
                const json = await res.json();
                const data = Array.isArray(json) ? json : (json.data ?? []);
                tbody.innerHTML = '';
                if (!data.length) {
                    tbody.innerHTML = `<tr><td colspan="${config.columns.length}" style="text-align:center;color:var(--text-muted)">No records found.</td></tr>`;
                    return;
                }
                data.forEach(item => {
                    const tr = document.createElement('tr');
                    config.columns.forEach(col => {
                        const td = document.createElement('td');
                        td.textContent = item[col] !== undefined ? item[col] : '-';
                        tr.appendChild(td);
                    });
                    tbody.appendChild(tr);
                });
            } catch (err) { console.error(`Error loading ${config.moduleName}:`, err); }
        };

        renderTable();

        form?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newItem = Object.fromEntries(new FormData(form).entries());
            try {
                const res  = await apiFetch(`${API_BASE}/${config.endpoint}`, {
                    method: 'POST',
                    body: JSON.stringify(newItem)
                });
                const data = await res.json();
                if (res.ok) {
                    showNotification(data.message || `${config.moduleName} saved!`);
                    form.reset();
                    renderTable();
                    updateDashboard();
                    if (['transactions', 'payments', 'loans'].includes(config.endpoint)) {
                        refreshAccounts();
                    }
                } else {
                    showNotification(data.error || `Failed to save ${config.moduleName}.`, 'error');
                }
            } catch {
                showNotification('Backend connection error.', 'error');
            }
        });
    }

    // ── Module definitions ────────────────────────────────────────────────────
    const modules = [
        { moduleName: 'Customer',    formId: 'customer-form',    tableBodyId: 'customer-tbody',    endpoint: 'customers',    columns: ['id', 'name', 'dob', 'phone', 'address'] },
        { moduleName: 'Account',     formId: 'account-form',     tableBodyId: 'account-tbody',     endpoint: 'accounts',     columns: ['id', 'type', 'balance', 'customerId'] },
        { moduleName: 'Transaction', formId: 'transaction-form', tableBodyId: 'transaction-tbody', endpoint: 'transactions', columns: ['id', 'date', 'amount', 'mode', 'accountId'] },
        { moduleName: 'Loan',        formId: 'loan-form',        tableBodyId: 'loan-tbody',        endpoint: 'loans',        columns: ['id', 'amount', 'type', 'interest', 'issueDate', 'dueDate', 'status', 'customerId'] },
        { moduleName: 'Payment',     formId: 'payment-form',     tableBodyId: 'payment-tbody',     endpoint: 'payments',     columns: ['id', 'loanId', 'amount'] },
        { moduleName: 'Employee',    formId: 'employee-form',    tableBodyId: 'employee-tbody',    endpoint: 'employees',    columns: ['id', 'name', 'salary'] },
        { moduleName: 'Branch',      formId: 'branch-form',      tableBodyId: 'bank-tbody',        endpoint: 'branches',     columns: ['branchId', 'bankId', 'bankName', 'city'] }
    ];

    modules.forEach(setupBankModule);
    updateDashboard();
});
