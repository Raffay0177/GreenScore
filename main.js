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
        // Mobile Safari (and some in-app browsers) block iframe-based silent auth; refresh tokens avoid that.
        useRefreshTokens: true
    });
};

/** Last /api/carbon payload; used with calendar selection for per-day metrics */
let carbonSnapshot = null;
/** Local calendar day `YYYY-MM-DD` for dashboard breakdown */
let selectedDateKey = null;

const TREE_KG_PER_YEAR = 21;

function localDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function activitiesOnDay(activities, dateKey) {
    return (activities || []).filter((a) => localDateKey(new Date(a.timestamp)) === dateKey);
}

function sumByIcon(acts) {
    let transport = 0;
    let food = 0;
    let shopping = 0;
    for (const a of acts) {
        const v = Number(a.value) || 0;
        const icon = String(a.icon || '').toLowerCase();
        if (icon.includes('car')) transport += v;
        else if (icon.includes('utensil') || icon.includes('coffee')) food += v;
        else if (icon.includes('shopping')) shopping += v;
        else food += v;
    }
    return { transport, food, shopping, total: transport + food + shopping };
}

function exposureTier(ratio) {
    if (ratio < 0.45) {
        return {
            level: 'LOW',
            color: '#2e7d32',
            pillClass: 'status-good',
            headline: 'Daily footprint: light'
        };
    }
    if (ratio < 0.75) {
        return {
            level: 'MOD',
            color: '#ef6c00',
            pillClass: 'status-good',
            headline: 'Daily footprint: moderate'
        };
    }
    if (ratio < 1.05) {
        return {
            level: 'HIGH',
            color: '#c62828',
            pillClass: 'status-danger',
            headline: 'Daily footprint: high vs goal'
        };
    }
    return {
        level: 'SEVERE',
        color: '#b71c1c',
        pillClass: 'status-danger',
        headline: 'Above daily carbon budget'
    };
}

function applyDayInsights() {
    if (!selectedDateKey) return;

    const goal = carbonSnapshot ? Number(carbonSnapshot.dailyGoal) || 47 : 47;
    const acts = carbonSnapshot ? activitiesOnDay(carbonSnapshot.activities, selectedDateKey) : [];
    const { transport, food, shopping, total } = sumByIcon(acts);
    const ratio = goal > 0 ? total / goal : 0;
    const tier = exposureTier(ratio);
    const headroom = Math.max(0, goal - total);
    const treesEq = headroom / TREE_KG_PER_YEAR;
    const highCount = acts.filter((a) => a.intensity === 'High').length;

    const co2El = document.getElementById('main-co2-val');
    if (co2El) co2El.innerText = total.toFixed(1);
    animateRing('main-ring-1', Math.min(150, (total / goal) * 100));

    const carbonPill = document.getElementById('carbon-day-pill');
    if (carbonPill) {
        if (ratio < 0.5) {
            carbonPill.className = 'status-pill status-good';
            carbonPill.innerText = 'UNDER BUDGET';
        } else if (ratio < 0.85) {
            carbonPill.className = 'status-pill status-good';
            carbonPill.innerText = 'ON TRACK';
        } else if (ratio < 1.1) {
            carbonPill.className = 'status-pill status-good';
            carbonPill.innerText = 'NEAR LIMIT';
        } else {
            carbonPill.className = 'status-pill status-danger';
            carbonPill.innerText = 'OVER GOAL';
        }
    }

    const treeVal = document.getElementById('main-tree-val');
    if (treeVal) treeVal.innerText = treesEq.toFixed(1);
    animateRing('main-ring-2', Math.min(100, (treesEq / 2.5) * 100));

    const forestPill = document.getElementById('forest-legacy-pill');
    if (forestPill) {
        forestPill.className = 'status-pill status-good';
        forestPill.innerText = treesEq > 0.05 ? 'HEADROOM VS GOAL' : 'AT OR OVER GOAL';
    }

    const riskVal = document.getElementById('risk-level-val');
    const riskWrap = document.getElementById('risk-level-wrap');
    const riskPill = document.getElementById('risk-exposure-pill');
    if (riskVal) riskVal.innerText = tier.level;
    if (riskWrap) riskWrap.style.color = tier.color;
    if (riskPill) {
        riskPill.className = 'status-pill ' + tier.pillClass;
        riskPill.innerText = `${tier.headline} (${total.toFixed(1)} / ${goal} kg)`;
    }
    animateRing('main-ring-3', Math.min(100, ratio * 90));

    const elT = document.getElementById('val-transport');
    const elF = document.getElementById('val-food');
    const elS = document.getElementById('val-shopping');
    if (elT) elT.innerText = transport.toFixed(1);
    if (elF) elF.innerText = food.toFixed(1);
    if (elS) elS.innerText = shopping.toFixed(1);

    const forestTabTrees = document.getElementById('forest-tab-trees');
    const forestTabBlurb = document.getElementById('forest-tab-blurb');
    if (forestTabTrees) forestTabTrees.innerText = treesEq.toFixed(1);
    if (forestTabBlurb) {
        const label = new Date(selectedDateKey + 'T12:00:00').toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'short',
            day: 'numeric'
        });
        forestTabBlurb.innerText =
            `On ${label} you logged ${total.toFixed(1)} kg (budget ${goal} kg). ` +
            (treesEq > 0
                ? `Staying under budget is roughly ${treesEq.toFixed(1)}x one tree's typical yearly CO2 uptake (~${TREE_KG_PER_YEAR} kg/yr).`
                : 'No budget headroom that day; every kg under your goal next time adds tree-equivalent credit.');
    }

    const impactBanner = document.getElementById('impact-banner-text');
    const impactBody = document.getElementById('impact-body-text');
    if (impactBanner) {
        impactBanner.innerHTML = `<i data-lucide="alert-triangle" style="width: 16px; height: 16px; color: var(--accent-orange);"></i>
                ${tier.headline} • ${total.toFixed(1)} / ${goal} kg`;
        if (window.lucide) lucide.createIcons();
    }
    if (impactBody) {
        const label = new Date(selectedDateKey + 'T12:00:00').toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'short',
            day: 'numeric'
        });
        impactBody.innerHTML =
            `For <strong>${label}</strong> you logged <strong>${acts.length}</strong> entr${acts.length === 1 ? 'y' : 'ies'} ` +
            `totaling <strong>${total.toFixed(1)} kg</strong> CO₂e vs a <strong>${goal} kg</strong> daily budget ` +
            `(<strong>${(ratio * 100).toFixed(0)}%</strong> of goal). ` +
            `${highCount ? `<strong>${highCount}</strong> high-impact item${highCount === 1 ? '' : 's'}. ` : ''}` +
            (ratio >= 1
                ? 'That day exceeded your target—small swaps on food and travel add up fast.'
                : ratio >= 0.75
                  ? 'You are close to the limit; lighter choices tomorrow keep exposure lower.'
                  : 'Keep logging to track how choices stack up over the week.');
    }
}

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
        if (!(await auth0Client.isAuthenticated())) {
            alert('Please log in to save activities.');
            auth0Client.loginWithRedirect();
            return;
        }
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
            return;
        }
        const errBody = await res.json().catch(() => ({}));
        alert(errBody.error || `Could not save (${res.status}). Try logging in again.`);
    } catch (err) {
        console.error("Failed to log activity:", err);
        const msg = err?.error || err?.message || String(err);
        if (msg.includes('Missing Refresh Token') || msg.includes('login_required')) {
            if (confirm('Session expired on this device. Log in again?')) auth0Client.loginWithRedirect();
        } else {
            alert('Could not save this activity. If you are on a phone, try logging out and back in once.');
        }
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
            const key = localDateKey(date);
            const item = document.createElement('div');
            item.className = 'date-item' + (i === 0 ? ' active' : '');
            item.dataset.dateKey = key;
            item.innerHTML = `<span class="day">${date.toLocaleDateString('en-US', { weekday: 'short' })}</span><span class="num">${date.getDate()}</span>`;
            item.onclick = () => {
                document.querySelectorAll('.date-item').forEach(d => d.classList.remove('active'));
                item.classList.add('active');
                selectedDateKey = key;
                applyDayInsights();
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            };
            frag.appendChild(item);
        }
        picker.innerHTML = '';
        picker.appendChild(frag);
        selectedDateKey = localDateKey(new Date());
        applyDayInsights();
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

/** Min / cap for how far left the row can be dragged (px); actual value scales with card width */
const ACTIVITY_SWIPE_MIN = 120;
const ACTIVITY_SWIPE_MAX_CAP = 180;
/** Release at or past this fraction of max drag → delete (no tap) */
const SWIPE_DELETE_THRESHOLD = 0.7;

function getMaxSwipeDist(wrap) {
    const w = wrap.getBoundingClientRect().width || 400;
    return Math.min(ACTIVITY_SWIPE_MAX_CAP, Math.max(ACTIVITY_SWIPE_MIN, w * 0.52));
}

function escapeHtml(text) {
    if (text == null) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
}

function safeFeedIcon(icon) {
    const allowed = new Set(['utensils', 'car', 'shopping-bag', 'coffee', 'activity', 'leaf']);
    return allowed.has(icon) ? icon : 'activity';
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function formatActivityFeedTime(ts) {
    try {
        return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch {
        return '';
    }
}

function receiptPreviewForActivity(act, receiptPreviews) {
    if (!act?.receiptId || !receiptPreviews) return null;
    const key = String(act.receiptId);
    return receiptPreviews[key] || null;
}

async function deleteActivityById(id, { confirmFirst = true } = {}) {
    if (!id) return;
    if (confirmFirst && !confirm('Remove this activity from your log?')) return;
    try {
        const token = await auth0Client.getTokenSilently();
        const res = await fetch(`/api/activities/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.error || 'Could not delete activity');
            await refreshData();
            return;
        }
        await refreshData();
    } catch (e) {
        console.error(e);
        alert('Could not delete activity');
        await refreshData();
    }
}


function initActivitySwipeFeed(container) {
    const wraps = container.querySelectorAll('.activity-swipe-wrap');
    wraps.forEach((wrap) => {
        if (wrap.dataset.swipeBound === '1') return;
        wrap.dataset.swipeBound = '1';

        const panel = wrap.querySelector('.activity-swipe-panel');
        if (!panel) return;

        let dragging = false;
        let activePointerId = null;
        let startClientX = 0;
        let startOffset = 0;
        let commitInFlight = false;

        const maxSwipe = () => wrap._maxSwipe || getMaxSwipeDist(wrap);

        const updateSwipeProgress = (clamped) => {
            const m = maxSwipe();
            const linear = m > 0 ? Math.abs(clamped) / m : 0;
            const eased = Math.min(1, Math.pow(linear, 1.15));
            wrap.style.setProperty('--swipe-progress', String(eased));
            wrap.style.setProperty('--swipe-linear', String(Math.min(1, linear)));
        };

        const setPanelOffset = (x, animated) => {
            const m = maxSwipe();
            const clamped = Math.max(-m, Math.min(0, x));
            wrap._swipeOffset = clamped;
            panel.style.transition = animated ? 'transform 0.24s cubic-bezier(0.32, 0.72, 0, 1)' : 'none';
            panel.style.transform = `translateX(${clamped}px)`;
            updateSwipeProgress(clamped);
        };

        const closeAllOtherRows = () => {
            container.querySelectorAll('.activity-swipe-wrap').forEach((w) => {
                if (w === wrap) return;
                const p = w.querySelector('.activity-swipe-panel');
                if (!p) return;
                w.classList.remove('activity-swipe-dragging', 'activity-swipe-exiting');
                w.style.setProperty('--swipe-progress', '0');
                w.style.setProperty('--swipe-linear', '0');
                w._swipeOffset = 0;
                p.style.transition = 'transform 0.24s cubic-bezier(0.32, 0.72, 0, 1)';
                p.style.transform = 'translateX(0)';
            });
        };

        const runExitDelete = async () => {
            if (commitInFlight) return;
            commitInFlight = true;
            try {
                wrap.classList.remove('activity-swipe-dragging');
                wrap.classList.add('activity-swipe-exiting');
                wrap.style.setProperty('--swipe-progress', '1');
                wrap.style.setProperty('--swipe-linear', '1');
                const dist = wrap.offsetWidth + 28;
                panel.style.transition = 'transform 0.42s cubic-bezier(0.32, 0.72, 0, 1)';
                panel.style.transform = `translateX(${-dist}px)`;

                await new Promise((resolve) => {
                    let finished = false;
                    const end = () => {
                        if (finished) return;
                        finished = true;
                        window.clearTimeout(tid);
                        panel.removeEventListener('transitionend', onEnd);
                        resolve();
                    };
                    const tid = window.setTimeout(end, 520);
                    const onEnd = (ev) => {
                        if (ev.propertyName && ev.propertyName !== 'transform') return;
                        end();
                    };
                    panel.addEventListener('transitionend', onEnd);
                });

                const id = wrap.dataset.activityId;
                await deleteActivityById(id, { confirmFirst: false });
            } finally {
                commitInFlight = false;
            }
        };

        const finishDrag = (e) => {
            if (!dragging) return;
            if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
            dragging = false;
            const pid = activePointerId;
            activePointerId = null;
            if (pid != null) {
                try {
                    panel.releasePointerCapture(pid);
                } catch (_) {
                    /* ignore */
                }
            }
            wrap.classList.remove('activity-swipe-dragging');
            const m = maxSwipe();
            const o = wrap._swipeOffset ?? 0;
            const ratio = m > 0 ? Math.abs(o) / m : 0;
            if (ratio >= SWIPE_DELETE_THRESHOLD) {
                void runExitDelete();
                return;
            }
            setPanelOffset(0, true);
        };

        wrap._swipeOffset = 0;
        wrap._maxSwipe = getMaxSwipeDist(wrap);
        wrap.style.setProperty('--swipe-progress', '0');
        wrap.style.setProperty('--swipe-linear', '0');
        setPanelOffset(0, false);

        panel.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (wrap.classList.contains('activity-swipe-exiting')) return;
            closeAllOtherRows();
            wrap._maxSwipe = getMaxSwipeDist(wrap);
            wrap.classList.add('activity-swipe-dragging');
            dragging = true;
            activePointerId = e.pointerId;
            startClientX = e.clientX;
            startOffset = wrap._swipeOffset ?? 0;
            try {
                panel.setPointerCapture(e.pointerId);
            } catch (_) {
                /* ignore */
            }
        });

        panel.addEventListener('pointermove', (e) => {
            if (!dragging || e.pointerId !== activePointerId) return;
            const dx = e.clientX - startClientX;
            const m = maxSwipe();
            let next = startOffset + dx;
            next = Math.max(-m, Math.min(0, next));
            setPanelOffset(next, false);
        });

        panel.addEventListener('pointerup', finishDrag);
        panel.addEventListener('pointercancel', finishDrag);
        panel.addEventListener('lostpointercapture', (e) => {
            if (dragging && e.pointerId === activePointerId) finishDrag(e);
        });
    });
}

function renderData(data) {
    if (!data || typeof data.currentEmissions === 'undefined') return;

    carbonSnapshot = data;

    const feed = document.getElementById('activity-feed');
    const feedActs = (data.activities || []).slice(0, 10);
    const previews = data.receiptPreviews || {};
    if (feed && feedActs.length) {
        feed.innerHTML = feedActs
            .map((act) => {
                const id = act._id ?? act.id;
                const ic = safeFeedIcon(act.icon);
                const intenColor =
                    act.intensity === 'High' ? '#e74c3c' : act.intensity === 'Medium' ? '#f57c00' : '#2ecc71';
                const val = Number(act.value);
                const img = receiptPreviewForActivity(act, previews);
                const timeStr = formatActivityFeedTime(act.timestamp);
                const thumb = img
                    ? `<img class="activity-feed-thumb" src="${escapeAttr(img)}" alt="" />`
                    : `<div class="activity-feed-thumb-placeholder"><i data-lucide="${ic}" width="24" height="24"></i></div>`;
                return `
            <div class="activity-swipe-wrap" data-activity-id="${String(id)}">
              <div class="activity-swipe-actions">
                <div class="activity-swipe-delete-visual" aria-hidden="true">
                  <i data-lucide="trash-2" width="22" height="22" stroke-width="2"></i>
                  <span class="activity-swipe-delete-label">Delete</span>
                </div>
              </div>
              <div class="activity-swipe-panel">
                <div class="activity-feed-thumb-wrap">${thumb}</div>
                <div class="activity-feed-body">
                  <div class="activity-feed-title-row">
                    <span class="activity-feed-title clash">${escapeHtml(act.label)}</span>
                    <span class="activity-feed-time">${escapeHtml(timeStr)}</span>
                  </div>
                  <div class="activity-feed-value-row">
                    <span class="activity-feed-value" style="color:${intenColor};">+${Number.isFinite(val) ? val.toFixed(1) : '0.0'} kg</span>
                    <span class="activity-feed-meta">CO2e · ${escapeHtml(act.intensity)}</span>
                  </div>
                </div>
              </div>
            </div>`;
            })
            .join('');
        if (window.lucide) lucide.createIcons();
        initActivitySwipeFeed(feed);
    } else if (feed) {
        feed.innerHTML =
            '<div style="text-align:center; padding:24px; color:var(--text-dim); font-size:14px;">No activity yet. Log food, travel, or a receipt to get started.</div>';
    }

    const tips = document.getElementById('ai-tips');
    if (tips && data.aiTips) {
        tips.innerHTML = data.aiTips.map(tip => `
            <div class="tip-card"><span class="tag">AI TIP</span><p>${tip.text}</p></div>
        `).join('');
    }

    applyDayInsights();
}

function animateRing(id, percent) {
    const ring = document.getElementById(id);
    if (!ring) return;
    const radius = ring.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    ring.style.strokeDashoffset = circumference - (percent / 100) * circumference;
}
