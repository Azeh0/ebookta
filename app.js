// Immediately log that the script is loading
console.log('app.js: Script starting...');

import { loadTextToSpeech, loadVoiceStyle, writeWavFile, configureEnv } from './helper.js';

console.log('app.js: Imports successful');

// ============================================
// UI Yielding Helper - Prevents browser freeze
// ============================================
function yieldToUI() {
    return new Promise(resolve => {
        // Use requestAnimationFrame + setTimeout for better responsiveness
        requestAnimationFrame(() => setTimeout(resolve, 0));
    });
}

// ============================================
// IndexedDB Audio Storage - Streams chunks to disk instead of RAM
// ============================================
const AudioDB = {
    DB_NAME: 'AudiobookGeneratorDB',
    STORE_NAME: 'audioChunks',
    META_STORE: 'metadata',
    db: null,
    
    async init() {
        if (this.db) return this.db;
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, 1);
            
            request.onerror = () => reject(request.error);
            
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Store for audio chunks
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                }
                
                // Store for metadata (total chunks, sample rate, etc.)
                if (!db.objectStoreNames.contains(this.META_STORE)) {
                    db.createObjectStore(this.META_STORE, { keyPath: 'key' });
                }
            };
        });
    },
    
    async saveChunk(id, audioData) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            
            // Convert Float32Array to regular array for storage
            const request = store.put({ 
                id, 
                data: Array.from(audioData),
                length: audioData.length 
            });
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },
    
    async getChunk(id) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.get(id);
            
            request.onsuccess = () => {
                if (request.result) {
                    resolve(new Float32Array(request.result.data));
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    },
    
    async getChunkCount() {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.count();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },
    
    async saveMeta(key, value) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.META_STORE, 'readwrite');
            const store = tx.objectStore(this.META_STORE);
            const request = store.put({ key, value });
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },
    
    async getMeta(key) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.META_STORE, 'readonly');
            const store = tx.objectStore(this.META_STORE);
            const request = store.get(key);
            
            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
    },
    
    async clear() {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.STORE_NAME, this.META_STORE], 'readwrite');
            tx.objectStore(this.STORE_NAME).clear();
            tx.objectStore(this.META_STORE).clear();
            
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
    
    async getTotalSamples() {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.openCursor();
            
            let total = 0;
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    total += cursor.value.length;
                    cursor.continue();
                } else {
                    resolve(total);
                }
            };
            request.onerror = () => reject(request.error);
        });
    },
    
    // Combine all chunks and return as WAV blob - optimized version
    // Pass totalChunks and totalSamples from state for instant start (no DB scanning)
    async combineAndExport(sampleRate, onProgress, totalChunks, totalSamples) {
        await this.init();
        
        // If totals not provided, fall back to counting (slower)
        if (!totalChunks) totalChunks = await this.getChunkCount();
        if (!totalSamples) totalSamples = await this.getTotalSamples();
        
        if (totalChunks === 0) return null;
        
        // Create WAV header
        const headerSize = 44;
        const dataSize = totalSamples * 2; // 16-bit = 2 bytes per sample
        const fileSize = headerSize + dataSize;
        
        // For very large files, we'll build the WAV in chunks
        const headerBuffer = new ArrayBuffer(headerSize);
        const headerView = new DataView(headerBuffer);
        
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                headerView.setUint8(offset + i, string.charCodeAt(i));
            }
        };
        
        writeString(0, 'RIFF');
        headerView.setUint32(4, fileSize - 8, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        headerView.setUint32(16, 16, true);
        headerView.setUint16(20, 1, true); // PCM
        headerView.setUint16(22, 1, true); // Mono
        headerView.setUint32(24, sampleRate, true);
        headerView.setUint32(28, sampleRate * 2, true);
        headerView.setUint16(32, 2, true);
        headerView.setUint16(34, 16, true);
        writeString(36, 'data');
        headerView.setUint32(40, dataSize, true);
        
        // Collect all parts
        const parts = [new Uint8Array(headerBuffer)];
        
        // Process chunks in order using sequential get (faster than cursor)
        for (let i = 0; i < totalChunks; i++) {
            if (onProgress) onProgress(i, totalChunks);
            
            const chunk = await this.getChunk(i);
            if (!chunk) continue;
            
            // Convert Float32 to Int16
            const int16 = new Int16Array(chunk.length);
            for (let j = 0; j < chunk.length; j++) {
                const s = Math.max(-1, Math.min(1, chunk[j]));
                int16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            
            parts.push(new Uint8Array(int16.buffer));
            
            // Yield to prevent UI freeze
            await new Promise(r => setTimeout(r, 0));
        }
        
        return new Blob(parts, { type: 'audio/wav' });
    },
    
    // Get preview audio (first N seconds)
    async getPreview(sampleRate, maxSeconds = 30) {
        await this.init();
        
        const maxSamples = sampleRate * maxSeconds;
        const chunkCount = await this.getChunkCount();
        
        let collected = new Float32Array(0);
        
        for (let i = 0; i < chunkCount && collected.length < maxSamples; i++) {
            const chunk = await this.getChunk(i);
            if (!chunk) continue;
            
            const remaining = maxSamples - collected.length;
            const toAdd = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
            
            const newCollected = new Float32Array(collected.length + toAdd.length);
            newCollected.set(collected);
            newCollected.set(toAdd, collected.length);
            collected = newCollected;
        }
        
        return collected;
    }
};

// ============================================
// Float32 to WAV conversion (avoids AudioBuffer size limits)
// ============================================
function float32ToWav(float32Array, sampleRate) {
    const buffer = new ArrayBuffer(44 + float32Array.length * 2);
    const view = new DataView(buffer);
    
    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + float32Array.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, float32Array.length * 2, true);
    
    let offset = 44;
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
    }
    
    return new Blob([buffer], { type: 'audio/wav' });
}

// ============================================
// Configuration
// ============================================
// Paths - use ./assets for Vercel deployment (assets folder inside web/)
const ASSETS_PATH = './assets';
const ONNX_PATH = `${ASSETS_PATH}/onnx`;
const VOICE_STYLES_PATH = `${ASSETS_PATH}/voice_styles`;

// ============================================
// State
// ============================================
const state = {
    tts: null,
    cfgs: null,
    currentStyle: null,
    text: '',
    audioBuffer: null,
    fullAudioBlob: null,      // Full WAV blob for download (avoids re-encoding)
    fullAudioDuration: 0,     // Full audio duration in seconds
    audioInIndexedDB: false,  // Whether audio chunks are stored in IndexedDB
    audioSampleRate: 44100,   // Sample rate for IndexedDB audio
    totalChunks: 0,           // Total chunks generated (tracked in memory)
    totalSamples: 0,          // Total samples generated (tracked in memory)
    isGenerating: false,
    isCancelled: false,
    audioContext: null,
    sourceNode: null,
    analyser: null,
    startTime: 0,
    pausedTime: 0,
    isPlaying: false,
    animationFrame: null,
    settings: {
        voice: 'M1',
        inferenceSteps: 10,
        speed: 1.0,
        silenceDuration: 0.3,
        executionProvider: 'wasm',
        numThreads: 4
    }
};

// ============================================
// DOM Elements - will be initialized after DOM loads
// ============================================
let el = {};

// ============================================
// Initialize DOM Elements
// ============================================
function initDOMElements() {
    el = {
        // Input
        dropZone: document.getElementById('drop-zone'),
        fileInput: document.getElementById('file-input'),
        chooseFileBtn: document.getElementById('choose-file-btn'),
        editorZone: document.getElementById('editor-zone'),
        textInput: document.getElementById('text-input'),
        clearTextBtn: document.getElementById('clear-text-btn'),
        charCount: document.getElementById('char-count'),
        parsingOverlay: document.getElementById('parsing-overlay'),
        
        // Actions
        generateBtn: document.getElementById('generate-btn'),
        generateBtnText: document.getElementById('generate-btn-text'),
        
        // Progress
        progressContainer: document.getElementById('progress-container'),
        progressStatus: document.getElementById('progress-status'),
        progressPercent: document.getElementById('progress-percent'),
        progressBar: document.getElementById('progress-bar'),
        
        // Player
        playerContainer: document.getElementById('player-container'),
        playPauseBtn: document.getElementById('play-pause-btn'),
        stopBtn: document.getElementById('stop-btn'),
        resetBtn: document.getElementById('reset-btn'),
        downloadBtn: document.getElementById('download-btn'),
        timeCurrent: document.getElementById('time-current'),
        timeTotal: document.getElementById('time-total'),
        timeline: document.getElementById('timeline'),
        timelineProgress: document.getElementById('timeline-progress'),
        canvas: document.getElementById('visualizer-canvas'),
        
        // Error
        errorContainer: document.getElementById('error-container'),
        errorMessage: document.getElementById('error-message'),

        // Settings
        settingsBtn: document.getElementById('settings-btn'),
        settingsModal: document.getElementById('settings-modal'),
        closeSettingsBtn: document.getElementById('close-settings-btn'),
        saveSettingsBtn: document.getElementById('save-settings-btn'),
        voiceSelect: document.getElementById('voice-select'),
        inferenceSteps: document.getElementById('inference-steps'),
        inferenceStepsValue: document.getElementById('inference-steps-value'),
        speed: document.getElementById('speed'),
        speedValue: document.getElementById('speed-value'),
        silenceDuration: document.getElementById('silence-duration'),
        silenceValue: document.getElementById('silence-value'),
        executionProviderSelect: document.getElementById('execution-provider'),
        numThreadsInput: document.getElementById('num-threads'),
        threadsContainer: document.getElementById('threads-container'),
    };
    
    // Debug: log which elements are missing
    for (const [key, value] of Object.entries(el)) {
        if (!value) {
            console.warn(`DOM element not found: ${key}`);
        }
    }
}

// ============================================
// Initialization
// ============================================
async function init() {
    console.log('\n========================================');
    console.log('   APP INITIALIZATION STARTED');
    console.log('========================================');
    console.log('Time:', new Date().toISOString());
    
    try {
        // Load Settings
        console.log('\n[Init] Loading settings...');
        loadSettings();
        console.log('[Init] Settings loaded:', JSON.stringify(state.settings, null, 2));

        // Configure ONNX Env
        console.log('\n[Init] Configuring ONNX environment...');
        if (state.settings.executionProvider === 'wasm') {
            console.log('[Init] Using WASM with', state.settings.numThreads, 'threads');
            configureEnv({ numThreads: state.settings.numThreads });
        } else {
            console.log('[Init] Using execution provider:', state.settings.executionProvider);
        }
        
        // Load TTS Models first to get the sample rate from config
        console.log('\n[Init] Starting TTS model loading...');
        updateGenerateBtn(true, 'Loading AI Models...');
        
        const sessionOptions = {
            executionProviders: [state.settings.executionProvider],
            graphOptimizationLevel: 'all'
        };

        // Configure threads if using WASM
        if (state.settings.executionProvider === 'wasm') {
            sessionOptions.executionProviders = [{
                name: 'wasm'
            }];
        }

        console.log('[Init] Session options:', JSON.stringify(sessionOptions, null, 2));
        console.log('[Init] Loading TTS models from:', ONNX_PATH);
        
        // Progress callback to update UI
        const progressCallback = (modelName, current, total) => {
            const msg = `Loading ${modelName} (${current}/${total})...`;
            console.log('[Init] Progress:', msg);
            updateGenerateBtn(true, msg);
        };
        
        const result = await loadTextToSpeech(ONNX_PATH, sessionOptions, progressCallback);
        state.tts = result.textToSpeech;
        state.cfgs = result.cfgs;
        
        // Initialize Audio Context with the sample rate from the TTS config
        const sampleRate = state.cfgs.ae.sample_rate || 44100;
        console.log('Initializing AudioContext with sample rate:', sampleRate);
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
        
        // Load Default Voice from settings
        console.log('Loading voice style:', state.settings.voice);
        await loadVoiceStyleByName(state.settings.voice);
        
        updateGenerateBtn(false, 'Convert to Audiobook');
        console.log('TTS Initialized successfully');
        
    } catch (err) {
        console.error('Failed to initialize TTS engine:', err);
        showError('Failed to initialize TTS engine: ' + err.message);
    }
}

// ============================================
// Logic
// ============================================

// --- Settings ---
function loadSettings() {
    const defaultSettings = {
        voice: 'M1',
        inferenceSteps: 10,
        speed: 1.0,
        silenceDuration: 0.3,
        executionProvider: 'wasm',
        numThreads: 4
    };

    const stored = localStorage.getItem('lumina_settings');
    state.settings = stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
    
    // Update UI
    updateSettingsUI();
}

function updateSettingsUI() {
    if (el.voiceSelect) {
        el.voiceSelect.value = state.settings.voice;
    }
    if (el.inferenceSteps) {
        el.inferenceSteps.value = state.settings.inferenceSteps;
        if (el.inferenceStepsValue) el.inferenceStepsValue.textContent = state.settings.inferenceSteps;
    }
    if (el.speed) {
        el.speed.value = state.settings.speed;
        if (el.speedValue) el.speedValue.textContent = state.settings.speed + 'x';
    }
    if (el.silenceDuration) {
        el.silenceDuration.value = state.settings.silenceDuration;
        if (el.silenceValue) el.silenceValue.textContent = state.settings.silenceDuration + 's';
    }
    if (el.executionProviderSelect) {
        el.executionProviderSelect.value = state.settings.executionProvider;
        if (el.numThreadsInput) el.numThreadsInput.value = state.settings.numThreads;
        toggleThreadsInput();
    }
}

async function saveSettings() {
    const oldProvider = state.settings.executionProvider;
    const oldThreads = state.settings.numThreads;
    const oldVoice = state.settings.voice;
    
    state.settings.voice = el.voiceSelect.value;
    state.settings.inferenceSteps = parseInt(el.inferenceSteps.value);
    state.settings.speed = parseFloat(el.speed.value);
    state.settings.silenceDuration = parseFloat(el.silenceDuration.value);
    state.settings.executionProvider = el.executionProviderSelect.value;
    state.settings.numThreads = parseInt(el.numThreadsInput.value);
    
    localStorage.setItem('lumina_settings', JSON.stringify(state.settings));
    
    // Only reload if execution provider or threads changed (requires model reload)
    if (oldProvider !== state.settings.executionProvider || oldThreads !== state.settings.numThreads) {
        window.location.reload();
    } else {
        // Just update voice if it changed
        if (oldVoice !== state.settings.voice) {
            await loadVoiceStyleByName(state.settings.voice);
        }
        el.settingsModal.classList.add('hidden');
    }
}

function toggleThreadsInput() {
    if (!el.threadsContainer || !el.executionProviderSelect) return;
    if (el.executionProviderSelect.value === 'webgpu') {
        el.threadsContainer.classList.add('hidden');
    } else {
        el.threadsContainer.classList.remove('hidden');
    }
}

// --- Voice Selection ---
async function loadVoiceStyleByName(name) {
    const stylePath = `${VOICE_STYLES_PATH}/${name}.json`;
    console.log('Loading voice style from:', stylePath);
    state.currentStyle = await loadVoiceStyle([stylePath]);
}

// --- File Processing ---
async function handleFile(file) {
    console.log('Handling file:', file.name);
    
    if (file.name.endsWith('.epub')) {
        if (el.parsingOverlay) el.parsingOverlay.classList.remove('hidden');
        try {
            const text = await extractTextFromEPUB(file);
            setText(text);
        } catch (err) {
            console.error('Failed to parse EPUB:', err);
            showError('Failed to parse EPUB: ' + err.message);
        } finally {
            if (el.parsingOverlay) el.parsingOverlay.classList.add('hidden');
        }
    } else if (file.name.endsWith('.txt')) {
        const text = await file.text();
        setText(text);
    } else {
        showError('Please upload a valid .epub or .txt file');
    }
}

async function extractTextFromEPUB(file) {
    console.log('Extracting text from EPUB...');
    // Dynamic import for JSZip
    const JSZip = await import('https://esm.sh/jszip@3.10.1');
    const zip = await JSZip.default.loadAsync(file);
    
    // Simple extraction strategy: find all HTML/XHTML files and extract text
    let fullText = '';
    const files = Object.keys(zip.files).filter(name => name.endsWith('.html') || name.endsWith('.xhtml'));
    
    // Sort files (naive sorting, ideally parse OPF)
    files.sort();
    
    console.log('Found HTML files:', files.length);
    
    for (const filename of files) {
        const content = await zip.file(filename).async('string');
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'text/html');
        fullText += doc.body.textContent + '\n\n';
    }
    
    return fullText.replace(/\s+/g, ' ').trim();
}

function setText(text) {
    state.text = text;
    if (el.textInput) el.textInput.value = text;
    if (el.charCount) el.charCount.textContent = text.length.toLocaleString();
    
    // Switch view
    if (el.dropZone) el.dropZone.classList.add('hidden');
    if (el.editorZone) el.editorZone.classList.remove('hidden');
    
    updateGenerateBtn(false);
    console.log('Text set, characters:', text.length);
}

function clearText() {
    state.text = '';
    if (el.textInput) el.textInput.value = '';
    if (el.charCount) el.charCount.textContent = '0';
    if (el.dropZone) el.dropZone.classList.remove('hidden');
    if (el.editorZone) el.editorZone.classList.add('hidden');
    updateGenerateBtn(true); // Disable generate
}

// --- Generation ---
async function startGeneration() {
    if (!state.text || !state.tts) {
        console.log('Cannot generate: text or TTS not ready');
        return;
    }
    
    state.isGenerating = true;
    state.isCancelled = false;
    updateGenerateBtn(false, '⏹ Cancel Generation');  // Button stays enabled for cancel
    if (el.progressContainer) el.progressContainer.classList.remove('hidden');
    if (el.playerContainer) el.playerContainer.classList.add('hidden');
    
    try {
        // Initialize IndexedDB and clear previous data
        await AudioDB.init();
        await AudioDB.clear();
        
        // 1. Chunk Text
        const chunks = chunkText(state.text);
        
        // Get settings
        const { inferenceSteps, speed, silenceDuration } = state.settings;
        const sampleRate = state.tts.sampleRate;
        
        console.log('Processing', chunks.length, 'chunks with settings:', { inferenceSteps, speed, silenceDuration });
        console.log('Using IndexedDB streaming for memory efficiency');
        
        // Track totals in memory (fast - no DB queries during generation)
        let totalSamplesGenerated = 0;
        let chunksGenerated = 0;
        
        // ETA tracking (lightweight - rolling average of last 5 chunks)
        const chunkTimes = [];
        const MAX_TIME_SAMPLES = 5;
        
        // Build preview in memory during generation (first 30 seconds only)
        let previewAudio = new Float32Array(0);
        const MAX_PREVIEW_SAMPLES = sampleRate * 30;
        
        // 2. Process Chunks - stream directly to IndexedDB
        for (let i = 0; i < chunks.length; i++) {
            if (state.isCancelled) {
                console.log('Generation cancelled by user');
                await AudioDB.clear();
                break;
            }
            
            // Start timing this chunk
            const chunkStartTime = performance.now();
            
            // Calculate ETA from previous chunks
            let etaText = '';
            if (chunkTimes.length > 0) {
                const avgTimePerChunk = chunkTimes.reduce((a, b) => a + b, 0) / chunkTimes.length;
                const remainingChunks = chunks.length - i;
                const etaSeconds = Math.round((avgTimePerChunk * remainingChunks) / 1000);
                
                if (etaSeconds < 60) {
                    etaText = ` • ETA: ${etaSeconds}s`;
                } else if (etaSeconds < 3600) {
                    const mins = Math.floor(etaSeconds / 60);
                    const secs = etaSeconds % 60;
                    etaText = ` • ETA: ${mins}m ${secs}s`;
                } else {
                    const hours = Math.floor(etaSeconds / 3600);
                    const mins = Math.floor((etaSeconds % 3600) / 60);
                    etaText = ` • ETA: ${hours}h ${mins}m`;
                }
            }
            
            const chunk = chunks[i];
            updateProgress(i, chunks.length, `Generating ${i+1}/${chunks.length}${etaText}`);
            
            // Yield to let UI update before heavy processing
            await yieldToUI();
            
            // Generate with settings
            const { wav, duration } = await state.tts.call(
                chunk,
                state.currentStyle,
                inferenceSteps,
                speed,
                silenceDuration
            );
            
            // Track chunk time for ETA
            const chunkTime = performance.now() - chunkStartTime;
            chunkTimes.push(chunkTime);
            if (chunkTimes.length > MAX_TIME_SAMPLES) {
                chunkTimes.shift(); // Keep only last N samples
            }
            
            // Ensure wav is a Float32Array
            const wavArray = wav instanceof Float32Array ? wav : new Float32Array(wav);
            
            // Save chunk to IndexedDB (fast, just a put operation)
            await AudioDB.saveChunk(i, wavArray);
            
            // Track totals in memory (instant, no DB query)
            totalSamplesGenerated += wavArray.length;
            chunksGenerated++;
            
            // Build preview audio in memory (only first 30 seconds)
            if (previewAudio.length < MAX_PREVIEW_SAMPLES) {
                const remainingSpace = MAX_PREVIEW_SAMPLES - previewAudio.length;
                const samplesToAdd = Math.min(wavArray.length, remainingSpace);
                const newPreview = new Float32Array(previewAudio.length + samplesToAdd);
                newPreview.set(previewAudio);
                newPreview.set(wavArray.slice(0, samplesToAdd), previewAudio.length);
                previewAudio = newPreview;
            }
            
            const totalDuration = totalSamplesGenerated / sampleRate;
            console.log(`Chunk ${i+1}/${chunks.length} saved, total: ${totalDuration.toFixed(2)}s, chunk took: ${(chunkTime/1000).toFixed(1)}s`);
            
            // Yield to allow garbage collection and UI updates
            await yieldToUI();
        }
        
        if (!state.isCancelled) {
            // Store totals in state (for download function)
            state.totalChunks = chunksGenerated;
            state.totalSamples = totalSamplesGenerated;
            state.fullAudioDuration = totalSamplesGenerated / sampleRate;
            state.audioInIndexedDB = true;
            state.audioSampleRate = sampleRate;
            
            // Create preview for player from memory (no DB read needed)
            if (previewAudio.length > 0) {
                updateProgress(chunks.length, chunks.length, 'Preparing player...');
                const previewWavBlob = float32ToWav(previewAudio, sampleRate);
                const arrayBuffer = await previewWavBlob.arrayBuffer();
                state.audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
            }
            
            // Show Player
            showPlayer();
        }
        
    } catch (err) {
        console.error('Generation failed:', err);
        showError('Generation failed: ' + err.message);
        await AudioDB.clear();
    } finally {
        state.isGenerating = false;
        updateGenerateBtn(false, 'Convert to Audiobook');
        if (el.progressContainer) el.progressContainer.classList.add('hidden');
    }
}

function chunkText(text, maxChars = 450) {
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const chunks = [];
    let current = '';
    
    for (const s of sentences) {
        if (current.length + s.length < maxChars) {
            current += s;
        } else {
            if (current.trim()) chunks.push(current.trim());
            current = s;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

// concatenateAudioBuffers removed - now using progressive Float32Array combination

function updateProgress(current, total, status) {
    const percent = Math.round((current / total) * 100);
    if (el.progressBar) el.progressBar.style.width = `${percent}%`;
    if (el.progressPercent) el.progressPercent.textContent = `${percent}%`;
    if (el.progressStatus) el.progressStatus.textContent = status;
}

// --- Player ---
function showPlayer() {
    if (el.playerContainer) el.playerContainer.classList.remove('hidden');
    // Use full audio duration if available, otherwise preview duration
    const duration = state.fullAudioDuration || state.audioBuffer.duration;
    if (el.timeTotal) el.timeTotal.textContent = formatTime(duration);
    
    // Update download button text based on duration
    if (el.downloadBtn) {
        const minutes = Math.floor(duration / 60);
        const seconds = Math.floor(duration % 60);
        const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        if (state.audioInIndexedDB) {
            el.downloadBtn.textContent = `Download Full Audio (${durationStr})`;
            el.downloadBtn.title = 'Audio will be combined from storage on download';
        } else {
            el.downloadBtn.textContent = `Download (${durationStr})`;
        }
    }
    
    // Show note if playing preview only
    if (state.audioInIndexedDB && state.audioBuffer) {
        const previewDuration = state.audioBuffer.duration;
        if (previewDuration < duration) {
            console.log(`Playing preview (${previewDuration.toFixed(1)}s) of full audio (${duration.toFixed(1)}s)`);
        }
    }
    
    drawVisualizer();
}

function playAudio() {
    if (state.isPlaying) {
        pauseAudio();
        return;
    }
    
    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }
    
    state.sourceNode = state.audioContext.createBufferSource();
    state.sourceNode.buffer = state.audioBuffer;
    
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 256;
    
    state.sourceNode.connect(state.analyser);
    state.analyser.connect(state.audioContext.destination);
    
    state.startTime = state.audioContext.currentTime - state.pausedTime;
    state.sourceNode.start(0, state.pausedTime);
    state.isPlaying = true;
    
    state.sourceNode.onended = () => {
        if (state.isPlaying) { // Natural end
            state.isPlaying = false;
            state.pausedTime = 0;
            updatePlayerUI();
        }
    };
    
    updatePlayerUI();
    requestAnimationFrame(updatePlayerLoop);
}

function pauseAudio() {
    if (state.sourceNode) {
        state.sourceNode.stop();
        state.pausedTime = state.audioContext.currentTime - state.startTime;
        state.sourceNode = null;
    }
    state.isPlaying = false;
    updatePlayerUI();
}

function stopAudio() {
    if (state.sourceNode) {
        state.sourceNode.stop();
        state.sourceNode = null;
    }
    state.isPlaying = false;
    state.pausedTime = 0;
    updatePlayerUI();
    if (el.timelineProgress) el.timelineProgress.style.width = '0%';
    if (el.timeCurrent) el.timeCurrent.textContent = '0:00';
}

function updatePlayerLoop() {
    if (!state.isPlaying) return;
    
    const current = state.audioContext.currentTime - state.startTime;
    const percent = (current / state.audioBuffer.duration) * 100;
    
    if (el.timelineProgress) el.timelineProgress.style.width = `${Math.min(percent, 100)}%`;
    if (el.timeCurrent) el.timeCurrent.textContent = formatTime(current);
    
    drawVisualizer();
    
    if (current < state.audioBuffer.duration) {
        requestAnimationFrame(updatePlayerLoop);
    }
}

function drawVisualizer() {
    if (!el.canvas) return;
    
    const canvas = el.canvas;
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;
    
    ctx.clearRect(0, 0, width, height);
    
    if (!state.analyser) {
        // Draw idle line
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
    }
    
    const bufferLength = state.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    state.analyser.getByteFrequencyData(dataArray);
    
    const barWidth = (width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * height;
        
        const r = 16 + (barHeight / height) * 20;
        const g = 185;
        const b = 129;
        
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
        
        x += barWidth + 1;
    }
}

function updatePlayerUI() {
    if (!el.playPauseBtn) return;
    
    const icon = el.playPauseBtn.querySelector('i');
    if (icon) {
        if (state.isPlaying) {
            icon.setAttribute('data-lucide', 'pause');
            icon.classList.remove('ml-1');
        } else {
            icon.setAttribute('data-lucide', 'play');
            icon.classList.add('ml-1');
        }
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }
}

async function downloadAudio() {
    // Check if audio is stored in IndexedDB
    if (state.audioInIndexedDB) {
        // Show progress while combining
        if (el.progressContainer) el.progressContainer.classList.remove('hidden');
        
        // Use stored values (no DB query needed)
        const totalChunks = state.totalChunks;
        const sampleRate = state.audioSampleRate;
        
        if (!totalChunks || totalChunks === 0) {
            showError('No audio to download');
            if (el.progressContainer) el.progressContainer.classList.add('hidden');
            return;
        }
        
        updateProgress(0, totalChunks, `Combining ${totalChunks} chunks...`);
        
        try {
            // Pass totalChunks and totalSamples so it doesn't have to scan the DB
            const blob = await AudioDB.combineAndExport(
                sampleRate,
                (current, total) => {
                    const percent = Math.round((current / total) * 100);
                    updateProgress(current, total, `Combining: ${percent}%`);
                },
                totalChunks,
                state.totalSamples
            );
            
            if (blob) {
                updateProgress(totalChunks, totalChunks, 'Starting download...');
                
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `audiobook_${Date.now()}.wav`;
                a.click();
                
                // Clean up
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                
                // Clear IndexedDB after successful download
                await AudioDB.clear();
                state.audioInIndexedDB = false;
                state.totalChunks = 0;
                state.totalSamples = 0;
                
                updateProgress(totalChunks, totalChunks, 'Download complete!');
            }
        } catch (err) {
            console.error('Download failed:', err);
            showError('Download failed: ' + err.message);
        } finally {
            if (el.progressContainer) el.progressContainer.classList.add('hidden');
        }
        return;
    }
    
    // Fallback: Use pre-generated full audio blob if available
    const blob = state.fullAudioBlob || (() => {
        if (!state.audioBuffer) return null;
        const channelData = state.audioBuffer.getChannelData(0);
        return float32ToWav(channelData, state.audioBuffer.sampleRate);
    })();
    
    if (!blob) return;
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lumina-audiobook.wav';
    a.click();
    URL.revokeObjectURL(url);
}

// --- UI Helpers ---
function updateGenerateBtn(disabled, text) {
    if (!el.generateBtn) return;
    
    // During generation, keep button enabled for cancel functionality
    const isGenerating = state.isGenerating && !state.isCancelled;
    const shouldDisable = disabled && !isGenerating;
    
    el.generateBtn.disabled = shouldDisable;
    if (shouldDisable) {
        el.generateBtn.classList.add('bg-slate-300', 'cursor-not-allowed');
        el.generateBtn.classList.remove('bg-slate-900', 'bg-red-600', 'hover:bg-brand-600', 'hover:bg-red-700', 'hover:shadow-brand-200/50', 'hover:-translate-y-1');
    } else if (isGenerating) {
        // Show cancel style during generation
        el.generateBtn.classList.remove('bg-slate-300', 'bg-slate-900', 'cursor-not-allowed', 'hover:bg-brand-600');
        el.generateBtn.classList.add('bg-red-600', 'hover:bg-red-700', 'hover:-translate-y-1');
    } else {
        el.generateBtn.classList.remove('bg-slate-300', 'bg-red-600', 'cursor-not-allowed', 'hover:bg-red-700');
        el.generateBtn.classList.add('bg-slate-900', 'hover:bg-brand-600', 'hover:shadow-brand-200/50', 'hover:-translate-y-1');
    }
    if (text && el.generateBtnText) el.generateBtnText.textContent = text;
}

function showError(msg) {
    console.error('Error:', msg);
    if (el.errorMessage) el.errorMessage.textContent = msg;
    if (el.errorContainer) {
        el.errorContainer.classList.remove('hidden');
        setTimeout(() => el.errorContainer.classList.add('hidden'), 5000);
    }
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================
// Event Listeners Setup
// ============================================
function setupEventListeners() {
    console.log('Setting up event listeners...');
    
    // File upload - Click on drop zone
    if (el.dropZone) {
        el.dropZone.addEventListener('click', (e) => {
            // Don't trigger if clicking the button (it has its own handler)
            if (el.chooseFileBtn && (e.target === el.chooseFileBtn || el.chooseFileBtn.contains(e.target))) {
                return;
            }
            if (el.fileInput) el.fileInput.click();
        });
        
        // Drag and drop handling
        el.dropZone.addEventListener('dragover', (e) => { 
            e.preventDefault(); 
            el.dropZone.classList.add('border-brand-500', 'bg-brand-50'); 
        });
        el.dropZone.addEventListener('dragleave', () => { 
            el.dropZone.classList.remove('border-brand-500', 'bg-brand-50'); 
        });
        el.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            el.dropZone.classList.remove('border-brand-500', 'bg-brand-50');
            if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
        });
    }

    if (el.chooseFileBtn) {
        el.chooseFileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log('Choose file button clicked');
            if (el.fileInput) el.fileInput.click();
        });
    }

    if (el.fileInput) {
        el.fileInput.addEventListener('change', (e) => {
            console.log('File input changed');
            if (e.target.files.length) handleFile(e.target.files[0]);
        });
    }

    if (el.textInput) {
        el.textInput.addEventListener('input', (e) => {
            state.text = e.target.value;
            if (el.charCount) el.charCount.textContent = state.text.length.toLocaleString();
            updateGenerateBtn(!state.text.trim());
        });
    }

    if (el.clearTextBtn) {
        el.clearTextBtn.addEventListener('click', clearText);
    }

    if (el.generateBtn) {
        el.generateBtn.addEventListener('click', () => {
            if (state.isGenerating) {
                // Cancel if currently generating
                state.isCancelled = true;
                updateGenerateBtn(true, 'Cancelling...');
            } else {
                startGeneration();
            }
        });
    }

    if (el.playPauseBtn) {
        el.playPauseBtn.addEventListener('click', playAudio);
    }
    
    if (el.stopBtn) {
        el.stopBtn.addEventListener('click', stopAudio);
    }
    
    if (el.resetBtn) {
        el.resetBtn.addEventListener('click', () => {
            stopAudio();
            if (el.playerContainer) el.playerContainer.classList.add('hidden');
            if (el.editorZone) el.editorZone.classList.remove('hidden');
        });
    }
    
    if (el.downloadBtn) {
        el.downloadBtn.addEventListener('click', downloadAudio);
    }

    // Settings
    if (el.settingsBtn) {
        el.settingsBtn.addEventListener('click', () => {
            console.log('Settings button clicked');
            if (el.settingsModal) el.settingsModal.classList.remove('hidden');
        });
    }
    
    if (el.closeSettingsBtn) {
        el.closeSettingsBtn.addEventListener('click', () => {
            console.log('Close settings button clicked');
            if (el.settingsModal) el.settingsModal.classList.add('hidden');
        });
    }
    
    if (el.saveSettingsBtn) {
        el.saveSettingsBtn.addEventListener('click', saveSettings);
    }
    
    if (el.executionProviderSelect) {
        el.executionProviderSelect.addEventListener('change', toggleThreadsInput);
    }

    // Settings sliders real-time update
    if (el.inferenceSteps) {
        el.inferenceSteps.addEventListener('input', (e) => {
            if (el.inferenceStepsValue) el.inferenceStepsValue.textContent = e.target.value;
        });
    }
    
    if (el.speed) {
        el.speed.addEventListener('input', (e) => {
            if (el.speedValue) el.speedValue.textContent = parseFloat(e.target.value).toFixed(2) + 'x';
        });
    }
    
    if (el.silenceDuration) {
        el.silenceDuration.addEventListener('input', (e) => {
            if (el.silenceValue) el.silenceValue.textContent = parseFloat(e.target.value).toFixed(1) + 's';
        });
    }
    
    console.log('Event listeners setup complete');
}

// ============================================
// Start Application
// ============================================
function startApp() {
    console.log('app.js: startApp() called');
    try {
        initDOMElements();
        console.log('app.js: DOM elements initialized');
        setupEventListeners();
        console.log('app.js: Event listeners set up');
        init();
    } catch (err) {
        console.error('app.js: Error in startApp:', err);
    }
}

// Wait for DOM to be ready
console.log('app.js: Document readyState:', document.readyState);
if (document.readyState === 'loading') {
    console.log('app.js: Adding DOMContentLoaded listener');
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    // DOM is already ready
    console.log('app.js: DOM already ready, calling startApp immediately');
    startApp();
}
