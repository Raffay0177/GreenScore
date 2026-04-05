/**
 * Google Maps + Places for car-log Destination view.
 * Requires VITE_GOOGLE_MAPS_API_KEY and enabled APIs: Maps JavaScript, Places, Geocoding.
 */

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const DEFAULT_CENTER = { lat: 33.4242, lng: -111.9281 };

let mapsLoadPromise = null;
let map = null;
let startMarker = null;
let endMarker = null;
let placesService = null;
let geocoder = null;

let startLatLng = null;
let startLabel = '';
let endLatLng = null;
let endLabel = '';

function setStatus(msg, kind = 'info') {
    const el = document.getElementById('dest-status');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind;
    el.hidden = !msg;
}

function loadGoogleMaps() {
    if (typeof google !== 'undefined' && google.maps) return Promise.resolve();
    if (!MAPS_KEY) return Promise.reject(new Error('NO_KEY'));
    if (mapsLoadPromise) return mapsLoadPromise;
    mapsLoadPromise = new Promise((resolve, reject) => {
        const id = 'google-maps-js';
        if (document.getElementById(id)) {
            const check = () => {
                if (typeof google !== 'undefined' && google.maps) resolve();
                else setTimeout(check, 50);
            };
            check();
            return;
        }
        const s = document.createElement('script');
        s.id = id;
        s.async = true;
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&libraries=places,geometry&v=weekly`;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Maps script failed to load'));
        document.head.appendChild(s);
    });
    return mapsLoadPromise;
}

function getOriginLatLng() {
    if (startLatLng) return startLatLng;
    if (map) return map.getCenter();
    return DEFAULT_CENTER;
}

function originLabel() {
    if (startLabel) return startLabel;
    return 'Map center';
}

function updateStartMarker() {
    const pos = getOriginLatLng();
    if (!map || !pos) return;
    if (!startMarker) {
        startMarker = new google.maps.Marker({
            map,
            position: pos,
            label: { text: 'A', color: 'white', fontSize: '12px' },
            title: 'Start'
        });
    } else {
        startMarker.setPosition(pos);
    }
}

function setEndMarker(latLng, title) {
    if (!map) return;
    endLabel = title || '';
    endLatLng = latLng;
    if (!endMarker) {
        endMarker = new google.maps.Marker({
            map,
            position: latLng,
            label: { text: 'B', color: 'white', fontSize: '12px' },
            title: title || 'Destination'
        });
    } else {
        endMarker.setPosition(latLng);
        endMarker.setTitle(title || 'Destination');
    }
    map.panTo(latLng);
}

function clearEndMarker() {
    if (endMarker) {
        endMarker.setMap(null);
        endMarker = null;
    }
    endLatLng = null;
    endLabel = '';
}

function initMapIfNeeded() {
    const el = document.getElementById('dest-map-canvas');
    if (!el || map) return;
    map = new google.maps.Map(el, {
        center: DEFAULT_CENTER,
        zoom: 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: true
    });
    geocoder = new google.maps.Geocoder();
    placesService = new google.maps.places.PlacesService(map);
}

function resizeMap() {
    if (map) google.maps.event.trigger(map, 'resize');
}

function toggleMapExpanded() {
    const shell = document.getElementById('dest-map-shell');
    const backdrop = document.getElementById('dest-map-backdrop');
    if (!shell) return;
    const expanded = shell.classList.toggle('dest-map-shell--expanded');
    if (backdrop) backdrop.hidden = !expanded;
    requestAnimationFrame(() => {
        resizeMap();
        if (map) {
            const c = startLatLng || map.getCenter();
            map.setCenter(c);
        }
    });
}

function collapseMapExpanded() {
    const shell = document.getElementById('dest-map-shell');
    const backdrop = document.getElementById('dest-map-backdrop');
    if (shell?.classList.contains('dest-map-shell--expanded')) {
        shell.classList.remove('dest-map-shell--expanded');
        if (backdrop) backdrop.hidden = true;
        requestAnimationFrame(() => resizeMap());
    }
}

function syncStartSummary() {
    const el = document.getElementById('dest-start-summary');
    if (!el) return;
    if (startLatLng && startLabel) {
        el.textContent = `Start: ${startLabel}`;
        el.classList.add('dest-start-summary--ok');
    } else {
        el.textContent = 'Start: not set — using map center for distance ranking';
        el.classList.remove('dest-start-summary--ok');
    }
}

function geocodeFriendly(status) {
    switch (status) {
        case 'ZERO_RESULTS':
            return 'No results for that search. Try a street address, city, or landmark.';
        case 'OVER_QUERY_LIMIT':
            return 'Search quota exceeded. Try again in a moment.';
        case 'REQUEST_DENIED':
            return 'Geocoding was denied. Check your API key and enabled APIs.';
        case 'INVALID_REQUEST':
            return 'Invalid address. Please refine what you typed.';
        default:
            return 'Could not look up that location. Try different words.';
    }
}

function placesFriendly(status) {
    switch (status) {
        case 'ZERO_RESULTS':
            return 'No places found. Try another name, spelling, or a wider area.';
        case 'OVER_QUERY_LIMIT':
            return 'Too many searches. Please wait and try again.';
        case 'REQUEST_DENIED':
            return 'Places search was denied. Enable Places API for this key.';
        case 'INVALID_REQUEST':
            return 'Invalid search. Enter a business name or address.';
        default:
            return 'Something went wrong finding places. Try again.';
    }
}

export function onCarLogViewChange(viewKey) {
    if (viewKey !== 'destination') collapseMapExpanded();
}

export function getDestinationInfo() {
    return {
        startLatLng,
        startLabel,
        endLatLng,
        endLabel
    };
}

export function resetDestinationInfo() {
    startLatLng = null;
    startLabel = '';
    endLatLng = null;
    endLabel = '';
    if (startMarker) { startMarker.setMap(null); startMarker = null; }
    clearEndMarker();
    const input = document.getElementById('dest-start-input');
    if (input) input.value = '';
    const queryInput = document.getElementById('dest-query-input');
    if (queryInput) queryInput.value = '';
    const listEl = document.getElementById('dest-results-list');
    if (listEl) listEl.innerHTML = '';
    syncStartSummary();
}

export async function prepareDestinationView() {
    const noKey = document.getElementById('dest-no-key-msg');
    if (!MAPS_KEY) {
        if (noKey) noKey.hidden = false;
        setStatus('Add VITE_GOOGLE_MAPS_API_KEY to your .env for maps.', 'warn');
        return;
    }
    if (noKey) noKey.hidden = true;
    setStatus('');

    try {
        await loadGoogleMaps();
    } catch (e) {
        setStatus(e.message === 'NO_KEY' ? 'Maps API key missing.' : 'Could not load Google Maps.', 'error');
        return;
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    initMapIfNeeded();
    resizeMap();
    updateStartMarker();
    syncStartSummary();
}

export function initDestinationMaps() {
    const shell = document.getElementById('dest-map-shell');
    const expandBtn = document.getElementById('dest-expand-toggle');
    const backdrop = document.getElementById('dest-map-backdrop');

    shell?.addEventListener('click', (e) => {
        if (expandBtn?.contains(e.target)) return;
        toggleMapExpanded();
    });
    expandBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMapExpanded();
    });
    backdrop?.addEventListener('click', () => collapseMapExpanded());

    document.getElementById('dest-start-current')?.addEventListener('click', () => {
        setStatus('Getting your location…');
        if (!navigator.geolocation) {
            setStatus('This browser does not support location. Use custom start instead.', 'error');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                startLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                startLabel = 'Current location';
                if (map) {
                    map.setCenter(startLatLng);
                    map.setZoom(14);
                }
                updateStartMarker();
                syncStartSummary();
                // Populate the start input field with the current location text
                const startInput = document.getElementById('dest-start-input');
                if (startInput) startInput.value = 'Current location';
                setStatus('');
            },
            () => {
                setStatus('Location permission denied or unavailable. Add a custom start address.', 'error');
            },
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
    });

    document.getElementById('dest-start-use-center')?.addEventListener('click', () => {
        if (!map) return;
        const c = map.getCenter();
        startLatLng = { lat: c.lat(), lng: c.lng() };
        startLabel = 'Picked from map (center)';
        updateStartMarker();
        syncStartSummary();
        setStatus('Start set to map center. Pan the map, then tap again to update.', 'info');
    });

    document.getElementById('dest-start-set-custom')?.addEventListener('click', () => {
        const input = document.getElementById('dest-start-input');
        const q = input?.value?.trim();
        if (!q) {
            setStatus('Type a start address or place name.', 'warn');
            return;
        }
        if (!geocoder) {
            setStatus('Map is still loading…', 'warn');
            return;
        }
        setStatus('Looking up start…');
        geocoder.geocode({ address: q }, (results, status) => {
            if (status !== 'OK' || !results?.[0]) {
                setStatus(geocodeFriendly(status), 'error');
                return;
            }
            const loc = results[0].geometry.location;
            startLatLng = { lat: loc.lat(), lng: loc.lng() };
            startLabel = results[0].formatted_address || q;
            map.setCenter(startLatLng);
            map.setZoom(14);
            updateStartMarker();
            syncStartSummary();
            setStatus('');
        });
    });

    document.getElementById('dest-search-btn')?.addEventListener('click', () => runDestinationSearch());

    document.getElementById('dest-query-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            runDestinationSearch();
        }
    });
}

function runDestinationSearch() {
    const input = document.getElementById('dest-query-input');
    const query = input?.value?.trim();
    const listEl = document.getElementById('dest-results-list');
    if (!query) {
        setStatus('Enter a business, chain, or address to search.', 'warn');
        return;
    }
    if (!placesService || !map) {
        setStatus('Map is still loading…', 'warn');
        return;
    }

    setStatus('Searching…');
    if (listEl) listEl.innerHTML = '';

    const origin = getOriginLatLng();
    const gOrigin = new google.maps.LatLng(origin.lat, origin.lng);

    placesService.textSearch(
        {
            query,
            location: gOrigin,
            radius: 50000
        },
        (results, status) => {
            if (status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
                tryGeocodeOnly(query, listEl);
                return;
            }
            if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.length) {
                setStatus(placesFriendly(status), 'error');
                return;
            }

            const ranked = results
                .map((p) => {
                    const loc = p.geometry?.location;
                    if (!loc) return null;
                    const d = google.maps.geometry.spherical.computeDistanceBetween(gOrigin, loc);
                    return { place: p, meters: d };
                })
                .filter(Boolean)
                .sort((a, b) => a.meters - b.meters)
                .slice(0, 5);

            if (!ranked.length) {
                tryGeocodeOnly(query, listEl);
                return;
            }

            setStatus(
                `Nearest first from ${originLabel()} · ${ranked.length} result${ranked.length === 1 ? '' : 's'}`,
                'info'
            );
            renderResultList(ranked, listEl);
        }
    );
}

function tryGeocodeOnly(query, listEl) {
    geocoder.geocode({ address: query }, (results, status) => {
        if (status !== 'OK' || !results?.[0]) {
            setStatus(
                'No matching places or addresses. Check spelling or try a nearby city.',
                'error'
            );
            return;
        }
        const r = results[0];
        const loc = r.geometry.location;
        const d = google.maps.geometry.spherical.computeDistanceBetween(gOrigin, loc);
        setStatus('Single address match (not a chain search).', 'info');
        renderResultList(
            [{ place: { name: r.formatted_address, geometry: r.geometry, place_id: r.place_id }, meters: d }],
            listEl
        );
    });
}

function renderResultList(ranked, listEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    ranked.forEach((row, i) => {
        const p = row.place;
        const loc = p.geometry?.location;
        if (!loc) return;
        const name = p.name || 'Unknown';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dest-result-row';
        btn.innerHTML = `
                <span class="dest-result-rank">${i + 1}</span>
                <span class="dest-result-body">
                    <span class="dest-result-name">${escapeHtml(name)}</span>
                    <span class="dest-result-meta">${(row.meters / 1000).toFixed(1)} km · ${escapeHtml(originLabel())}</span>
                </span>`;
        btn.addEventListener('click', () => {
            setEndMarker({ lat: loc.lat(), lng: loc.lng() }, name);
            setStatus(`Destination: ${name}`, 'info');
            // Populate the search input with the selected destination
            const queryInput = document.getElementById('dest-query-input');
            if (queryInput) queryInput.value = name;
            // Collapse the results list
            listEl.innerHTML = '';
            // Update Back button to "Done" since a destination is now set
            const backBtn = document.getElementById('car-log-back');
            if (backBtn && !backBtn.hidden) backBtn.textContent = 'Done';
        });
        listEl.appendChild(btn);
    });
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
