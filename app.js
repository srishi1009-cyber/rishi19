// ============================================================
// RISHI MUSIC - COMPLETE APP ENGINE (app.js)
// ============================================================

const DB_NAME = "RishiMusicDB";
const DB_VERSION = 3;
const STORE_NAME = "tracks";

let db = null;
let songs = [];
let currentIndex = -1;

let activeArtist = "all";
let searchQuery = "";
let isTransitioning = false;
let playbackGeneration = 0;
let activePlayPromise = null;

// Unique shuffle/cycle pool
let unplayedQueue = [];

// Persistent Blob URL cache
const blobUrlCache = new WeakMap();

// ============================================================
// AUDIO ENGINE
// ============================================================

const audio = document.getElementById("audioEngine") || new Audio();
audio.id = "audioEngine";
audio.preload = "auto";
audio.setAttribute("playsinline", "true");
if (!document.getElementById("audioEngine")) {
    document.body.appendChild(audio);
}

// ============================================================
// DAILY NO-REPEAT ENGINE
// ============================================================

function getTodayKey() {
    const now = new Date();
    return `rishi_played_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}`;
}

function getDailyPlayedIds() {
    try {
        const data = localStorage.getItem(getTodayKey());
        return data ? JSON.parse(data) : [];
    } catch (e) {
        return [];
    }
}

function markSongPlayedToday(songId) {
    if (songId === undefined || songId === null) return;
    try {
        const key = getTodayKey();
        let played = getDailyPlayedIds();
        if (!played.includes(songId)) {
            played.push(songId);
            localStorage.setItem(key, JSON.stringify(played));
        }
    } catch (e) {}
}

// ============================================================
// INDEXED DB
// ============================================================

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, {
                    keyPath: "id",
                    autoIncrement: true
                });
            }
        };

        request.onsuccess = () => {
            db = request.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };

        request.onerror = () => reject(request.error);
        request.onblocked = () => console.warn("IndexedDB blocked.");
    });
}

function saveTrackToDB(track) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("Database is not ready"));
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(track);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function loadAllTracksFromDB() {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("Database is not ready"));
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => reject(request.error);
    });
}

function updateTrackInDB(track) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("Database is not ready"));
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(track);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ============================================================
// SONG HELPERS
// ============================================================

function getSongTitle(song) {
    return song?.title || song?.name || "Unknown Song";
}

function getSongArtist(song) {
    return String(song?.artist || song?.director || "Unknown Director").trim().toUpperCase();
}

function getSongSource(song) {
    if (!song) return null;
    if (song.blob) {
        if (!blobUrlCache.has(song.blob)) {
            blobUrlCache.set(song.blob, URL.createObjectURL(song.blob));
        }
        return blobUrlCache.get(song.blob);
    }
    if (song.url) return song.url;
    return null;
}

// ============================================================
// FILTERING & SMART SELECTION (NO REPEATS IN A DAY)
// ============================================================

function getFilteredSongIndexes() {
    const result = [];
    const query = searchQuery.trim().toLowerCase();

    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        if (!song) continue;

        if (activeArtist !== "all" && getSongArtist(song).toLowerCase() !== activeArtist.toLowerCase()) {
            continue;
        }

        if (query) {
            const searchable = [getSongTitle(song), getSongArtist(song), song.name || "", song.director || ""].join(" ").toLowerCase();
            if (!searchable.includes(query)) continue;
        }

        result.push(i);
    }
    return result;
}

function getAutomaticSongIndexes() {
    const result = [];
    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        if (!song) continue;
        if (activeArtist !== "all" && getSongArtist(song).toLowerCase() !== activeArtist.toLowerCase()) {
            continue;
        }
        result.push(i);
    }
    return result;
}

function getNextSmartSongIndex() {
    const pool = getAutomaticSongIndexes();
    if (pool.length === 0) return -1;
    if (pool.length === 1) return pool[0];

    const todayPlayed = getDailyPlayedIds();

    // Songs in current director/all pool not played today
    let candidateIndexes = pool.filter(idx => !todayPlayed.includes(songs[idx]?.id));

    // If every song in this pool has played today, reset queue to full pool
    if (candidateIndexes.length === 0) {
        candidateIndexes = pool.slice();
    }

    // Keep unplayedQueue clean
    unplayedQueue = unplayedQueue.filter(idx => candidateIndexes.includes(idx));

    if (unplayedQueue.length === 0) {
        unplayedQueue = candidateIndexes.filter(idx => idx !== currentIndex);
        if (unplayedQueue.length === 0) unplayedQueue = candidateIndexes.slice();

        // Fisher-Yates Shuffle
        for (let i = unplayedQueue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [unplayedQueue[i], unplayedQueue[j]] = [unplayedQueue[j], unplayedQueue[i]];
        }
    }

    // In "All" mode, alternate between different music directors
    let chosenPointer = 0;
    if (activeArtist === "all" && unplayedQueue.length > 1) {
        const currentDirector = songs[currentIndex] ? getSongArtist(songs[currentIndex]) : null;
        const diffIndex = unplayedQueue.findIndex(idx => getSongArtist(songs[idx]) !== currentDirector);
        if (diffIndex !== -1) chosenPointer = diffIndex;
    }

    return unplayedQueue.splice(chosenPointer, 1)[0];
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

// ============================================================
// PLAYER UI UPDATES
// ============================================================

function updatePlayerInformation(song) {
    const title = document.getElementById("playerTitle");
    const artist = document.getElementById("playerArtist");

    if (!song) {
        if (title) title.textContent = "No track playing";
        if (artist) artist.textContent = "Select a song from your library";
        return;
    }

    if (title) title.textContent = getSongTitle(song);
    if (artist) artist.textContent = getSongArtist(song);
}

function updatePlayButton() {
    const button = document.getElementById("playBtn");
    if (!button) return;
    button.textContent = audio.paused ? "▶" : "❚❚";
}

// ============================================================
// STUCK-FREE PLAYBACK ENGINE
// ============================================================

async function playSongAtIndex(index, isAuto = false) {
    if (index < 0 || index >= songs.length) return false;
    const song = songs[index];
    if (!song) return false;

    const source = getSongSource(song);
    if (!source) {
        console.warn("Unplayable track source. Skipping:", song);
        if (isAuto) playNextAutomaticSong();
        return false;
    }

    const currentGen = ++playbackGeneration;

    // Await active playback promise before resetting
    if (activePlayPromise) {
        try { await activePlayPromise; } catch (e) {}
    }

    // Decoder reset to prevent stalled audio buffers
    try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
    } catch (e) {}

    currentIndex = index;
    audio.src = source;
    audio.currentTime = 0;

    updatePlayerInformation(song);
    renderSongList();
    markSongPlayedToday(song.id);

    try {
        activePlayPromise = audio.play();
        await activePlayPromise;
        activePlayPromise = null;

        if (currentGen === playbackGeneration) {
            updatePlayButton();
            updateMediaSession(song);
            return true;
        }
        return false;
    } catch (error) {
        activePlayPromise = null;
        console.warn("Playback error or aborted:", error);
        if (currentGen === playbackGeneration) {
            updatePlayButton();
            if (isAuto) playNextAutomaticSong();
        }
        return false;
    }
}

async function playNextAutomaticSong() {
    if (isTransitioning) return;
    isTransitioning = true;

    try {
        const pool = getAutomaticSongIndexes();
        if (pool.length === 0) return;

        let attempts = 0;
        const maxAttempts = Math.min(pool.length, 6);

        while (attempts < maxAttempts) {
            attempts++;
            const nextIdx = getNextSmartSongIndex();
            if (nextIdx === -1) break;

            const success = await playSongAtIndex(nextIdx, true);
            if (success) return;
        }

        // Sequential fallback
        const nextPos = (currentIndex + 1) % songs.length;
        await playSongAtIndex(nextPos, true);
    } finally {
        isTransitioning = false;
    }
}

async function togglePlay() {
    if (currentIndex === -1 || !audio.src) {
        await playNextAutomaticSong();
        return;
    }

    if (audio.paused) {
        try {
            await audio.play();
        } catch (e) {
            await playNextAutomaticSong();
        }
    } else {
        audio.pause();
    }
    updatePlayButton();
}

function nextSong() {
    isTransitioning = false;
    playNextAutomaticSong();
}

async function prevSong() {
    isTransitioning = false;
    const filtered = getFilteredSongIndexes();
    if (filtered.length === 0) return;

    const pos = filtered.indexOf(currentIndex);
    const prevIndex = pos <= 0 ? filtered[filtered.length - 1] : filtered[pos - 1];
    await playSongAtIndex(prevIndex, false);
}

// ============================================================
// EDIT SONG MODAL / PROMPT
// ============================================================

async function editSong(index) {
    const song = songs[index];
    if (!song) return;

    const newTitle = prompt("Edit song title:", getSongTitle(song));
    if (newTitle === null) return;

    const newDirector = prompt("Edit music director:", getSongArtist(song));
    if (newDirector === null) return;

    song.title = newTitle.trim() || song.title;
    song.artist = newDirector.trim().toUpperCase() || song.artist;
    song.director = song.artist;

    if (song.id !== undefined && song.id !== null) {
        await updateTrackInDB(song);
    }

    updateArtistFilter();
    renderSongList();

    if (currentIndex === index) {
        updatePlayerInformation(song);
        updateMediaSession(song);
    }
}

// ============================================================
// MEDIA SESSION (AIRPODS & LOCKSCREEN)
// ============================================================

function updateMediaSession(song) {
    if (!("mediaSession" in navigator) || !song) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: getSongTitle(song),
            artist: getSongArtist(song),
            album: "Rishi Music"
        });
        updateMediaPosition();
    } catch (e) {}
}

function updateMediaPosition() {
    if (!("mediaSession" in navigator)) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    try {
        if ("setPositionState" in navigator.mediaSession) {
            navigator.mediaSession.setPositionState({
                duration: audio.duration,
                playbackRate: audio.playbackRate || 1,
                position: Math.min(audio.currentTime, audio.duration)
            });
        }
    } catch (e) {}
}

function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => {
        audio.pause();
        updatePlayButton();
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => nextSong());
    navigator.mediaSession.setActionHandler("previoustrack", () => prevSong());

    try {
        navigator.mediaSession.setActionHandler("seekforward", (details) => {
            const skip = details.seekOffset || 10;
            audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + skip);
            updateMediaPosition();
        });
        navigator.mediaSession.setActionHandler("seekbackward", (details) => {
            const skip = details.seekOffset || 10;
            audio.currentTime = Math.max(0, audio.currentTime - skip);
            updateMediaPosition();
        });
        navigator.mediaSession.setActionHandler("seekto", (details) => {
            if (details.seekTime !== undefined && Number.isFinite(details.seekTime)) {
                audio.currentTime = details.seekTime;
                updateMediaPosition();
            }
        });
    } catch (e) {}
}

// ============================================================
// ARTIST FILTER
// ============================================================

function getArtists() {
    const artists = new Set();
    songs.forEach(song => {
        const artist = getSongArtist(song);
        if (artist && artist !== "UNKNOWN ARTIST" && artist !== "UNKNOWN DIRECTOR") {
            artists.add(artist);
        }
    });
    return Array.from(artists).sort((a, b) => a.localeCompare(b));
}

function updateArtistFilter() {
    const filter = document.getElementById("directorFilter");
    if (!filter) return;

    filter.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "ALL DIRECTORS";
    filter.appendChild(allOption);

    getArtists().forEach(artist => {
        const option = document.createElement("option");
        option.value = artist;
        option.textContent = artist;
        filter.appendChild(option);
    });

    const exists = Array.from(filter.options).some(opt => opt.value === activeArtist);
    filter.value = exists ? activeArtist : "all";
    activeArtist = filter.value;
}

function updateSongCount() {
    const count = document.getElementById("trackCountBadge");
    if (count) count.textContent = `${songs.length} song${songs.length === 1 ? "" : "s"}`;
}

// ============================================================
// RENDER SONG LIST WITH ATTRACTIVE PLAY & EDIT BUTTONS
// ============================================================

function renderSongList() {
    const container = document.getElementById("songListContainer") || document.querySelector(".song-list");
    if (!container) return;

    const filtered = getFilteredSongIndexes();
    container.innerHTML = "";

    if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-library";
        empty.style.padding = "24px";
        empty.style.textAlign = "center";
        empty.style.color = "rgba(255,255,255,0.5)";
        empty.textContent = songs.length === 0 ? "No songs uploaded yet" : "No songs found";
        container.appendChild(empty);
        return;
    }

    const todayPlayed = getDailyPlayedIds();

    filtered.forEach(index => {
        const song = songs[index];
        const isCurrent = index === currentIndex;
        const isPlaying = isCurrent && !audio.paused;
        const playedToday = todayPlayed.includes(song.id);

        const card = document.createElement("div");
        card.className = "song-card" + (isCurrent ? " active" : "");

        // Song Information
        const info = document.createElement("div");
        info.className = "song-info";

        const icon = document.createElement("span");
        icon.className = "song-icon";
        icon.textContent = "♫";

        const meta = document.createElement("div");
        meta.className = "song-meta";

        const title = document.createElement("h4");
        title.textContent = getSongTitle(song);

        const artist = document.createElement("p");
        artist.textContent = getSongArtist(song) + (playedToday ? " • PLAYED TODAY" : "");

        meta.appendChild(title);
        meta.appendChild(artist);
        info.appendChild(icon);
        info.appendChild(meta);

        // Action Buttons Container
        const actions = document.createElement("div");
        actions.className = "song-actions";
        actions.style.display = "flex";
        actions.style.alignItems = "center";
        actions.style.gap = "8px";

        // Attractive Edit Button
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn-edit-action";
        editBtn.innerHTML = "✎ Edit";
        editBtn.style.padding = "6px 12px";
        editBtn.style.fontSize = "0.72rem";
        editBtn.style.fontWeight = "700";
        editBtn.style.color = "#70e1ff";
        editBtn.style.background = "rgba(0, 180, 216, 0.12)";
        editBtn.style.border = "1px solid rgba(0, 210, 255, 0.35)";
        editBtn.style.borderRadius = "12px";
        editBtn.style.cursor = "pointer";
        editBtn.style.backdropFilter = "blur(8px)";
        editBtn.onclick = (e) => {
            e.stopPropagation();
            editSong(index);
        };

        // Attractive Play/Pause Button
        const playButton = document.createElement("button");
        playButton.type = "button";
        playButton.className = "play-mini";
        playButton.style.width = "36px";
        playButton.style.height = "36px";
        playButton.style.borderRadius = "50%";
        playButton.style.display = "flex";
        playButton.style.alignItems = "center";
        playButton.style.justifyContent = "center";
        playButton.style.border = "1px solid rgba(255, 255, 255, 0.5)";
        playButton.style.borderTop = "1px solid #ffffff";
        playButton.style.background = isPlaying
            ? "linear-gradient(145deg, #00f0ff, #0077b6)"
            : "linear-gradient(145deg, #56ccf2, #2f80ed)";
        playButton.style.boxShadow = "inset 0 1px 2px rgba(255,255,255,0.7), 0 4px 14px rgba(0,180,216,0.5)";
        playButton.style.color = "#fff";
        playButton.style.cursor = "pointer";
        playButton.textContent = isPlaying ? "❚❚" : "▶";

        playButton.onclick = (e) => {
            e.stopPropagation();
            if (isCurrent) {
                togglePlay();
            } else {
                playSongAtIndex(index, false);
            }
        };

        actions.appendChild(editBtn);
        actions.appendChild(playButton);

        card.appendChild(info);
        card.appendChild(actions);

        card.onclick = () => playSongAtIndex(index, false);
        container.appendChild(card);
    });
}

// ============================================================
// IMPORT SONGS
// ============================================================

async function importSongs(files) {
    if (!files || files.length === 0) return;
    if (!db) {
        alert("Music library is still loading. Please try again.");
        return;
    }

    for (const file of files) {
        if (!file.type.startsWith("audio/")) continue;

        const filename = file.name.replace(/\.[^/.]+$/, "").trim();
        const track = {
            title: filename || "Unknown Song",
            name: file.name,
            artist: "UNKNOWN DIRECTOR",
            director: "UNKNOWN DIRECTOR",
            blob: file,
            type: file.type,
            size: file.size,
            createdAt: Date.now()
        };

        try {
            const id = await saveTrackToDB(track);
            track.id = id;
            songs.push(track);
        } catch (e) {
            console.error("Save error:", file.name, e);
        }
    }

    songs.sort((a, b) => (a.id || 0) - (b.id || 0));
    unplayedQueue = [];
    updateArtistFilter();
    updateSongCount();
    renderSongList();

    const input = document.getElementById("audioFileInput");
    if (input) input.value = "";
}

// ============================================================
// AUDIO EVENTS
// ============================================================

audio.addEventListener("play", () => {
    updatePlayButton();
    renderSongList();
    if ("mediaSession" in navigator) {
        try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
    }
});

audio.addEventListener("pause", () => {
    updatePlayButton();
    renderSongList();
    if ("mediaSession" in navigator) {
        try { navigator.mediaSession.playbackState = "paused"; } catch (e) {}
    }
});

audio.addEventListener("ended", () => {
    // Automatically advance to the next song without stuck cycles
    playNextAutomaticSong();
});

audio.addEventListener("error", (e) => {
    console.error("Audio error encountered:", e);
    updatePlayButton();
    playNextAutomaticSong();
});

audio.addEventListener("loadedmetadata", () => {
    const totalTime = document.getElementById("totalTime");
    if (totalTime) totalTime.textContent = formatTime(audio.duration);
    updateMediaPosition();
});

audio.addEventListener("timeupdate", () => {
    const currentTime = document.getElementById("currentTime");
    const progressBar = document.getElementById("progressBar");

    if (currentTime) currentTime.textContent = formatTime(audio.currentTime);
    if (progressBar && Number.isFinite(audio.duration) && audio.duration > 0) {
        progressBar.value = (audio.currentTime / audio.duration) * 100;
    }
    updateMediaPosition();
});

// ============================================================
// CONTROL SETUP
// ============================================================

function setupControls() {
    const importInput = document.getElementById("audioFileInput");
    if (importInput) {
        importInput.addEventListener("change", (e) => importSongs(Array.from(e.target.files)));
    }

    document.getElementById("playBtn")?.addEventListener("click", togglePlay);
    document.getElementById("nextBtn")?.addEventListener("click", nextSong);
    document.getElementById("prevBtn")?.addEventListener("click", prevSong);

    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            searchQuery = searchInput.value;
            renderSongList();
        });
    }

    const filter = document.getElementById("directorFilter");
    if (filter) {
        filter.addEventListener("change", () => {
            activeArtist = filter.value;
            unplayedQueue = [];
            renderSongList();
        });
    }

    const progressBar = document.getElementById("progressBar");
    if (progressBar) {
        progressBar.addEventListener("input", () => {
            if (Number.isFinite(audio.duration) && audio.duration > 0) {
                audio.currentTime = (Number(progressBar.value) / 100) * audio.duration;
            }
        });
    }

    const muteBtn = document.getElementById("muteBtn");
    if (muteBtn) {
        muteBtn.addEventListener("click", () => {
            audio.muted = !audio.muted;
            muteBtn.textContent = audio.muted ? "🔇" : "🔊";
        });
    }

    const volumeBar = document.getElementById("volumeBar");
    if (volumeBar) {
        audio.volume = Number(volumeBar.value);
        volumeBar.addEventListener("input", () => {
            audio.volume = Number(volumeBar.value);
            audio.muted = audio.volume === 0;
        });
    }
}

// ============================================================
// INITIALIZE
// ============================================================

async function initializeApp() {
    try {
        await openDatabase();
        songs = await loadAllTracksFromDB();
        songs.sort((a, b) => (a.id || 0) - (b.id || 0));

        updateArtistFilter();
        updateSongCount();
        renderSongList();
        updatePlayerInformation(null);
        updatePlayButton();
        setupMediaSession();
    } catch (error) {
        console.error("Initialization failed:", error);
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    setupControls();
    await initializeApp();
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
}

window.addEventListener("beforeunload", () => {
    if (audio) audio.pause();
    playbackGeneration++;
});
