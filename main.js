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
        cacheLocation: 'localstorage',
        useRefreshTokens: true
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
        const data = await response.json();
        renderData(data);
    } catch (err) {
        console.error("Data refresh failed:", err);
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

function renderData(data) {
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
