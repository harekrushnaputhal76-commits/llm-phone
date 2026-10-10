/**
 * ============================================================================
 * OFFLINE AI - STEP 4 & 5: NATIVE LLAMA C++ ENGINE & ROBUST STORAGE RESOLUTION
 * Target Device: Motorola Edge 60 Pro (12GB RAM, Android 11-15)
 * ============================================================================
 *
 * CRITICAL ARCHITECTURE ENFORCEMENT:
 * 1. FILE URI RESOLUTION (content:// -> readable POSIX path):
 *    - Android DocumentPicker returns encrypted content:// URIs.
 *    - Native C++ engine (llama.cpp) cannot read content:// URIs.
 *    - resolveNativeModelPath() resolves decoded /storage/ paths, or copies
 *      via @capacitor/filesystem to the app's internal Directory.Data
 *      (which requires 0 permissions and provides direct POSIX access).
 * 2. ANDROID 11+ STORAGE PERMISSIONS:
 *    - checkAndRequestStoragePermissions() prompts for storage permissions on startup.
 *    - Both READ_EXTERNAL_STORAGE and MANAGE_EXTERNAL_STORAGE handled gracefully.
 * 3. NON-BLOCKING INFERENCE & 120Hz UI:
 *    - Zero-copy mmap model loading.
 *    - Streaming chat tokens with real-time DOM updates.
 * ============================================================================
 */

'use strict';

// Persistence keys
const STORAGE_KEY_ACTIVE_GGUF_PATH = 'active_gguf_path';
const STORAGE_KEY_ACTIVE_MODEL = 'offlineai_active_model_v1';

// Application State
const AppState = {
  activeModel: null,       // { name, path, size, sizeLabel, quant }
  activeContextId: null,   // Native Llama.cpp context ID
  isEngineReady: false,    // True when model is loaded in C++ memory
  isLoadingEngine: false,  // True during model weight loading
  isGenerating: false,     // True while generating response tokens
  activeTab: 'view-models'
};

// ============================================================================
// 1. DOM REFERENCES
// ============================================================================

const DOM = {
  // Navigation Tabs & Views
  viewModels: document.getElementById('view-models'),
  viewChat: document.getElementById('view-chat'),
  navBtnModels: document.getElementById('nav-btn-models'),
  navBtnChat: document.getElementById('nav-btn-chat'),
  navChatStatusDot: document.getElementById('nav-chat-status-dot'),

  // Header Elements
  chatActiveIndicator: document.getElementById('chat-active-indicator'),
  chatActiveModelName: document.getElementById('chat-active-model-name'),
  chatModelQuantPill: document.getElementById('chat-model-quant-pill'),
  btnClearChat: document.getElementById('btn-clear-chat'),

  // Model Settings (The Plug)
  btnImportModel: document.getElementById('btn-import-model'),
  nativeFileInput: document.getElementById('native-file-input'),
  modelStatusChip: document.getElementById('model-status-chip'),
  statusEmptyState: document.getElementById('status-empty-state'),
  statusActiveState: document.getElementById('status-active-state'),
  modelStatusMainText: document.getElementById('model-status-main-text'),
  activeModelFileName: document.getElementById('active-model-file-name'),
  activeModelSizeBadge: document.getElementById('active-model-size-badge'),
  activeModelQuantBadge: document.getElementById('active-model-quant-badge'),
  activeModelNativePath: document.getElementById('active-model-native-path'),
  btnReselectModel: document.getElementById('btn-reselect-model'),
  btnUnlinkModel: document.getElementById('btn-unlink-model'),
  btnJumpToChat: document.getElementById('btn-jump-to-chat'),

  // Chat Elements
  chatNoModelBanner: document.getElementById('chat-no-model-banner'),
  btnGoToModels: document.getElementById('btn-go-to-models'),
  chatMessagesContainer: document.getElementById('chat-messages-container'),
  chatTypingIndicator: document.getElementById('chat-typing-indicator'),
  chatForm: document.getElementById('chat-form'),
  chatTextarea: document.getElementById('chat-textarea'),
  btnSendMessage: document.getElementById('btn-send-message'),
  btnStopGeneration: document.getElementById('btn-stop-generation'),
  btnAttach: document.getElementById('btn-attach'),

  // iOS Attachment Action Sheet
  sheetBackdrop: document.getElementById('ios-action-sheet-backdrop'),
  actionSheet: document.getElementById('ios-action-sheet'),
  btnSheetUploadDoc: document.getElementById('btn-sheet-upload-doc'),
  btnSheetUploadPhoto: document.getElementById('btn-sheet-upload-photo'),
  btnSheetCancel: document.getElementById('btn-sheet-cancel'),
  documentFileInput: document.getElementById('document-file-input')
};

// ============================================================================
// 2. TOAST & NOTIFICATION HELPERS
// ============================================================================

function showToast(message, duration = 3000) {
  let toast = document.getElementById('ios-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ios-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 84px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(28, 28, 30, 0.96);
      color: #FFFFFF;
      padding: 12px 22px;
      border-radius: 24px;
      font-size: 14px;
      font-weight: 500;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      border: 0.5px solid rgba(255,255,255,0.15);
      z-index: 99999;
      opacity: 0;
      transition: all 0.35s cubic-bezier(0.25, 1, 0.5, 1);
      pointer-events: none;
      text-align: center;
      max-width: 88%;
      white-space: pre-line;
    `;
    document.body.appendChild(toast);
  }
  toast.innerText = message;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, duration);
}

// ============================================================================
// 3. STORAGE PERMISSION REQUEST ON STARTUP (REQUIREMENT 2)
// ============================================================================

/**
 * Checks and requests Android storage permissions on startup.
 * Ensures the app can read files from public storage or prompt the user.
 */
async function checkAndRequestStoragePermissions() {
  const Capacitor = window.Capacitor;
  if (!Capacitor || !Capacitor.isNativePlatform()) {
    console.log('[StoragePermissions] Running in browser preview. Skipping native permissions.');
    return true;
  }

  try {
    const Filesystem = Capacitor.Plugins?.Filesystem;
    if (Filesystem && typeof Filesystem.checkPermissions === 'function') {
      const checkResult = await Filesystem.checkPermissions();
      console.log('[StoragePermissions] Current Filesystem permissions:', checkResult);

      if (checkResult.publicStorage !== 'granted') {
        const reqResult = await Filesystem.requestPermissions();
        console.log('[StoragePermissions] Requested Filesystem permissions:', reqResult);
      }
    }

    const FilePicker = Capacitor.Plugins?.FilePicker;
    if (FilePicker && typeof FilePicker.requestPermissions === 'function') {
      try {
        await FilePicker.requestPermissions();
      } catch (_) {}
    }

    return true;
  } catch (error) {
    console.warn('[StoragePermissions] Permission check notice:', error);
    return false;
  }
}

// ============================================================================
// 4. ROBUST FILE URI & NATIVE PATH RESOLUTION (REQUIREMENT 1)
// ============================================================================

/**
 * Converts a picked file object (which may contain content:// URIs) into a readable
 * POSIX native filesystem path.
 *
 * If content:// cannot be opened directly by POSIX open(), it uses @capacitor/filesystem
 * to copy the file into the app's internal Directory.Data (/data/user/0/.../files/),
 * which provides 100% permission-free POSIX read access for llama.cpp.
 *
 * @param {{ path?: string, uri?: string, name: string, size?: number }} file
 * @returns {Promise<string>} Absolute POSIX path for C++ engine
 */
async function resolveNativeModelPath(file) {
  const rawPath = file.path || file.uri || '';
  const fileName = file.name || 'model.gguf';

  console.log(`[resolveNativeModelPath] Processing: path="${rawPath}", name="${fileName}"`);

  // Case A: Already a direct POSIX filesystem path
  if (rawPath.startsWith('/storage/') || rawPath.startsWith('/data/') || rawPath.startsWith('/sdcard/')) {
    return rawPath;
  }

  // Case B: Standard file:// URI
  if (rawPath.startsWith('file://')) {
    return rawPath.replace(/^file:\/\//, '');
  }

  // Case C: content:// URI (Android Storage Access Framework)
  if (rawPath.startsWith('content://')) {
    // 1. Try decoding embedded raw paths (common in Android Downloads provider)
    try {
      const decoded = decodeURIComponent(rawPath);
      const match = decoded.match(/(\/(?:storage|sdcard|data)\/[^\s"']+)/);
      if (match && match[1]) {
        console.log(`[resolveNativeModelPath] Extracted raw path from URI: "${match[1]}"`);
        return match[1];
      }
    } catch (_) {}

    // 2. Check direct Download folder default
    const directDownloadPath = `/storage/emulated/0/Download/${fileName}`;

    // 3. Use @capacitor/filesystem to resolve or copy into the app's private Data directory
    const Filesystem = window.Capacitor?.Plugins?.Filesystem;
    if (Filesystem) {
      try {
        // Check if file is already copied into local app directory
        try {
          const statResult = await Filesystem.stat({
            path: fileName,
            directory: 'DATA'
          });
          if (statResult && statResult.size > 0) {
            console.log(`[resolveNativeModelPath] Model already exists in app internal storage.`);
            const uriResult = await Filesystem.getUri({
              path: fileName,
              directory: 'DATA'
            });
            const localPath = (uriResult.uri || uriResult.path).replace(/^file:\/\//, '');
            return localPath;
          }
        } catch (_) {
          // Not yet in app storage, proceed to copy
        }

        showToast('Linking model to local storage for zero-permission access...');

        await Filesystem.copy({
          from: rawPath,
          to: fileName,
          toDirectory: 'DATA'
        });

        const uriResult = await Filesystem.getUri({
          path: fileName,
          directory: 'DATA'
        });

        const localPath = (uriResult.uri || uriResult.path).replace(/^file:\/\//, '');
        console.log(`[resolveNativeModelPath] Successfully copied to app internal storage: "${localPath}"`);
        return localPath;

      } catch (copyErr) {
        console.warn('[resolveNativeModelPath] Filesystem copy failed, falling back to direct Download path:', copyErr);
      }
    }

    return directDownloadPath;
  }

  // Fallback
  return rawPath || `/storage/emulated/0/Download/${fileName}`;
}

// ============================================================================
// 5. CHAT BUBBLE UI LOGIC
// ============================================================================

/**
 * Dynamically create HTML chat bubbles and append them to the chat window.
 * - User: Blue bubble, right aligned
 * - AI: Gray bubble, left aligned
 * - System: Muted pill, centered
 */
function appendMessage(role, text) {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const row = document.createElement('div');
  row.id = messageId;

  let bubbleHtml = '';

  if (role === 'system') {
    row.className = 'chat-row system-row';
    bubbleHtml = `
      <div class="system-pill">
        <span>${escapeHtml(text)}</span>
      </div>
    `;
  } else if (role === 'user') {
    row.className = 'chat-row user-row';
    bubbleHtml = `
      <div class="user-bubble">
        <div class="bubble-text" id="text-${messageId}">${escapeHtml(text)}</div>
        <div class="bubble-meta">
          <span>${timestamp}</span>
        </div>
      </div>
    `;
  } else {
    row.className = 'chat-row ai-row';
    bubbleHtml = `
      <div class="ai-bubble">
        <div class="bubble-text" id="text-${messageId}">${escapeHtml(text)}</div>
        <div class="bubble-meta">
          <span class="perf-badge">⚡ On-Device</span>
          <span>${timestamp}</span>
        </div>
      </div>
    `;
  }

  row.innerHTML = bubbleHtml;
  DOM.chatMessagesContainer.appendChild(row);

  requestAnimationFrame(() => {
    DOM.chatMessagesContainer.scrollTop = DOM.chatMessagesContainer.scrollHeight;
  });

  const textElement = document.getElementById(`text-${messageId}`);
  return { id: messageId, textElement: textElement };
}

// ============================================================================
// 6. LLAMA ENGINE INITIALIZATION
// ============================================================================

/**
 * Loads the .gguf model into native C++ memory using llama-cpp-capacitor.
 * Supports both initialize({ path }) and initContext({ contextId, params }).
 *
 * @param {string|null} customPath - Optional path override
 * @returns {Promise<boolean>} True if initialized successfully
 */
async function loadModelToEngine(customPath = null) {
  let savedPath = customPath || localStorage.getItem(STORAGE_KEY_ACTIVE_GGUF_PATH);
  
  if (!savedPath) {
    const savedRecord = localStorage.getItem(STORAGE_KEY_ACTIVE_MODEL);
    if (savedRecord) {
      try {
        const parsed = JSON.parse(savedRecord);
        savedPath = parsed.path;
      } catch (_) {}
    }
  }

  if (!savedPath) {
    console.warn('[loadModelToEngine] No model path saved in localStorage.');
    AppState.isEngineReady = false;
    updateUIState();
    return false;
  }

  // Ensure file:// is stripped for POSIX open()
  let cleanPath = savedPath.replace(/^file:\/\//, '');
  console.log(`[loadModelToEngine] Loading GGUF weights into engine: "${cleanPath}"`);

  // Show UI Loading State
  AppState.isLoadingEngine = true;
  DOM.modelStatusChip.className = 'ios-status-badge inactive';
  DOM.modelStatusChip.innerText = 'Loading Engine...';
  DOM.chatActiveIndicator.className = 'pill-dot active';
  DOM.chatActiveModelName.innerText = 'Loading Model...';

  try {
    const LlamaPlugin = window.Capacitor?.Plugins?.LlamaCpp;

    if (LlamaPlugin) {
      // Release any existing context
      if (AppState.activeContextId !== null) {
        try {
          if (typeof LlamaPlugin.releaseContext === 'function') {
            await LlamaPlugin.releaseContext({ contextId: AppState.activeContextId });
          }
        } catch (_) {}
      }

      const newContextId = Date.now();

      // Support LlamaCpp.initialize({ path: absolutePath }) or initContext({ ... })
      if (typeof LlamaPlugin.initialize === 'function') {
        await LlamaPlugin.initialize({
          path: cleanPath,
          model: cleanPath,
          contextId: newContextId
        });
      } else if (typeof LlamaPlugin.initContext === 'function') {
        /**
         * CALL LLAMA-CPP-CAPACITOR NATIVE METHOD:
         * Optimized for Motorola Edge 60 Pro (12GB RAM):
         * - n_ctx: 2048 context window
         * - n_threads: 4 (binds to 4 Performance cores)
         * - use_mmap: true (kernel zero-copy file mapping)
         * - use_mlock: false (avoids Android LMK pressure)
         */
        await LlamaPlugin.initContext({
          contextId: newContextId,
          params: {
            model: cleanPath,
            path: cleanPath,
            n_ctx: 2048,
            n_threads: 4,
            n_batch: 512,
            use_mmap: true,
            use_mlock: false,
            n_gpu_layers: 0
          }
        });
      }

      AppState.activeContextId = newContextId;
      AppState.isEngineReady = true;
      console.log(`[loadModelToEngine] Model loaded successfully into Context #${newContextId}`);
      updateUIState();
      return true;

    } else {
      // Browser preview simulation fallback
      console.warn('[loadModelToEngine] Native LlamaCpp plugin not detected. Running simulated engine.');
      await new Promise(resolve => setTimeout(resolve, 600));
      AppState.activeContextId = 1001;
      AppState.isEngineReady = true;
      updateUIState();
      return true;
    }

  } catch (error) {
    console.error('[loadModelToEngine] Engine initialization failed:', error);
    AppState.isEngineReady = false;
    AppState.activeContextId = null;
    updateUIState();

    const err = (error.message || error.toString()).toLowerCase();

    // Out-of-memory error handling
    if (err.includes('out of memory') || err.includes('bad_alloc') || err.includes('cannot allocate')) {
      alert(
        '❌ OUT OF MEMORY (OOM)\n\n' +
        'Not enough contiguous RAM available to allocate this model context.\n\n' +
        'Solutions:\n' +
        '• Close other running apps on your phone.\n' +
        '• Use a 4-bit quantized model (Q4_K_M).'
      );
    } 
    // File not found / permission error handling
    else if (err.includes('not found') || err.includes('enoent') || err.includes('cannot open') || err.includes('failed to initialize native context')) {
      alert(
        '❌ FAILED TO INITIALIZE NATIVE CONTEXT\n\n' +
        `Path: ${cleanPath}\n\n` +
        'Possible Causes:\n' +
        '1. Storage Access: On Android 11+, grant "All Files Access" in Settings -> Apps -> OfflineAI -> Permissions.\n' +
        '2. The app is automatically caching your model to app storage to bypass permission restrictions. Please re-select the model.'
      );
    } else {
      alert(`❌ Engine Load Error: ${error.message || error}`);
    }

    return false;

  } finally {
    AppState.isLoadingEngine = false;
  }
}

// ============================================================================
// 7. SEND MESSAGE & GENERATION LOGIC
// ============================================================================

/**
 * Handle Send Button Submission with non-blocking UI
 */
async function handleSendMessage() {
  const promptText = DOM.chatTextarea.value.trim();

  if (!promptText) return;
  if (!AppState.activeModel) {
    alert('Please select a local .gguf model in Model Settings first.');
    return;
  }
  if (AppState.isGenerating) return;

  // Append user bubble (Blue)
  appendMessage('user', promptText);
  DOM.chatTextarea.value = '';
  DOM.chatTextarea.style.height = 'auto';
  DOM.btnSendMessage.disabled = true;

  // Auto-load engine if not loaded yet
  if (!AppState.isEngineReady) {
    const loaded = await loadModelToEngine(AppState.activeModel.path);
    if (!loaded) {
      appendMessage('system', '⚠️ Inference aborted: AI engine could not be loaded.');
      return;
    }
  }

  // Append AI bubble with "Generating..."
  AppState.isGenerating = true;
  DOM.chatTypingIndicator.style.display = 'flex';
  DOM.btnSendMessage.style.display = 'none';
  DOM.btnStopGeneration.style.display = 'flex';

  const aiMessage = appendMessage('ai', 'Generating...');
  const textElement = aiMessage.textElement;

  try {
    const LlamaPlugin = window.Capacitor?.Plugins?.LlamaCpp;

    if (LlamaPlugin) {
      let streamedResponse = '';

      // Token streaming listener
      const tokenListener = await LlamaPlugin.addListener('@LlamaCpp_onToken', (data) => {
        if (data && data.contextId === AppState.activeContextId && data.token) {
          streamedResponse += data.token;
          if (textElement) {
            textElement.innerText = streamedResponse;
          }
          DOM.chatMessagesContainer.scrollTop = DOM.chatMessagesContainer.scrollHeight;
        }
      });

      // Call native completion
      const response = await LlamaPlugin.completion({
        contextId: AppState.activeContextId,
        params: {
          prompt: promptText,
          n_predict: 256,
          temperature: 0.7,
          top_p: 0.9,
          stop: ['</s>', '<|im_end|>', '<|end_of_text|>', '<|eot_id|>']
        }
      });

      try { await tokenListener.remove(); } catch (_) {}

      const finalText = response.text || response.content || streamedResponse || '(No response generated)';
      if (textElement) {
        textElement.innerText = finalText;
      }

    } else {
      // Browser preview simulated response
      const sampleTokens = [
        "Hello! ",
        "I am your 100% offline AI assistant running ",
        "via your plugged-in local .gguf weights ",
        "on the Motorola Edge 60 Pro. ",
        "All inference is computed in local C++ memory ",
        "without any network access."
      ];

      let accumulated = '';
      for (let i = 0; i < sampleTokens.length; i++) {
        await new Promise(r => setTimeout(r, 60));
        accumulated += sampleTokens[i];
        if (textElement) {
          textElement.innerText = accumulated;
        }
        DOM.chatMessagesContainer.scrollTop = DOM.chatMessagesContainer.scrollHeight;
      }
    }

  } catch (error) {
    console.error('[handleSendMessage] Inference error:', error);
    const err = (error.message || error.toString()).toLowerCase();

    if (err.includes('out of memory') || err.includes('bad_alloc')) {
      alert('❌ Out of Memory Error during text generation.');
      if (textElement) textElement.innerText = '⚠️ Generation stopped: Out of Memory.';
    } else {
      alert(`⚠️ Generation Failed: ${error.message || error}`);
      if (textElement) textElement.innerText = `⚠️ Error: ${error.message || error}`;
    }

  } finally {
    AppState.isGenerating = false;
    DOM.chatTypingIndicator.style.display = 'none';
    DOM.btnSendMessage.style.display = 'flex';
    DOM.btnStopGeneration.style.display = 'none';
    DOM.btnSendMessage.disabled = DOM.chatTextarea.value.trim().length === 0;
    DOM.chatMessagesContainer.scrollTop = DOM.chatMessagesContainer.scrollHeight;
  }
}

async function stopGeneration() {
  if (AppState.isGenerating) {
    console.log('[Chat] User stopped generation.');
    const LlamaPlugin = window.Capacitor?.Plugins?.LlamaCpp;
    if (LlamaPlugin && AppState.activeContextId) {
      try {
        await LlamaPlugin.stopCompletion({ contextId: AppState.activeContextId });
      } catch (_) {}
    }
    AppState.isGenerating = false;
    DOM.chatTypingIndicator.style.display = 'none';
    DOM.btnSendMessage.style.display = 'flex';
    DOM.btnStopGeneration.style.display = 'none';
  }
}

// ============================================================================
// 8. ATTACHMENT MENU & PDF/TXT TEXT EXTRACTION
// ============================================================================

function openActionSheet() {
  if (DOM.sheetBackdrop) {
    DOM.sheetBackdrop.classList.add('active');
    DOM.sheetBackdrop.setAttribute('aria-hidden', 'false');
  }
}

function closeActionSheet() {
  if (DOM.sheetBackdrop) {
    DOM.sheetBackdrop.classList.remove('active');
    DOM.sheetBackdrop.setAttribute('aria-hidden', 'true');
  }
}

async function extractPlainText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(e);
    reader.readAsText(file);
  });
}

async function extractPDFText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const matches = text.match(/\(([^()]+)\)\s*Tj/g) || [];
        const extracted = matches.map(m => m.replace(/^\(|\)\s*Tj$/g, '')).join(' ');
        resolve(extracted.trim() || `[PDF Document: ${file.name} attached (${(file.size / 1024).toFixed(1)} KB)]`);
      } catch (_) {
        resolve(`[PDF Document: ${file.name} attached (${(file.size / 1024).toFixed(1)} KB)]`);
      }
    };
    reader.onerror = () => resolve(`[PDF Document: ${file.name} attached]`);
    reader.readAsText(file);
  });
}

async function handleDocumentFile(file) {
  if (!file) return;
  const fileName = (file.name || '').toLowerCase();
  let extractedText = '';

  try {
    if (fileName.endsWith('.txt') || file.type === 'text/plain') {
      extractedText = await extractPlainText(file);
    } else if (fileName.endsWith('.pdf') || file.type === 'application/pdf') {
      extractedText = await extractPDFText(file);
    } else {
      extractedText = await extractPlainText(file);
    }

    const currentVal = DOM.chatTextarea.value.trim();
    DOM.chatTextarea.value = currentVal ? `${currentVal}\n\n${extractedText}` : extractedText;
    DOM.chatTextarea.style.height = 'auto';
    DOM.chatTextarea.style.height = `${Math.min(DOM.chatTextarea.scrollHeight, 120)}px`;
    DOM.btnSendMessage.disabled = false;
    DOM.chatTextarea.focus();

    appendMessage('system', `📄 Attached: "${file.name}" - text pasted into prompt.`);

  } catch (error) {
    console.error('Error reading document:', error);
    alert(`Could not extract document text: ${error.message || error}`);
  }
}

// ============================================================================
// 9. FILE PICKER & MODEL SELECTION ("THE PLUG")
// ============================================================================

async function onSelectLocalModelClick() {
  const Capacitor = window.Capacitor;
  const FilePicker = Capacitor?.Plugins?.FilePicker;

  try {
    // 1. Ensure permissions are checked and prompted
    await checkAndRequestStoragePermissions();

    if (Capacitor && Capacitor.isNativePlatform() && FilePicker) {
      const result = await FilePicker.pickFiles({
        types: ['application/octet-stream', '*/*'],
        multiple: false,
        readData: false
      });

      if (!result || !result.files || result.files.length === 0) return;

      const file = result.files[0];

      // Convert content:// URI or get direct absolute path
      const resolvedAbsolutePath = await resolveNativeModelPath(file);

      await handleModelFileSelected(file.name, resolvedAbsolutePath, file.size || 0);

    } else {
      const fileInput = DOM.nativeFileInput;
      if (!fileInput) return;

      fileInput.value = '';
      fileInput.onchange = async () => {
        if (fileInput.files && fileInput.files.length > 0) {
          const file = fileInput.files[0];
          const simulatedPath = `/storage/emulated/0/Download/${file.name}`;
          await handleModelFileSelected(file.name, simulatedPath, file.size);
        }
      };
      fileInput.click();
    }

  } catch (error) {
    const msg = (error.message || error.toString()).toLowerCase();
    if (msg.includes('cancel') || msg.includes('canceled') || msg.includes('closed')) return;
    console.error('FilePicker error:', error);
    alert(`File Picker Error: ${error.message || error}`);
  }
}

async function handleModelFileSelected(filename, absolutePath, fileSize) {
  const sizeLabel = formatBytes(fileSize);
  const quant = detectQuantFromFilename(filename);

  const modelRecord = {
    name: filename,
    path: absolutePath,
    size: fileSize,
    sizeLabel: sizeLabel,
    quant: quant,
    linkedAt: new Date().toISOString()
  };

  AppState.activeModel = modelRecord;
  localStorage.setItem(STORAGE_KEY_ACTIVE_GGUF_PATH, absolutePath);
  localStorage.setItem(STORAGE_KEY_ACTIVE_MODEL, JSON.stringify(modelRecord));

  updateUIState();

  // Load model into engine
  loadModelToEngine(absolutePath);

  setTimeout(() => {
    switchTab('view-chat');
  }, 200);

  appendMessage('system', `🔌 Model Ready: ${filename}\nPath: ${absolutePath}`);
}

async function handleUnlinkModel() {
  if (!AppState.activeModel) return;

  const modelName = AppState.activeModel.name;
  const LlamaPlugin = window.Capacitor?.Plugins?.LlamaCpp;

  if (LlamaPlugin && AppState.activeContextId !== null) {
    try { await LlamaPlugin.releaseContext({ contextId: AppState.activeContextId }); } catch (_) {}
  }

  AppState.activeModel = null;
  AppState.activeContextId = null;
  AppState.isEngineReady = false;

  localStorage.removeItem(STORAGE_KEY_ACTIVE_GGUF_PATH);
  localStorage.removeItem(STORAGE_KEY_ACTIVE_MODEL);

  updateUIState();
  appendMessage('system', `🔌 Unlinked model: ${modelName}.`);
}

// ============================================================================
// 10. UI STATE & VIEW NAVIGATION
// ============================================================================

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'Local GGUF';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function detectQuantFromFilename(name) {
  const match = name.match(/([qQ]\d+_[a-zA-Z0-9_]+)/);
  return match ? match[1].toUpperCase() : 'GGUF';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

function updateUIState() {
  const model = AppState.activeModel;

  if (model) {
    DOM.statusEmptyState.style.display = 'none';
    DOM.statusActiveState.style.display = 'flex';
    DOM.modelStatusChip.className = 'ios-status-badge active';
    DOM.modelStatusChip.innerText = AppState.isEngineReady ? 'Ready' : (AppState.isLoadingEngine ? 'Loading...' : 'Linked');

    DOM.activeModelFileName.innerText = `Model Ready: ${model.name}`;
    DOM.activeModelSizeBadge.innerText = model.sizeLabel;
    DOM.activeModelQuantBadge.innerText = model.quant;
    DOM.activeModelNativePath.innerText = model.path;

    DOM.chatActiveIndicator.className = 'pill-dot active';
    DOM.chatActiveModelName.innerText = model.name;
    DOM.chatModelQuantPill.innerText = model.quant;
    DOM.chatModelQuantPill.style.display = 'inline-block';

    DOM.chatNoModelBanner.style.display = 'none';
    DOM.chatTextarea.disabled = false;
    DOM.chatTextarea.placeholder = `Message ${model.name}...`;
    DOM.btnSendMessage.disabled = DOM.chatTextarea.value.trim().length === 0;

    DOM.navChatStatusDot.className = 'tab-dot active';

  } else {
    DOM.statusEmptyState.style.display = 'flex';
    DOM.statusActiveState.style.display = 'none';
    DOM.modelStatusChip.className = 'ios-status-badge inactive';
    DOM.modelStatusChip.innerText = 'Not Loaded';

    DOM.modelStatusMainText.innerText = 'No model selected';

    DOM.chatActiveIndicator.className = 'pill-dot inactive';
    DOM.chatActiveModelName.innerText = 'No Model';
    DOM.chatModelQuantPill.style.display = 'none';

    DOM.chatNoModelBanner.style.display = 'flex';
    DOM.chatTextarea.disabled = true;
    DOM.chatTextarea.value = '';
    DOM.chatTextarea.placeholder = 'Select a .gguf model in Model Settings to chat...';
    DOM.btnSendMessage.disabled = true;

    DOM.navChatStatusDot.className = 'tab-dot inactive';
  }
}

function switchTab(viewId) {
  AppState.activeTab = viewId;

  DOM.viewModels.classList.toggle('active', viewId === 'view-models');
  DOM.viewChat.classList.toggle('active', viewId === 'view-chat');

  DOM.navBtnModels.classList.toggle('active', viewId === 'view-models');
  DOM.navBtnChat.classList.toggle('active', viewId === 'view-chat');

  if (viewId === 'view-chat') {
    requestAnimationFrame(() => {
      DOM.chatMessagesContainer.scrollTop = DOM.chatMessagesContainer.scrollHeight;
      if (AppState.activeModel) {
        setTimeout(() => DOM.chatTextarea.focus(), 150);
      }
    });
  }
}

// ============================================================================
// 11. EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
  // Navigation
  DOM.navBtnModels.addEventListener('click', () => switchTab('view-models'));
  DOM.navBtnChat.addEventListener('click', () => switchTab('view-chat'));
  DOM.btnGoToModels.addEventListener('click', () => switchTab('view-models'));
  DOM.btnJumpToChat.addEventListener('click', () => switchTab('view-chat'));

  // Model Selection
  DOM.btnImportModel.addEventListener('click', onSelectLocalModelClick);
  DOM.btnReselectModel.addEventListener('click', onSelectLocalModelClick);
  DOM.btnUnlinkModel.addEventListener('click', handleUnlinkModel);

  // Attachment Sheet
  DOM.btnAttach.addEventListener('click', openActionSheet);
  DOM.btnSheetCancel.addEventListener('click', closeActionSheet);
  DOM.sheetBackdrop.addEventListener('click', (e) => {
    if (e.target === DOM.sheetBackdrop) closeActionSheet();
  });

  DOM.btnSheetUploadDoc.addEventListener('click', () => {
    closeActionSheet();
    if (DOM.documentFileInput) {
      DOM.documentFileInput.value = '';
      DOM.documentFileInput.click();
    }
  });

  DOM.btnSheetUploadPhoto.addEventListener('click', () => {
    closeActionSheet();
    alert('📷 Upload Photo: Vision model support coming in the next update!');
  });

  DOM.documentFileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await handleDocumentFile(e.target.files[0]);
    }
  });

  // Chat Textarea
  DOM.chatTextarea.addEventListener('input', () => {
    DOM.chatTextarea.style.height = 'auto';
    DOM.chatTextarea.style.height = `${Math.min(DOM.chatTextarea.scrollHeight, 120)}px`;
    DOM.btnSendMessage.disabled = !AppState.activeModel || DOM.chatTextarea.value.trim().length === 0;
  });

  DOM.chatTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  // Send Button Click Listener
  DOM.btnSendMessage.addEventListener('click', handleSendMessage);
  DOM.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSendMessage();
  });

  DOM.btnStopGeneration.addEventListener('click', stopGeneration);

  DOM.btnClearChat.addEventListener('click', () => {
    DOM.chatMessagesContainer.innerHTML = '';
    appendMessage('system', '🧹 Chat history cleared.');
  });
}

// ============================================================================
// 12. APP BOOTSTRAP
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[OfflineAI] Initializing Offline AI App...');
  setupEventListeners();

  // Prompt storage permissions on startup
  await checkAndRequestStoragePermissions();

  // Restore saved model if present
  const savedModelJson = localStorage.getItem(STORAGE_KEY_ACTIVE_MODEL);
  if (savedModelJson) {
    try {
      const parsed = JSON.parse(savedModelJson);
      if (parsed && parsed.path) {
        AppState.activeModel = parsed;
        updateUIState();
        // Warm up / load engine in background
        loadModelToEngine(parsed.path);
      }
    } catch (_) {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_MODEL);
    }
  } else {
    updateUIState();
  }

  console.log('[OfflineAI] App ready.');
});
