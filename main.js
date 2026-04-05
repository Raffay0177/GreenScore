import { createAuth0Client } from '@auth0/auth0-spa-js';
import { initDestinationMaps, prepareDestinationView, onCarLogViewChange, getDestinationInfo, resetDestinationInfo } from './destination-maps.js';

// Global state
let auth0Client = null;
let foodRecognition = null;
let scannerStream = null;
let currentScannerMode = 'food'; // 'food', 'barcode', 'label'

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
    for (const a of acts) {
        const v = Number(a.value) || 0;
        const icon = String(a.icon || '').toLowerCase();
        // Include 'activity' (used for transit/bus) and 'car' in transport
        if (icon.includes('car') || icon.includes('activity') || icon.includes('bus')) {
            transport += v;
        } else {
            // Default to food (includes utensils, coffee, camera/receipts)
            food += v;
        }
    }
    return { transport, food, total: transport + food };
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
    const { transport, food, total } = sumByIcon(acts);
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
    if (elT) elT.innerText = transport.toFixed(1);
    if (elF) elF.innerText = food.toFixed(1);

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
    if (modal.style.display === 'none') {
        modal.style.display = 'flex';
        backToLoggerMain(); 
        
        // Add Enter listener to input once
        const input = document.getElementById('food-desc-input');
        if (input && !input.dataset.listener) {
            input.onkeyup = (e) => { if (e.key === 'Enter') submitFoodDescription(); };
            input.dataset.listener = 'true';
        }
    } else {
        modal.style.display = 'none';
        stopCameraAndReturn(); // Cleanup if camera was open
    }
};

window.showLoggerFood = () => {
    const main = document.getElementById('logger-view-main');
    const food = document.getElementById('logger-view-food');
    if (main) main.style.display = 'none';
    if (food) food.style.display = 'block';
    if (window.lucide) lucide.createIcons();
};

window.backToLoggerMain = () => {
    const main = document.getElementById('logger-view-main');
    const food = document.getElementById('logger-view-food');
    if (main) main.style.display = 'block';
    if (food) food.style.display = 'none';
    if (window.lucide) lucide.createIcons();
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
    initCarLogUI();
    if (window.lucide) lucide.createIcons();

    // Bind voice button
    const voiceBtn = document.getElementById('btn-food-voice');
    if (voiceBtn) {
        voiceBtn.onclick = startFoodVoice;
    }
    
    // Bind barcode upload
    const barcodeInput = document.getElementById('barcode-upload');
    if (barcodeInput) {
        barcodeInput.addEventListener('change', (e) => handleImageUpload(e, '/api/food/scan-barcode'));
    }

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
    document.getElementById('receipt-upload').value = ''; 
    document.getElementById('barcode-upload').value = '';
};

// --- SCANNER MODAL & IN-WINDOW CAMERA ---

window.openInWindowCamera = async () => {
    const mainView = document.getElementById('logger-view-food');
    const scannerView = document.getElementById('logger-view-scanner');
    if (mainView) mainView.style.display = 'none';
    if (scannerView) scannerView.style.display = 'block';

    try {
        const constraints = {
            video: { facingMode: 'environment', width: { ideal: 1080 }, height: { ideal: 1080 } }
        };
        scannerStream = await navigator.mediaDevices.getUserMedia(constraints);
        const video = document.getElementById('scanner-video');
        if (video) video.srcObject = scannerStream;
        
        switchScannerMode('food'); // Default mode
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error("Camera access failed:", err);
        alert("Could not access camera. Please check permissions.");
        stopCameraAndReturn();
    }
};

window.stopCameraAndReturn = () => {
    if (scannerStream) {
        scannerStream.getTracks().forEach(track => track.stop());
        scannerStream = null;
    }
    const mainView = document.getElementById('logger-view-food');
    const scannerView = document.getElementById('logger-view-scanner');
    if (mainView) mainView.style.display = 'block';
    if (scannerView) scannerView.style.display = 'none';
};

window.switchScannerMode = (mode) => {
    currentScannerMode = mode;
    const cards = document.querySelectorAll('.scanner-mode-card');
    cards.forEach(c => {
        const m = c.getAttribute('onclick').match(/'([^']+)'/)[1];
        c.classList.toggle('active', m === mode);
    });

    const reticle = document.getElementById('scanner-reticle');
    if (reticle) reticle.style.display = (mode === 'barcode') ? 'block' : 'none';
};

window.toggleCameraFlash = async () => {
    if (!scannerStream) return;
    const track = scannerStream.getVideoTracks()[0];
    const caps = track.getCapabilities();
    if (!caps.torch) {
        alert("Flash/Torch not supported on this device/browser.");
        return;
    }

    const currentTorch = track.getConstraints().advanced?.[0]?.torch || false;
    try {
        await track.applyConstraints({ advanced: [{ torch: !currentTorch }] });
        const btn = document.getElementById('btn-cam-flash');
        if (btn) {
            btn.innerHTML = !currentTorch ? '<i data-lucide="zap"></i>' : '<i data-lucide="zap-off"></i>';
            btn.style.color = !currentTorch ? 'var(--primary-green)' : 'white';
            if (window.lucide) lucide.createIcons();
        }
    } catch (e) {
        console.warn("Torch failed", e);
    }
};

window.setCameraZoom = async (val) => {
    if (!scannerStream) return;
    const track = scannerStream.getVideoTracks()[0];
    const caps = track.getCapabilities();
    if (!caps.zoom) {
        alert("Zoom not supported on this camera.");
        return;
    }
    
    // Zoom range is usually 1 to some max. Map 0.5x to 1 if needed, or use specific values.
    // For simplicity, we'll try to set zoom directly if it's within range.
    const zoomVal = Math.max(caps.zoom.min, Math.min(caps.zoom.max, val * 2 || 1)); 
    try {
        await track.applyConstraints({ advanced: [{ zoom: zoomVal }] });
    } catch (e) {
        console.warn("Zoom failed", e);
    }
};

window.captureCameraFrame = async () => {
    const video = document.getElementById('scanner-video');
    const canvas = document.getElementById('scanner-capture-canvas');
    if (!video || !canvas) return;

    try {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        
        const mode = currentScannerMode;
        
        // --- OPTIMISTIC UI: Close scanner and show placeholder ---
        stopCameraAndReturn();
        toggleLogger();

        const tempId = 'temp-' + Date.now();
        const pendingAct = {
            id: tempId,
            _id: tempId,
            label: 'Analyzing Image...',
            value: 0,
            status: 'processing',
            timestamp: new Date().toISOString(),
            icon: mode === 'barcode' ? 'barcode' : 'camera'
        };

        // Inject at top
        if (carbonSnapshot) {
            carbonSnapshot.activities = [pendingAct, ...(carbonSnapshot.activities || [])];
            mountActivityFeedFromSnapshot();
        }

        // Kick off background processing
        handleBackgroundScan(base64, mode, tempId);

    } catch (err) {
        console.error("Capture failed:", err);
        alert("Failed to capture image.");
    }
};

const handleBackgroundScan = async (base64, mode, tempId) => {
    try {
        let endpoint = '/api/scan'; 
        if (mode === 'barcode' || mode === 'label') endpoint = '/api/food/scan-barcode';

        const results = await sendToAI(base64, endpoint);
        const normalizedItems = results.items ? results.items : [results];

        const token = await auth0Client.getTokenSilently();
        
        // Log all items to the DB
        const savedActivities = [];
        for (const item of normalizedItems) {
            const logRes = await fetch('/api/log', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    label: item.label,
                    value: item.value,
                    icon: item.category === 'Food' ? 'utensils' : 'activity',
                    intensity: item.intensity || (item.value > 2 ? 'High' : 'Low')
                })
            });
            if (logRes.ok) {
                savedActivities.push(await logRes.json());
            }
        }

        // Replace the "Pending" item in the snapshot
        if (carbonSnapshot && carbonSnapshot.activities) {
            carbonSnapshot.activities = carbonSnapshot.activities.filter(a => a.id !== tempId && a._id !== tempId);
            carbonSnapshot.activities = [...savedActivities, ...carbonSnapshot.activities];
            
            // Re-calc metrics and re-mount
            await refreshData(); 
        }

    } catch (err) {
        console.error("Background scan failed:", err);
        if (carbonSnapshot && carbonSnapshot.activities) {
            const act = carbonSnapshot.activities.find(a => a.id === tempId || a._id === tempId);
            if (act) {
                act.status = 'error';
                act.label = 'Scan Failed';
                mountActivityFeedFromSnapshot();
            }
        }
    }
};

// Unified image handler (receipts or barcodes)
const handleImageUpload = async (event, endpoint = '/api/scan') => {
    const file = event.target.files[0];
    if (!file) return;

    toggleLogger(); // Close the picker
    document.getElementById('scanner-modal').style.display = 'flex';
    document.getElementById('scanner-loading').style.display = 'block';
    document.getElementById('scanner-results').style.display = 'none';

    try {
        const compressedBase64 = await compressImage(file);
        const results = await sendToAI(compressedBase64, endpoint);
        // If it's a barcode, it might be a single object {label, value, ...}
        // Instead of the multi-item {items: [...]} format.
        const normalized = results.items ? results : { items: [results], totalCO2: results.value };
        renderScannedItems(normalized, compressedBase64);
    } catch (err) {
        console.error("Scanning failed:", err);
        closeScanner();
        alert(err.message || "Failed to analyze image.");
    }
};

window.startFoodVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        alert("Voice recognition not supported in this browser. Try Chrome.");
        return;
    }

    const btn = document.getElementById('btn-food-voice');

    // Toggle behavior
    if (foodRecognition) {
        foodRecognition.stop();
        return;
    }

    foodRecognition = new SpeechRecognition();
    foodRecognition.continuous = false;
    foodRecognition.interimResults = false;
    
    foodRecognition.onstart = () => {
        btn.classList.add('listening');
        btn.style.color = '#ff3b30'; 
        btn.innerHTML = '<i data-lucide="circle-stop"></i>';
        if (window.lucide) lucide.createIcons();
    };
    
    foodRecognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        document.getElementById('food-desc-input').value = transcript;
    };
    
    foodRecognition.onend = () => {
        btn.classList.remove('listening');
        btn.style.color = 'var(--primary-green)';
        btn.innerHTML = '<i data-lucide="mic"></i>';
        if (window.lucide) lucide.createIcons();
        foodRecognition = null;
    };
    
    foodRecognition.onerror = () => {
        foodRecognition = null;
    };

    foodRecognition.start();
};

window.submitFoodDescription = async () => {
    const input = document.getElementById('food-desc-input');
    const desc = input.value.trim();
    if (!desc) return;
    
    const originalBtnText = "Log";
    try {
        // Show loading in the input area? 
        input.disabled = true;
        input.placeholder = "Analyzing with AI...";
        
        const token = await auth0Client.getTokenSilently();
        const res = await fetch('/api/food/estimate', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ description: desc })
        });
        
        if (!res.ok) throw new Error("Could not estimate CO2");
        const data = await res.json();
        
        // Log the activity
        const logRes = await fetch('/api/log', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                label: data.label,
                value: data.value,
                icon: 'utensils',
                intensity: data.intensity
            })
        });
        
        if (logRes.ok) {
            toggleLogger();
            refreshData();
            input.value = '';
        }
    } catch (err) {
        alert(err.message || "Failed to log food.");
    } finally {
        input.disabled = false;
        input.placeholder = "e.g. 2 eggs and toast";
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

const sendToAI = async (base64Data, endpoint = '/api/scan') => {
    const token = await auth0Client.getTokenSilently();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ image: base64Data })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "AI Error");
    }
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

document.getElementById('receipt-upload').addEventListener('change', (e) => handleImageUpload(e, '/api/scan'));

/** Min / cap for how far left the row can be dragged (px); actual value scales with card width */
const ACTIVITY_SWIPE_MIN = 120;
const ACTIVITY_SWIPE_MAX_CAP = 180;
/** Release at or past this fraction of max drag → delete (no tap) */
const SWIPE_DELETE_THRESHOLD = 0.7;
/** Shared easing for delete collapse + list FLIP (smooth deceleration) */
const ACTIVITY_DELETE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const ACTIVITY_DELETE_COLLAPSE_MS = 420;
const ACTIVITY_FLIP_MS = 420;

/** Snap-back / commit-to-delete animation (rAF so delete gradient tracks the panel) */
const ACTIVITY_SWIPE_SNAP_MS = 340;
const ACTIVITY_SWIPE_EASE_OUT = (t) => 1 - Math.pow(1 - t, 2.85);
const ACTIVITY_SWIPE_RUBBER_MAX_PX = 28;
const ACTIVITY_SWIPE_RUBBER_STIFF = 0.33;

function getMaxSwipeDist(wrap) {
    const w = wrap.getBoundingClientRect().width || 400;
    return Math.min(ACTIVITY_SWIPE_MAX_CAP, Math.max(ACTIVITY_SWIPE_MIN, w * 0.52));
}

function rubberBandSwipeX(wrap, x) {
    const m = wrap._maxSwipe || getMaxSwipeDist(wrap);
    let next = Math.min(0, x);
    if (next < -m) {
        const over = -m - next;
        next = -m - Math.min(ACTIVITY_SWIPE_RUBBER_MAX_PX, over * ACTIVITY_SWIPE_RUBBER_STIFF);
    }
    return next;
}

function setActivitySwipeVisualProgress(wrap, offsetX) {
    const m = wrap._maxSwipe || getMaxSwipeDist(wrap);
    const linear = m > 0 ? Math.min(1, Math.abs(offsetX) / m) : 0;
    const t = Math.min(1, linear);
    const eased = 1 - Math.pow(1 - t, 2.35);
    wrap.style.setProperty('--swipe-progress', String(eased));
    wrap.style.setProperty('--swipe-linear', String(linear));
}

/**
 * @param {object} options
 * @param {boolean} [options.animated]
 * @param {() => void} [options.onDone]
 * @param {boolean} [options.allowOvershoot] — drag only; soft rubber past max left
 */
function applyActivityPanelTransform(wrap, panel, x, options = {}) {
    const { animated = false, onDone, allowOvershoot = false } = options;
    const m = wrap._maxSwipe || getMaxSwipeDist(wrap);
    const resolved = allowOvershoot ? rubberBandSwipeX(wrap, x) : Math.max(-m, Math.min(0, x));

    if (!animated) {
        wrap._panelAnimToken = (wrap._panelAnimToken || 0) + 1;
        panel.style.transition = 'none';
        wrap._swipeOffset = resolved;
        panel.style.transform = `translate3d(${resolved}px,0,0)`;
        setActivitySwipeVisualProgress(wrap, resolved);
        onDone?.();
        return;
    }

    const endX = Math.max(-m, Math.min(0, x));
    const startX = wrap._swipeOffset ?? 0;
    if (Math.abs(endX - startX) < 0.75) {
        applyActivityPanelTransform(wrap, panel, endX, { animated: false, onDone });
        return;
    }

    wrap._panelAnimToken = (wrap._panelAnimToken || 0) + 1;
    const token = wrap._panelAnimToken;
    const t0 = performance.now();
    const dur = ACTIVITY_SWIPE_SNAP_MS;

    const step = (now) => {
        if (token !== wrap._panelAnimToken) return;
        const u = Math.min(1, (now - t0) / dur);
        const e = ACTIVITY_SWIPE_EASE_OUT(u);
        const xi = startX + (endX - startX) * e;
        const mm = wrap._maxSwipe || getMaxSwipeDist(wrap);
        const clampedXi = Math.max(-mm, Math.min(0, xi));
        panel.style.transition = 'none';
        wrap._swipeOffset = clampedXi;
        panel.style.transform = `translate3d(${clampedXi}px,0,0)`;
        setActivitySwipeVisualProgress(wrap, clampedXi);
        if (u < 1) {
            requestAnimationFrame(step);
        } else {
            wrap._swipeOffset = endX;
            panel.style.transform = `translate3d(${endX}px,0,0)`;
            setActivitySwipeVisualProgress(wrap, endX);
            onDone?.();
        }
    };
    requestAnimationFrame(step);
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

async function deleteActivityOnServer(id) {
    if (!id) throw new Error('Missing activity');
    const token = await auth0Client.getTokenSilently();
    const res = await fetch(`/api/activities/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not delete activity');
    }
}

function buildSingleActivityRowHtml(act, receiptPreviews, opts = {}) {
    const isProcessing = act.status === 'processing';
    const isError = act.status === 'error';
    const rowClass = isProcessing ? ' activity-feed-row-processing' : (isError ? ' activity-feed-row-error' : '');
    const enterClass = (opts.enterAnimation ? ' activity-feed-row-enter' : '') + rowClass;
    
    const id = act._id ?? act.id;
    const ic = safeFeedIcon(act.icon);
    const intenColor =
        act.intensity === 'High' ? '#e74c3c' : act.intensity === 'Medium' ? '#f57c00' : '#2ecc71';
    const val = Number(act.value);
    const img = receiptPreviewForActivity(act, receiptPreviews);
    const timeStr = formatActivityFeedTime(act.timestamp);
    
    let thumb = img
        ? `<img class="activity-feed-thumb" src="${escapeAttr(img)}" alt="" />`
        : `<div class="activity-feed-thumb-placeholder"><i data-lucide="${ic}" width="24" height="24"></i></div>`;
    
    if (isProcessing) {
        thumb = `<div class="activity-feed-thumb-placeholder"><div class="spinner"></div></div>`;
    }

    const valStr = isProcessing ? '...' : (isError ? 'FAIL' : `+${val.toFixed(1)}`);
    const metaStr = isProcessing ? 'Analyzing image...' : (isError ? 'Could not analyze' : `CO2e · ${act.intensity}`);

    const valAttr = Number.isFinite(val) ? val : 0;
    return `
            <div class="activity-swipe-wrap${enterClass}" data-activity-id="${String(id)}" data-activity-value="${valAttr}">
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
                    <span class="activity-feed-value" style="color:${intenColor};">${valStr} kg</span>
                    <span class="activity-feed-meta">${metaStr}</span>
                  </div>
                </div>
              </div>
            </div>`;
}

function buildActivityFeedHtml(feedActs, receiptPreviews) {
    return feedActs.map((act) => buildSingleActivityRowHtml(act, receiptPreviews)).join('');
}

const ACTIVITY_FEED_EMPTY_HTML =
    '<div class="activity-feed-empty" style="text-align:center; padding:24px; color:var(--text-dim); font-size:14px;">No activity yet. Log food, travel, or a receipt to get started.</div>';

/** FLIP: rows below the removed slot animate upward instead of jumping */
function flipAnimateFeedSlideUp(feed, onDone) {
    const rows = [...feed.querySelectorAll('.activity-swipe-wrap')].filter((el) => {
        const dy = el._flipDy;
        return typeof dy === 'number' && Math.abs(dy) >= 0.5;
    });
    if (rows.length === 0) {
        if (window.lucide) lucide.createIcons();
        onDone?.();
        return;
    }
    const dur = `${ACTIVITY_FLIP_MS / 1000}s`;
    const ease = ACTIVITY_DELETE_EASE;
    requestAnimationFrame(() => {
        rows.forEach((el) => {
            el.style.willChange = 'transform, opacity';
            el.style.transform = `translateY(${el._flipDy}px)`;
            el.style.opacity = '0.94';
            el.style.transition = 'none';
        });
        requestAnimationFrame(() => {
            rows.forEach((el) => {
                el.style.transition = `transform ${dur} ${ease}, opacity ${dur} ${ease}`;
                el.style.transform = '';
                el.style.opacity = '';
                delete el._flipDy;
            });
            window.setTimeout(() => {
                rows.forEach((el) => {
                    el.style.willChange = '';
                    el.style.transition = '';
                });
                if (window.lucide) lucide.createIcons();
                onDone?.();
            }, ACTIVITY_FLIP_MS + 48);
        });
    });
}

function applyOptimisticActivityDelete(activityId, value) {
    if (!carbonSnapshot?.activities) return;
    const sid = String(activityId);
    carbonSnapshot.activities = carbonSnapshot.activities.filter((a) => String(a._id ?? a.id) !== sid);
    const v = Number(value) || 0;
    carbonSnapshot.currentEmissions = Math.max(0, Number(carbonSnapshot.currentEmissions || 0) - v);
    applyDayInsights();
}

function mountActivityFeedFromSnapshot() {
    const feed = document.getElementById('activity-feed');
    if (!feed || !carbonSnapshot) return;
    const feedActs = (carbonSnapshot.activities || []).slice(0, 10);
    const previews = carbonSnapshot.receiptPreviews || {};
    if (feedActs.length) {
        feed.innerHTML = buildActivityFeedHtml(feedActs, previews);
        if (window.lucide) lucide.createIcons();
        initActivitySwipeFeed(feed);
    } else {
        feed.innerHTML = ACTIVITY_FEED_EMPTY_HTML;
    }
}

async function deleteActivityById(id, { confirmFirst = true } = {}) {
    if (!id) return;
    if (confirmFirst && !confirm('Remove this activity from your log?')) return;
    try {
        await deleteActivityOnServer(id);
        await refreshData();
    } catch (e) {
        console.error(e);
        alert(e.message || 'Could not delete activity');
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

        const closeAllOtherRows = () => {
            container.querySelectorAll('.activity-swipe-wrap').forEach((w) => {
                if (w === wrap) return;
                const p = w.querySelector('.activity-swipe-panel');
                if (!p) return;
                w.classList.remove('activity-swipe-dragging', 'activity-feed-row-removing');
                applyActivityPanelTransform(w, p, 0, { animated: true });
            });
        };

        const runExitDelete = () => {
            if (commitInFlight) return;
            commitInFlight = true;
            const id = wrap.dataset.activityId;
            const value = Number(wrap.dataset.activityValue) || 0;

            const feedEl = document.getElementById('activity-feed');
            const beforeCollapseTops = new Map();
            if (feedEl) {
                feedEl.querySelectorAll('.activity-swipe-wrap').forEach((el) => {
                    beforeCollapseTops.set(el, el.getBoundingClientRect().top);
                });
            }

            wrap.classList.remove('activity-swipe-dragging');
            wrap.classList.add('activity-feed-row-removing');
            const h = wrap.offsetHeight;
            wrap.style.overflow = 'hidden';
            const collapseDur = `${ACTIVITY_DELETE_COLLAPSE_MS / 1000}s`;
            wrap.style.transition = `max-height ${collapseDur} ${ACTIVITY_DELETE_EASE}, margin-bottom ${collapseDur} ${ACTIVITY_DELETE_EASE}`;
            wrap.style.maxHeight = `${h}px`;

            const panel = wrap.querySelector('.activity-swipe-panel');
            if (panel) {
                const ox = wrap._swipeOffset ?? 0;
                panel.style.transition = 'none';
                panel.style.transformOrigin = 'center center';
                panel.style.transform = `translate3d(${ox}px,0,0) scale(1)`;
                panel.style.opacity = '1';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const pd = `${Math.min(380, ACTIVITY_DELETE_COLLAPSE_MS - 20) / 1000}s`;
                        panel.style.transition = `opacity ${pd} ${ACTIVITY_DELETE_EASE}, transform ${pd} ${ACTIVITY_DELETE_EASE}`;
                        panel.style.transform = 'translate3d(0,0,0) scale(0.96)';
                        panel.style.opacity = '0';
                    });
                });
            }

            let finished = false;
            const complete = () => {
                if (finished) return;
                finished = true;
                const feed = document.getElementById('activity-feed');
                if (!feed || !carbonSnapshot) {
                    commitInFlight = false;
                    deleteActivityOnServer(id).catch((err) => {
                        alert(err.message || 'Could not delete activity');
                        refreshData();
                    });
                    return;
                }

                applyOptimisticActivityDelete(id, value);
                wrap.remove();

                const acts = carbonSnapshot.activities.slice(0, 10);
                const previews = carbonSnapshot.receiptPreviews || {};
                if (acts.length === 0) {
                    feed.innerHTML = ACTIVITY_FEED_EMPTY_HTML;
                    commitInFlight = false;
                    deleteActivityOnServer(id).catch((err) => {
                        alert(err.message || 'Could not delete activity');
                        refreshData();
                    });
                    return;
                }

                const existing = [...feed.querySelectorAll('.activity-swipe-wrap')];
                const existingIds = new Set(existing.map((w) => String(w.dataset.activityId)));
                for (const act of acts) {
                    const aid = String(act._id ?? act.id);
                    if (!existingIds.has(aid)) {
                        feed.insertAdjacentHTML(
                            'beforeend',
                            buildSingleActivityRowHtml(act, previews, { enterAnimation: true })
                        );
                        existingIds.add(aid);
                    }
                }

                feed.querySelectorAll('.activity-swipe-wrap').forEach((el) => {
                    const oldTop = beforeCollapseTops.get(el);
                    if (oldTop === undefined) return;
                    const newTop = el.getBoundingClientRect().top;
                    el._flipDy = oldTop - newTop;
                });

                flipAnimateFeedSlideUp(feed, () => {
                    initActivitySwipeFeed(feed);
                    commitInFlight = false;
                });

                deleteActivityOnServer(id).catch((err) => {
                    alert(err.message || 'Could not delete activity');
                    refreshData();
                });
            };

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    wrap.style.maxHeight = '0';
                    wrap.style.marginBottom = '0';
                });
            });

            const onEnd = (ev) => {
                if (ev.propertyName !== 'max-height') return;
                wrap.removeEventListener('transitionend', onEnd);
                complete();
            };
            wrap.addEventListener('transitionend', onEnd);
            window.setTimeout(() => {
                wrap.removeEventListener('transitionend', onEnd);
                complete();
            }, ACTIVITY_DELETE_COLLAPSE_MS + 120);
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
                applyActivityPanelTransform(wrap, panel, -maxSwipe(), {
                    animated: true,
                    onDone: () => void runExitDelete()
                });
                return;
            }
            applyActivityPanelTransform(wrap, panel, 0, { animated: true });
        };

        wrap._swipeOffset = 0;
        wrap._maxSwipe = getMaxSwipeDist(wrap);
        wrap.style.setProperty('--swipe-progress', '0');
        wrap.style.setProperty('--swipe-linear', '0');
        applyActivityPanelTransform(wrap, panel, 0, { animated: false });

        panel.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (wrap.classList.contains('activity-feed-row-removing')) return;
            wrap._panelAnimToken = (wrap._panelAnimToken || 0) + 1;
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
            const next = startOffset + dx;
            applyActivityPanelTransform(wrap, panel, next, { animated: false, allowOvershoot: true });
        });

        panel.addEventListener('pointerup', finishDrag);
        panel.addEventListener('pointercancel', finishDrag);
        panel.addEventListener('lostpointercapture', (e) => {
            if (dragging && e.pointerId === activePointerId) finishDrag(e);
        });
    });
}

// --- Car trip logger (garage, scan/manual, log activity) ---
let carLogGarageCache = [];
let carViewStack = ['main'];
const carLogState = {
    selectedCarId: null,
    tempCar: null,
    pendingMatch: null,
    publicTransportMode: false
};

const CAR_VIEW_IDS = {
    main: 'car-view-main',
    select: 'car-view-select',
    add: 'car-view-add',
    manual: 'car-view-manual',
    manualBusy: 'car-view-manual-busy',
    scanBusy: 'car-view-scan-busy',
    review: 'car-view-review',
    destination: 'car-view-destination'
};

function carSyncViews() {
    const key = carViewStack[carViewStack.length - 1];
    for (const [k, id] of Object.entries(CAR_VIEW_IDS)) {
        const el = document.getElementById(id);
        if (el) el.hidden = k !== key;
    }
    const back = document.getElementById('car-log-back');
    if (back) {
        back.hidden = carViewStack.length <= 1;
        // Show "Done" instead of "Back" when on destination view and a destination is selected
        if (key === 'destination') {
            const destInfo = getDestinationInfo();
            back.textContent = destInfo.endLatLng ? 'Done' : 'Back';
        } else {
            back.textContent = 'Back';
        }
    }
    if (window.lucide) lucide.createIcons();
    onCarLogViewChange(key);
    if (key === 'destination') void prepareDestinationView();
}

function carNavPush(key) {
    carViewStack.push(key);
    carSyncViews();
}

function carNavPop() {
    carViewStack.pop();
    if (carViewStack.length === 0) carViewStack.push('main');
    carSyncViews();
}

function carNavReset() {
    carViewStack = ['main'];
    resetCarReviewUI();
    carSyncViews();
}

function resetCarReviewUI() {
    const fine = document.getElementById('car-review-actions-fine');
    const save = document.getElementById('car-review-actions-save');
    const card = document.getElementById('car-review-card');
    if (fine) fine.style.display = '';
    if (save) save.style.display = 'none';
    if (card) card.innerHTML = '';
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Could not read file'));
        r.readAsDataURL(file);
    });
}

async function deleteCarOnServer(id) {
    const token = await auth0Client.getTokenSilently();
    const res = await fetch(`/api/cars/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not delete vehicle');
    }
}

function updateCarSelectedPill() {
    const el = document.getElementById('car-selected-pill');
    if (!el) return;
    if (carLogState.tempCar) {
        el.textContent = `Temporary: ${carLogState.tempCar.label} (~${Number(carLogState.tempCar.estimatedKgPerTrip).toFixed(1)} kg/trip)`;
        el.classList.add('has-car');
        return;
    }
    if (carLogState.selectedCarId) {
        const c = carLogGarageCache.find((x) => String(x._id) === String(carLogState.selectedCarId));
        el.textContent = c
            ? `${c.label} (~${Number(c.estimatedKgPerTrip).toFixed(1)} kg/trip)`
            : 'Vehicle selected';
        el.classList.add('has-car');
        return;
    }
    el.textContent = 'No vehicle selected';
    el.classList.remove('has-car');
}

function selectGarageCar(id, container) {
    carLogState.selectedCarId = id;
    carLogState.tempCar = null;
    if (container) {
        container.querySelectorAll('.garage-row-selected').forEach((n) => n.classList.remove('garage-row-selected'));
        const row = container.querySelector(`[data-car-id="${CSS.escape(String(id))}"]`);
        if (row) row.classList.add('garage-row-selected');
    }
    updateCarSelectedPill();
}

function buildGarageRowHtml(car) {
    const id = String(car._id);
    const label = escapeHtml(car.label);
    const meta = escapeHtml([car.make, car.model].filter(Boolean).join(' ') || 'Saved vehicle');
    const kg = Number(car.estimatedKgPerTrip) || 2.4;
    return `
            <div class="activity-swipe-wrap car-garage-row" data-car-id="${id}" data-car-kg="${kg}">
              <div class="activity-swipe-actions">
                <div class="activity-swipe-delete-visual" aria-hidden="true">
                  <i data-lucide="trash-2" width="22" height="22" stroke-width="2"></i>
                  <span class="activity-swipe-delete-label">Delete</span>
                </div>
              </div>
              <div class="activity-swipe-panel">
                <div class="activity-feed-thumb-placeholder"><i data-lucide="car" width="24" height="24"></i></div>
                <div class="activity-feed-body">
                  <div class="activity-feed-title-row">
                    <span class="activity-feed-title clash">${label}</span>
                  </div>
                  <div class="activity-feed-value-row">
                    <span class="activity-feed-meta">${meta}</span>
                    <span class="activity-feed-value" style="color:var(--accent-blue);">~${kg.toFixed(1)} kg</span>
                  </div>
                </div>
              </div>
            </div>`;
}

function renderGarageList() {
    const list = document.getElementById('car-garage-list');
    const swipeHint = document.getElementById('car-select-swipe-hint');
    if (!list) return;
    if (!carLogGarageCache.length) {
        if (swipeHint) swipeHint.hidden = true;
        list.innerHTML = `
            <div class="car-garage-empty-wrap">
                <button type="button" class="car-btn-solid" id="car-garage-empty-add">Add</button>
                <p class="car-garage-empty-hint">No car added</p>
            </div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }
    if (swipeHint) swipeHint.hidden = false;
    list.innerHTML = carLogGarageCache.map((c) => buildGarageRowHtml(c)).join('');
    if (window.lucide) lucide.createIcons();
    initCarGarageSwipe(list);
    if (carLogState.selectedCarId) {
        selectGarageCar(carLogState.selectedCarId, list);
    }
}

async function fetchGarageCars() {
    const token = await auth0Client.getTokenSilently();
    const res = await fetch('/api/cars', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Could not load garage');
    carLogGarageCache = await res.json();
}

function renderCarReviewForPending(showFine) {
    const p = carLogState.pendingMatch;
    const card = document.getElementById('car-review-card');
    const fine = document.getElementById('car-review-actions-fine');
    const save = document.getElementById('car-review-actions-save');
    if (!p || !card || !fine || !save) return;
    const s = p.suggested;
    let html = '';
    if (p.matchedCarId) {
        html += `<p class="clash" style="margin:0 0 8px;">Matched your garage</p>`;
        html += `<p>Linked to <strong>${escapeHtml(s.label)}</strong>.</p>`;
    } else {
        html += `<p class="clash" style="margin:0 0 8px;">Suggested vehicle</p>`;
        html += `<p><strong>${escapeHtml(s.label)}</strong></p>`;
        const mm = [s.make, s.model].filter(Boolean).join(' ');
        if (mm) html += `<p>${escapeHtml(mm)}</p>`;
    }
    html += `<p>Est. <strong>${Number(s.estimatedKgPerTrip).toFixed(1)} kg</strong> CO₂e per typical trip.</p>`;
    if (p.shortReason) {
        html += `<p style="color:var(--text-dim);font-size:13px;">${escapeHtml(p.shortReason)}</p>`;
    }
    if (p.confidence != null && !p.fromManual) {
        html += `<p style="font-size:12px;color:var(--text-dim);">Confidence: ${Math.round(Number(p.confidence) * 100)}%</p>`;
    }
    card.innerHTML = html;
    if (showFine) {
        fine.style.display = 'flex';
        save.style.display = 'none';
    } else {
        fine.style.display = 'none';
        save.style.display = 'flex';
    }
}

function initCarGarageSwipe(container) {
    const wraps = container.querySelectorAll('.car-garage-row');
    wraps.forEach((wrap) => {
        if (wrap.dataset.garageSwipeBound === '1') return;
        wrap.dataset.garageSwipeBound = '1';

        const panel = wrap.querySelector('.activity-swipe-panel');
        if (!panel) return;

        let dragging = false;
        let activePointerId = null;
        let startClientX = 0;
        let startClientY = 0;
        let startOffset = 0;
        let commitInFlight = false;

        const maxSwipe = () => wrap._maxSwipe || getMaxSwipeDist(wrap);

        const finishDrag = (e) => {
            if (!dragging) return;
            if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
            const ev = e;
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

            const cx = ev?.clientX ?? startClientX;
            const cy = ev?.clientY ?? startClientY;
            const tapDist = Math.hypot(cx - startClientX, cy - startClientY);

            if (ratio < SWIPE_DELETE_THRESHOLD && tapDist < 14 && Math.abs(o) < 10) {
                selectGarageCar(wrap.dataset.carId, container);
                applyActivityPanelTransform(wrap, panel, 0, { animated: true });
                return;
            }

            if (ratio >= SWIPE_DELETE_THRESHOLD) {
                applyActivityPanelTransform(wrap, panel, -maxSwipe(), {
                    animated: true,
                    onDone: () => void runGarageDelete()
                });
                return;
            }
            applyActivityPanelTransform(wrap, panel, 0, { animated: true });
        };

        const runGarageDelete = () => {
            if (commitInFlight) return;
            commitInFlight = true;
            const id = wrap.dataset.carId;

            wrap.classList.remove('activity-swipe-dragging');
            wrap.classList.add('activity-feed-row-removing');
            const h = wrap.offsetHeight;
            wrap.style.overflow = 'hidden';
            const collapseDur = `${ACTIVITY_DELETE_COLLAPSE_MS / 1000}s`;
            wrap.style.transition = `max-height ${collapseDur} ${ACTIVITY_DELETE_EASE}, margin-bottom ${collapseDur} ${ACTIVITY_DELETE_EASE}`;
            wrap.style.maxHeight = `${h}px`;

            const pnl = wrap.querySelector('.activity-swipe-panel');
            if (pnl) {
                const ox = wrap._swipeOffset ?? 0;
                pnl.style.transition = 'none';
                pnl.style.transformOrigin = 'center center';
                pnl.style.transform = `translate3d(${ox}px,0,0) scale(1)`;
                pnl.style.opacity = '1';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const pd = `${Math.min(380, ACTIVITY_DELETE_COLLAPSE_MS - 20) / 1000}s`;
                        pnl.style.transition = `opacity ${pd} ${ACTIVITY_DELETE_EASE}, transform ${pd} ${ACTIVITY_DELETE_EASE}`;
                        pnl.style.transform = 'translate3d(0,0,0) scale(0.96)';
                        pnl.style.opacity = '0';
                    });
                });
            }

            let finished = false;
            const complete = () => {
                if (finished) return;
                finished = true;
                wrap.remove();
                carLogGarageCache = carLogGarageCache.filter((c) => String(c._id) !== String(id));
                if (String(carLogState.selectedCarId) === String(id)) {
                    carLogState.selectedCarId = null;
                    updateCarSelectedPill();
                }
                commitInFlight = false;
                deleteCarOnServer(id).catch((err) => {
                    alert(err.message || 'Could not delete vehicle');
                    fetchGarageCars()
                        .then(() => renderGarageList())
                        .catch(() => {});
                });
            };

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    wrap.style.maxHeight = '0';
                    wrap.style.marginBottom = '0';
                });
            });

            const onEnd = (ev) => {
                if (ev.propertyName !== 'max-height') return;
                wrap.removeEventListener('transitionend', onEnd);
                complete();
            };
            wrap.addEventListener('transitionend', onEnd);
            window.setTimeout(() => {
                wrap.removeEventListener('transitionend', onEnd);
                complete();
            }, ACTIVITY_DELETE_COLLAPSE_MS + 120);
        };

        wrap._swipeOffset = 0;
        wrap._maxSwipe = getMaxSwipeDist(wrap);
        wrap.style.setProperty('--swipe-progress', '0');
        wrap.style.setProperty('--swipe-linear', '0');
        applyActivityPanelTransform(wrap, panel, 0, { animated: false });

        panel.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (wrap.classList.contains('activity-feed-row-removing')) return;
            wrap._panelAnimToken = (wrap._panelAnimToken || 0) + 1;
            wrap._maxSwipe = getMaxSwipeDist(wrap);
            wrap.classList.add('activity-swipe-dragging');
            dragging = true;
            activePointerId = e.pointerId;
            startClientX = e.clientX;
            startClientY = e.clientY;
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
            const next = startOffset + dx;
            applyActivityPanelTransform(wrap, panel, next, { animated: false, allowOvershoot: true });
        });

        panel.addEventListener('pointerup', finishDrag);
        panel.addEventListener('pointercancel', finishDrag);
        panel.addEventListener('lostpointercapture', (e) => {
            if (dragging && e.pointerId === activePointerId) finishDrag(e);
        });
    });
}

window.openCarLogModal = async () => {
    try {
        if (!(await auth0Client.isAuthenticated())) {
            alert('Please log in up to manage vehicles.');
            auth0Client.loginWithRedirect();
            return;
        }
    } catch (_) {
        alert('Please log in up to manage vehicles.');
        return;
    }
    toggleLogger();
    carLogState.publicTransportMode = false;
    const modal = document.getElementById('car-log-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    const title = document.getElementById('car-log-title');
    const sub = document.getElementById('car-log-sub');
    if (title) title.textContent = 'Log a trip';
    if (sub) sub.textContent = 'Select a vehicle, add one, then log your trip.';
    carNavReset();
    try {
        await fetchGarageCars();
    } catch (err) {
        console.error(err);
        carLogGarageCache = [];
    }
    updateCarSelectedPill();
    if (window.lucide) lucide.createIcons();
};

window.closeCarLogModal = (keepDestination = false) => {
    const modal = document.getElementById('car-log-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }
    // Close discards destination info unless explicitly kept
    if (!keepDestination) {
        resetDestinationInfo();
    }
    carNavReset();
    resetCarReviewUI();
};

function initCarLogUI() {
    initDestinationMaps();
    const back = document.getElementById('car-log-back');
    if (back) {
        back.onclick = () => {
            const currentView = carViewStack[carViewStack.length - 1];
            // If on destination view and pressing "Done", keep destination info
            if (currentView === 'destination') {
                const destInfo = getDestinationInfo();
                if (destInfo.endLatLng) {
                    // Update the destination pill on main view
                    updateDestinationPill();
                    // Go all the way back to main so they can press 'Log trip'
                    carNavReset();
                    return;
                }
            }
            carNavPop();
        };
    }

    const modal = document.getElementById('car-log-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCarLogModal();
            if (e.target.closest('#car-garage-empty-add')) {
                e.preventDefault();
                carNavPush('add');
            }
        });
        modal.querySelectorAll('[data-car-nav]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const nav = btn.getAttribute('data-car-nav');
                if (nav === 'select') {
                    try {
                        await fetchGarageCars();
                    } catch (_) {
                        carLogGarageCache = [];
                    }
                    renderGarageList();
                    carNavPush('select');
                } else if (nav === 'add') {
                    carNavPush('add');
                } else if (nav === 'destination') {
                    carNavPush('destination');
                } else if (nav === 'log') {
                    await submitCarTripLog();
                }
            });
        });
    }

    document.getElementById('car-btn-scan')?.addEventListener('click', () => {
        document.getElementById('car-scan-input')?.click();
    });

    document.getElementById('car-btn-manual')?.addEventListener('click', () => {
        document.getElementById('car-manual-label').value = '';
        document.getElementById('car-manual-make').value = '';
        document.getElementById('car-manual-model').value = '';
        carNavPush('manual');
    });

    document.getElementById('car-btn-transit')?.addEventListener('click', () => {
        carLogState.publicTransportMode = true;
        const title = document.getElementById('car-log-title');
        const sub = document.getElementById('car-log-sub');
        if (title) title.textContent = 'Log a bus trip';
        if (sub) sub.textContent = 'Set your start & destination, then log to see bus routes.';
        carNavPush('destination');
    });

    document.getElementById('car-manual-continue')?.addEventListener('click', async () => {
        const make = document.getElementById('car-manual-make').value.trim();
        const model = document.getElementById('car-manual-model').value.trim();
        if (!make || !model) {
            alert('Enter make and model so we can estimate emissions.');
            return;
        }
        let label = document.getElementById('car-manual-label').value.trim();
        if (!label) label = `${make} ${model}`.trim();
        try {
            if (!(await auth0Client.isAuthenticated())) return;
        } catch (_) {
            return;
        }
        carNavPush('manualBusy');
        try {
            const token = await auth0Client.getTokenSilently();
            const res = await fetch('/api/cars/estimate-emissions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ make, model })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not estimate emissions');
            const kg = Math.max(0.1, Math.min(50, Number(data.estimatedKgPerTrip) || 2.4));
            carLogState.pendingMatch = {
                fromManual: true,
                matchedCarId: null,
                suggested: { label, make, model, estimatedKgPerTrip: kg },
                shortReason: data.shortReason || ''
            };
            carViewStack.pop();
            carViewStack.pop();
            carNavPush('review');
            renderCarReviewForPending(false);
        } catch (err) {
            alert(err.message || 'Estimate failed');
            carViewStack.pop();
            carSyncViews();
        }
    });

    document.getElementById('car-review-fine')?.addEventListener('click', () => {
        document.getElementById('car-review-actions-fine').style.display = 'none';
        document.getElementById('car-review-actions-save').style.display = 'flex';
    });

    document.getElementById('car-review-cancel')?.addEventListener('click', () => {
        carLogState.pendingMatch = null;
        resetCarReviewUI();
        carNavPop();
    });

    document.getElementById('car-save-permanent')?.addEventListener('click', () => void saveCarPermanentChoice());
    document.getElementById('car-save-temporary')?.addEventListener('click', () => saveCarTemporaryChoice());

    document.getElementById('car-scan-input')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            if (!(await auth0Client.isAuthenticated())) return;
        } catch (_) {
            return;
        }
        carNavPush('scanBusy');
        try {
            const dataUrl = await compressImage(file);
            const token = await auth0Client.getTokenSilently();
            const res = await fetch('/api/cars/match-image', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ image: dataUrl })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not analyze photo');
            carLogState.pendingMatch = {
                fromManual: false,
                matchedCarId: data.matchedCarId || null,
                matchType: data.matchType,
                suggested: data.suggested,
                confidence: data.confidence,
                shortReason: data.shortReason
            };
            carViewStack.pop();
            carNavPush('review');
            renderCarReviewForPending(true);
        } catch (err) {
            alert(err.message || 'Scan failed');
            carViewStack.pop();
            carSyncViews();
        }
    });
}

async function saveCarPermanentChoice() {
    const p = carLogState.pendingMatch;
    if (!p) return;
    try {
        if (p.matchedCarId) {
            carLogState.selectedCarId = p.matchedCarId;
            carLogState.tempCar = null;
            await fetchGarageCars();
            const list = document.getElementById('car-garage-list');
            if (list) {
                renderGarageList();
            }
            selectGarageCar(p.matchedCarId, list);
        } else {
            const s = p.suggested;
            const token = await auth0Client.getTokenSilently();
            const res = await fetch('/api/cars', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                    label: s.label,
                    make: s.make,
                    model: s.model,
                    estimatedKgPerTrip: s.estimatedKgPerTrip
                })
            });
            const car = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(car.error || 'Could not save vehicle');
            await fetchGarageCars();
            const list = document.getElementById('car-garage-list');
            if (list) renderGarageList();
            carLogState.selectedCarId = String(car._id);
            carLogState.tempCar = null;
            if (list) selectGarageCar(car._id, list);
        }
        carLogState.pendingMatch = null;
        resetCarReviewUI();
        carNavReset();
        updateCarSelectedPill();
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        alert(err.message || 'Save failed');
    }
}

function saveCarTemporaryChoice() {
    const p = carLogState.pendingMatch;
    if (!p) return;
    carLogState.selectedCarId = null;
    const s = p.suggested;
    if (p.matchedCarId) {
        const c = carLogGarageCache.find((x) => String(x._id) === String(p.matchedCarId));
        carLogState.tempCar = {
            label: c?.label || s.label,
            estimatedKgPerTrip: Number(c?.estimatedKgPerTrip ?? s.estimatedKgPerTrip) || 2.4
        };
    } else {
        carLogState.tempCar = {
            label: s.label,
            estimatedKgPerTrip: Number(s.estimatedKgPerTrip) || 2.4
        };
    }
    carLogState.pendingMatch = null;
    resetCarReviewUI();
    carNavReset();
    updateCarSelectedPill();
}

function updateDestinationPill() {
    const destInfo = getDestinationInfo();
    const tile = document.querySelector('[data-car-nav="destination"]');
    if (!tile) return;
    const small = tile.querySelector('small');
    if (small) {
        if (destInfo.endLatLng && destInfo.endLabel) {
            small.textContent = `→ ${destInfo.endLabel.slice(0, 25)}`;
            small.style.color = 'var(--primary-green)';
        } else {
            small.textContent = 'Set start & end';
            small.style.color = '';
        }
    }
}

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateCarTripEmissions(distKm, kgPerTrip, carLabel) {
    // kgPerTrip is the AI estimate for a ~10km trip.
    // Scale linearly by distance, baseline ~10km.
    const baselineKm = 10;
    const scaled = (distKm / baselineKm) * kgPerTrip;
    return Math.max(0.1, Math.round(scaled * 10) / 10);
}

async function submitCarTripLog() {
    try {
        if (!(await auth0Client.isAuthenticated())) {
            alert('Please log in.');
            auth0Client.loginWithRedirect();
            return;
        }
    } catch (_) {
        return;
    }

    // Check if public transport mode
    const isPublicTransport = carLogState.publicTransportMode === true;

    // Validate: car selected (skip for public transport)
    if (!isPublicTransport) {
        if (!carLogState.tempCar && !carLogState.selectedCarId) {
            // Navigate to select view
            try { await fetchGarageCars(); } catch (_) { carLogGarageCache = []; }
            renderGarageList();
            carNavPush('select');
            return;
        }
    }

    // Validate: destination set
    const destInfo = getDestinationInfo();
    if (!destInfo.endLatLng) {
        carNavPush('destination');
        return;
    }

    // Validate: start set (use map center or current location default)
    if (!destInfo.startLatLng) {
        carNavPush('destination');
        return;
    }

    // Calculate distance
    const distKm = haversineDistanceKm(
        destInfo.startLatLng.lat, destInfo.startLatLng.lng,
        destInfo.endLatLng.lat, destInfo.endLatLng.lng
    );

    let label;
    let value;
    let carId = null;
    let temporaryCar = false;

    if (isPublicTransport) {
        // Public transport: ~0.089 kg CO2 per km (bus average)
        value = Math.max(0.1, Math.round(distKm * 0.089 * 10) / 10);
        label = `Bus — ${destInfo.startLabel || 'Start'} → ${destInfo.endLabel} (${distKm.toFixed(1)} km)`;
    } else if (carLogState.tempCar) {
        label = `Trip — ${carLogState.tempCar.label} → ${destInfo.endLabel} (${distKm.toFixed(1)} km)`;
        value = estimateCarTripEmissions(distKm, carLogState.tempCar.estimatedKgPerTrip, carLogState.tempCar.label);
        temporaryCar = true;
    } else if (carLogState.selectedCarId) {
        const c = carLogGarageCache.find((x) => String(x._id) === String(carLogState.selectedCarId));
        if (!c) {
            try { await fetchGarageCars(); } catch (_) { carLogGarageCache = []; }
            renderGarageList();
            carNavPush('select');
            return;
        }
        label = `Trip — ${c.label} → ${destInfo.endLabel} (${distKm.toFixed(1)} km)`;
        value = estimateCarTripEmissions(distKm, Number(c.estimatedKgPerTrip) || 2.4, c.label);
        carId = c._id;
        temporaryCar = false;
    } else {
        try { await fetchGarageCars(); } catch (_) { carLogGarageCache = []; }
        renderGarageList();
        carNavPush('select');
        return;
    }

    const intensity = value > 4 ? 'High' : value > 2.5 ? 'Medium' : 'Low';
    try {
        const token = await auth0Client.getTokenSilently();
        const res = await fetch('/api/log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                label,
                value,
                icon: isPublicTransport ? 'activity' : 'car',
                intensity,
                carId: temporaryCar ? null : carId,
                temporaryCar
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Could not log trip');
        }

        // If public transport, redirect to Google Maps with transit directions
        if (isPublicTransport && destInfo.endLatLng) {
            // Prefer labels (names) for better display on Google Maps
            const originStr = destInfo.startLabel && destInfo.startLabel !== 'Current location' 
                ? destInfo.startLabel 
                : (destInfo.startLatLng ? `${destInfo.startLatLng.lat},${destInfo.startLatLng.lng}` : 'current location');
            
            const destStr = destInfo.endLabel || `${destInfo.endLatLng.lat},${destInfo.endLatLng.lng}`;
            
            const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originStr)}&destination=${encodeURIComponent(destStr)}&travelmode=transit&transit_mode=bus`;
            
            // Redirect to maps in same tab
            window.location.href = mapsUrl;
        }

        carLogState.publicTransportMode = false;
        closeCarLogModal(true);
        resetDestinationInfo();
        refreshData();
    } catch (err) {
        alert(err.message || 'Could not log trip');
    }
}

function renderData(data) {
    if (!data || typeof data.currentEmissions === 'undefined') return;

    carbonSnapshot = data;

    const feed = document.getElementById('activity-feed');
    const feedActs = (data.activities || []).slice(0, 10);
    const previews = data.receiptPreviews || {};
    if (feed && feedActs.length) {
        feed.innerHTML = buildActivityFeedHtml(feedActs, previews);
        if (window.lucide) lucide.createIcons();
        initActivitySwipeFeed(feed);
    } else if (feed) {
        feed.innerHTML = ACTIVITY_FEED_EMPTY_HTML;
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
