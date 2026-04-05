import { createAuth0Client } from '@auth0/auth0-spa-js';

// Global state
let auth0Client = null;

const configureClient = async () => {
    auth0Client = await createAuth0Client({
        domain: "dev-zikssz2t00xvnfuk.us.auth0.com",
        clientId: "n7wZPtccmdVmRblafnDT5x3ftMB5mqN8",
        authorizationParams: {
            audience: "https://dev-zikssz2t00xvnfuk.us.auth0.com/api/v2/",
            redirect_uri: window.location.origin
        },
        cacheLocation: 'localstorage'
    });
};

window.switchTab = (tabId) => {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.style.display = 'none';
        tab.classList.remove('active');
    });
    const target = document.getElementById(`tab-${tabId}`);
    if (target) {
        target.style.display = 'block';
        setTimeout(() => target.classList.add('active'), 10);
    }
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.innerText.toLowerCase().includes(tabId.charAt(0))) {
            item.classList.add('active');
        }
    });
};

window.toggleLogger = () => {
    const modal = document.getElementById('logger-modal');
    modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
};

window.logQuick = async (type) => {
    let payload = {};
    if (type === 'Food') payload = { label: 'Healthy Meal', value: 2.8, icon: 'utensils', intensity: 'Low' };
    if (type === 'Transport') payload = { label: 'Commute (EV)', value: 1.2, icon: 'car', intensity: 'Low' };
    if (type === 'Shopping') payload = { label: 'Eco Purchase', value: 0.8, icon: 'shopping-bag', intensity: 'Low' };

    try {
        const token = await auth0Client.getTokenSilently();
        const res = await fetch('/api/log', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            toggleLogger();
            refreshData();
        }
    } catch (err) {
        console.error("Failed to log activity:", err);
    }
};

const refreshData = async () => {
    try {
        const token = await auth0Client.getTokenSilently();
        const response = await fetch('/api/carbon', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Server error ${response.status}`);
        }
        const data = await response.json();
        renderData(data);
        
        // Also refresh receipt history
        fetchReceipts();
    } catch (err) {
        console.error("Data refresh failed:", err);
    }
};

const fetchReceipts = async () => {
    try {
        const token = await auth0Client.getTokenSilently();
        const response = await fetch('/api/receipts', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const receipts = await response.json();
        renderReceiptHistory(receipts);
    } catch (err) {
        console.error("Failed to fetch receipts:", err);
    }
};

const renderReceiptHistory = (receipts) => {
    const history = document.getElementById('receipt-history');
    if (!history) return;

    if (receipts.length === 0) {
        history.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-dim); font-size: 14px;">No receipts scanned yet.</div>`;
        return;
    }

    history.innerHTML = receipts.map(r => `
        <div class="card" style="padding:12px; display:flex; align-items:center; gap:16px; margin:0; position:relative;">
            <img src="${r.imageBase64}" style="width:50px; height:50px; border-radius:8px; object-fit:cover;">
            <div style="flex:1;">
                <div class="clash" style="font-size:14px;">Receipt #${r._id.slice(-4)}</div>
                <div style="font-size:11px; color:var(--text-dim);">${new Date(r.timestamp).toLocaleDateString()} • ${r.items.length} items</div>
            </div>
            <div style="text-align:right;">
                <div style="font-weight:700; color:var(--accent-orange); font-size:14px;">+${r.totalCO2.toFixed(1)}kg</div>
            </div>
            <button onclick="deleteReceipt('${r._id}')" style="background:none; border:none; color:#ff3b30; cursor:pointer; padding:4px;">
                <i data-lucide="trash-2" style="width:18px; height:18px;"></i>
            </button>
        </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
};

window.deleteReceipt = async (id) => {
    if (!confirm("Are you sure you want to delete this scan?")) return;
    try {
        const token = await auth0Client.getTokenSilently();
        await fetch(`/api/receipts/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        fetchReceipts(); // Refresh list
    } catch (err) {
        console.error("Delete failed:", err);
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    await configureClient();

    // Handle Callback
    const query = window.location.search;
    if (query.includes("code=") && query.includes("state=")) {
        await auth0Client.handleRedirectCallback();
        window.history.replaceState({}, document.title, "/");
    }

    const isAuthenticated = await auth0Client.isAuthenticated();
    const user = await auth0Client.getUser();

    // Update UI
    const loginBtn = document.getElementById('btn-login');
    const logoutBtn = document.getElementById('btn-logout');
    const userName = document.getElementById('user-name');

    if (isAuthenticated) {
        userName.innerHTML = `<i data-lucide="user" style="width:12px; height:12px; margin-right:4px;"></i> ${user.nickname || user.name}`;
        logoutBtn.style.display = 'inline-block';
        loginBtn.style.display = 'none';
        refreshData();
    } else {
        userName.innerText = 'Guest View';
        loginBtn.style.display = 'inline-block';
        logoutBtn.style.display = 'none';
        // Auto Login if desired (optional)
    }

    loginBtn.onclick = () => auth0Client.loginWithRedirect();
    logoutBtn.onclick = () => auth0Client.logout({ logoutParams: { returnTo: window.location.origin } });

    // Init Logic
    const initDatePicker = () => {
        const picker = document.getElementById('date-picker-scroll');
        if (!picker) return;
        const days = 60;
        const now = new Date();
        const frag = document.createDocumentFragment();
        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(now.getDate() - i);
            const item = document.createElement('div');
            item.className = 'date-item' + (i === 0 ? ' active' : '');
            item.innerHTML = `<span class="day">${date.toLocaleDateString('en-US', { weekday: 'short' })}</span><span class="num">${date.getDate()}</span>`;
            item.onclick = () => {
                document.querySelectorAll('.date-item').forEach(d => d.classList.remove('active'));
                item.classList.add('active');
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            };
            frag.appendChild(item);
        }
        picker.innerHTML = '';
        picker.appendChild(frag);
        setTimeout(() => {
            const today = picker.lastElementChild;
            if (today) today.scrollIntoView({ behavior: 'auto', inline: 'center' });
        }, 150);
    };

    initDatePicker();
    if (window.lucide) lucide.createIcons();

    const swipeContainer = document.getElementById('dash-swipe');
    const dots = document.querySelectorAll('.dot');
    if (swipeContainer) {
        swipeContainer.addEventListener('scroll', () => {
            const index = Math.round(swipeContainer.scrollLeft / swipeContainer.offsetWidth);
            dots.forEach((dot, i) => {
                dot.classList.toggle('active', i === index);
            });
        });
    }
});

// --- RECEIPT SCANNER LOGIC ---

window.closeScanner = () => {
    document.getElementById('scanner-modal').style.display = 'none';
    document.getElementById('receipt-upload').value = ''; // Reset input
};

const handleImageUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    toggleLogger(); // Close the picker
    document.getElementById('scanner-modal').style.display = 'flex';
    document.getElementById('scanner-loading').style.display = 'block';
    document.getElementById('scanner-results').style.display = 'none';

    try {
        const compressedBase64 = await compressImage(file);
        const results = await sendToAI(compressedBase64);
        renderScannedItems(results, compressedBase64);
    } catch (err) {
        console.error("Scanning failed:", err);
        closeScanner();
        // If token is missing/expired, prompt re-login
        if (err.message && err.message.includes('Missing Refresh Token')) {
            if (confirm("Your session has expired. Please log in again to continue.")) {
                auth0Client.loginWithRedirect();
            }
        } else {
            alert("Failed to analyze receipt. Please try again.");
        }
    }
};

const compressImage = (file) => {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_WIDTH = 800;
                const MAX_HEIGHT = 800;
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_WIDTH) {
                        height *= MAX_WIDTH / width;
                        width = MAX_WIDTH;
                    }
                } else {
                    if (height > MAX_HEIGHT) {
                        width *= MAX_HEIGHT / height;
                        height = MAX_HEIGHT;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.7)); // 70% quality
            };
        };
    });
};

const sendToAI = async (base64Data) => {
    const token = await auth0Client.getTokenSilently();
    const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ image: base64Data })
    });
    return await response.json();
};

let currentScannedData = null;
const renderScannedItems = (data, base64) => {
    // Guard: if the API returned an error object, don't crash
    if (!data || !data.items || !Array.isArray(data.items)) {
        console.error("Invalid scan response:", data);
        alert(data?.error || "Failed to analyze receipt. The AI could not parse any items.");
        closeScanner();
        return;
    }
    currentScannedData = { ...data, image: base64 };
    const list = document.getElementById('scanned-items-list');
    document.getElementById('scanner-loading').style.display = 'none';
    document.getElementById('scanner-results').style.display = 'block';

    list.innerHTML = data.items.map(item => `
        <div class="scanned-item">
            <span class="name">${item.label}</span>
            <span class="co2">+${item.value}kg</span>
        </div>
    `).join('');

    document.getElementById('btn-confirm-scan').onclick = confirmAndLog;
};

const confirmAndLog = async () => {
    try {
        const btn = document.getElementById('btn-confirm-scan');
        btn.innerText = "Saving...";
        btn.disabled = true;

        const token = await auth0Client.getTokenSilently();
        // Since the backend already saved the receipt in /api/scan (as per plan),
        // we just need to refresh our dashboard data.
        // Or if /api/scan ONLY analyzed, we would save here. 
        // My plan says /api/scan saves it.
        
        await refreshData();
        closeScanner();
        btn.innerText = "Log All";
        btn.disabled = false;
    } catch (err) {
        console.error("Confirmation failed:", err);
    }
};

document.getElementById('receipt-upload').addEventListener('change', handleImageUpload);

function renderData(data) {
    // Guard against undefined/error response from API
    if (!data || typeof data.currentEmissions === 'undefined') return;

    const co2Val = document.getElementById('main-co2-val');
    if (co2Val) co2Val.innerText = data.currentEmissions.toFixed(1);

    animateRing('main-ring-1', (data.currentEmissions / data.dailyGoal) * 100);
    animateRing('main-ring-2', 65);
    animateRing('main-ring-3', 85);

    const feed = document.getElementById('activity-feed');
    if (feed && data.activities) {
        feed.innerHTML = data.activities.map(act => `
            <div class="card" style="display:flex; align-items:center; gap:16px; padding:16px; margin-bottom:12px;">
                <div style="color: var(--primary-green);"><i data-lucide="${act.icon || 'activity'}"></i></div>
                <div>
                   <div class="clash" style="font-size:16px;">${act.label}</div>
                   <div style="font-size:12px; color:var(--text-dim);">Impact: ${act.intensity}</div>
                </div>
                <div style="margin-left:auto; font-weight:700; color: ${act.intensity === 'High' ? '#e74c3c' : '#2ecc71'};">+${act.value}kg</div>
            </div>
        `).join('');
        if (window.lucide) lucide.createIcons();
    }

    const tips = document.getElementById('ai-tips');
    if (tips && data.aiTips) {
        tips.innerHTML = data.aiTips.map(tip => `
            <div class="tip-card"><span class="tag">AI TIP</span><p>${tip.text}</p></div>
        `).join('');
    }
}

function animateRing(id, percent) {
    const ring = document.getElementById(id);
    if (!ring) return;
    const radius = ring.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    ring.style.strokeDashoffset = circumference - (percent / 100) * circumference;
}
