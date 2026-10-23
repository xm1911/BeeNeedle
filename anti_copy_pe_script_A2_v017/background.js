/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */

const SCRIPT_VERSION_BG = "A2_bg_v3_map"; // バージョンを更新
const STORAGE_KEY = 'beeneedleSystemA2Data';
const MAX_STORAGE_BYTES = 7 * 1024 * 1024; // 7MB
const TARGET_STORAGE_BYTES = MAX_STORAGE_BYTES * 0.9; // 約6.3MB (クリーンアップ目標)
const SAVE_DEBOUNCE_MS = 10000; // 10秒 (ストレージへの書き込み遅延)
const ENTRY_TYPE = {
  FULL: 1, // 0b01
  LINE: 2, // 0b10
};

// --- データ構造 ---
// Mapの挿入順をLRU（Least Recently Used）の順序として利用する
// 古いデータが先頭、新しいデータが末尾に来る
let textMap = new Map();

// 強調表示用のSet（textMapから都度生成される）
let fullTextSet = new Set();
let lineTextSet = new Set();

// --- 状態管理フラグ ---
let isDataLoaded = false;
let loadFromStoragePromise = null;
let saveTimer = null;

// --- 初期化処理 ---

/**
 * メモリ上のtextMapを元に、検索用のfullTextSetとlineTextSetを再構築する
 */
function initializeDataStructures() {
  fullTextSet.clear();
  lineTextSet.clear();
  
  // 変更: textMapの値が [text, type] 配列になったことに対応
  for (const entryArray of textMap.values()) {
    // entryArray は [text, type]
    const text = entryArray[0];
    const type = entryArray[1];

    if (type & ENTRY_TYPE.FULL) {
      fullTextSet.add(text);
    }
    if (type & ENTRY_TYPE.LINE) {
      lineTextSet.add(text);
    }
  }
}

/**
 * chrome.storage.localからデータを非同期で読み込み、textMapを構築する
 */
async function loadFromStorage() {
  if (loadFromStoragePromise) {
    return loadFromStoragePromise;
  }
   console.log(`[${SCRIPT_VERSION_BG}] Attempting to load data from storage key: ${STORAGE_KEY}...`);
  isDataLoaded = false;

  loadFromStoragePromise = new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      textMap.clear();

      try {
        if (chrome.runtime.lastError) {
          console.error(`[${SCRIPT_VERSION_BG}] Error loading data from storage (${STORAGE_KEY}):`, chrome.runtime.lastError);
        } else if (result[STORAGE_KEY] && Array.isArray(result[STORAGE_KEY].entries)) {
          const loadedEntries = result[STORAGE_KEY].entries;
          
          for (const entryArray of loadedEntries) {
            if (Array.isArray(entryArray) && entryArray.length === 2) {
              const text = entryArray[0];
              const type = entryArray[1];

              if (typeof text === 'string' && typeof type === 'number') {
                const compositeKey = JSON.stringify([text, type]);
                // 変更: 値として {te, t} オブジェクトではなく、元の配列をそのまま格納
                textMap.set(compositeKey, entryArray);
              }
            }
          }
           console.log(`[${SCRIPT_VERSION_BG}] Loaded and converted ${textMap.size} entries to Map from compact format.`);
        }
      } catch (e) {
        console.error(`[${SCRIPT_VERSION_BG}] Critical error during data loading/processing:`, e);
        textMap.clear();
      }

      if (textMap.size === 0) {
         console.log(`[${SCRIPT_VERSION_BG}] Initialized new empty map (load failed or no valid data).`);
      }

      initializeDataStructures();
      isDataLoaded = true;
       console.log(`[${SCRIPT_VERSION_BG}] Data loading process finished. isDataLoaded: ${isDataLoaded}`);
      loadFromStoragePromise = null;
      resolve();
    });
  });
  return loadFromStoragePromise;
}

// --- イベントリスナー ---

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[${SCRIPT_VERSION_BG}] Extension installed/updated (${details.reason}).`);
  await loadFromStorage();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log(`[${SCRIPT_VERSION_BG}] Chrome startup.`);
  await loadFromStorage();
});

// 初期ロード
loadFromStorage().then(() => {
  console.log(`[${SCRIPT_VERSION_BG}] Initial background script load/restart completed.`);
});



/**
 * メモリ上のデータをストレージに保存する処理を予約する（デバウンス付き）
 */
function scheduleSaveToStorage() {
  if (!isDataLoaded) {
    return;
  }

  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    if (!isDataLoaded || !textMap) {
        console.error(`[${SCRIPT_VERSION_BG}] Save to storage (timeout callback) aborted: textMap became invalid.`);
        saveTimer = null;
        return;
    }

    let entriesToProcess = Array.from(textMap.entries());
    

    const entriesToSaveCompact = Array.from(textMap.values());

    let currentBlobSize = 0;
    try {
        currentBlobSize = new Blob([JSON.stringify(entriesToSaveCompact)]).size;
    } catch (e) {
        console.error(`[${SCRIPT_VERSION_BG}] Error calculating blob size before cleanup:`, e);
        saveTimer = null;
        return;
    }

    let removedCount = 0;
    if (currentBlobSize > TARGET_STORAGE_BYTES) {
        console.log(`[${SCRIPT_VERSION_BG}] Cleanup: Initial Size ${currentBlobSize} > Target ${TARGET_STORAGE_BYTES}. Starting.`);
        let estimatedSize = currentBlobSize;

        while (estimatedSize > TARGET_STORAGE_BYTES && entriesToProcess.length > 0) {
            const removedEntryCompact = entriesToSaveCompact.shift();
            entriesToProcess.shift();

            if (removedEntryCompact) {
                const removedBytes = (removedEntryCompact[0].length * 3) + 16;
                estimatedSize -= removedBytes;
                removedCount++;
            }
        }
        console.log(`[${SCRIPT_VERSION_BG}] Cleanup finished. Removed ${removedCount} entries. Final entries: ${entriesToProcess.length}.`);
    }

    const dataToSave = { entries: entriesToSaveCompact };

    console.log(`[${SCRIPT_VERSION_BG}] Attempting to save ${dataToSave.entries.length} entries.`);
    chrome.storage.local.set({ [STORAGE_KEY]: dataToSave }, () => {
      saveTimer = null;
      if (chrome.runtime.lastError) {
        console.error(`[${SCRIPT_VERSION_BG}] Error saving data to storage (${STORAGE_KEY}):`, chrome.runtime.lastError);
      } else {
        console.log(`[${SCRIPT_VERSION_BG}] Data successfully saved to storage in compact format.`);

        textMap = new Map(entriesToProcess);

        console.log(`[${SCRIPT_VERSION_BG}] Re-initializing data structures after save.`);
        initializeDataStructures();
        console.log(`[${SCRIPT_VERSION_BG}] Data structures re-initialized. Map size: ${textMap.size}`);
      }
    });
  }, SAVE_DEBOUNCE_MS);
}


// --- メッセージリスナー ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const respond = (response) => {
    try {
      sendResponse(response);
    } catch (e) {
      // console.warn(`[${SCRIPT_VERSION_BG}] Error calling sendResponse:`, e.message);
    }
  };

  (async () => { // 非同期処理を可能にするため IIFE でラップ
    if (!isDataLoaded) {
      // console.warn(`[${SCRIPT_VERSION_BG}] Message (Action: ${request.action}) received. Data not loaded yet, awaiting load...`);
      await loadFromStorage();
      // console.log(`[${SCRIPT_VERSION_BG}] Data loaded after waiting for message (Action: ${request.action}).`);
    }

    if (!textMap) {
      console.error(`[${SCRIPT_VERSION_BG}] Critical: textMap is null/undefined even after load attempt! (Action: ${request.action}).`);
      textMap = new Map();
      initializeDataStructures();
      respond({ error: `Internal data error (${SCRIPT_VERSION_BG}). Please try again.`, fullTexts: [], lineTexts: [] });
      return;
    }

    switch (request.action) {
      case 'isDataReady':
        respond({ ready: isDataLoaded });
        break;


      case 'savePageData':
        if (request.url && (request.url.startsWith('https://img.2chan.net') || request.url.startsWith('https://may.2chan.net'))) {
          respond({ message: `[${SCRIPT_VERSION_BG}] Data from img.2chan.net/may.2chan.net will not be saved.` });
          return;
        }
        if (!Array.isArray(request.data) || request.data.length === 0) {
          respond({ message: `[${SCRIPT_VERSION_BG}] No valid page data received.` });
          return;
        }
      
        let entriesChanged = false;
      
        const processEntry = (text, typeFlag) => {
          const compositeKey = JSON.stringify([text, typeFlag]);

          if (textMap.has(compositeKey)) {
            textMap.delete(compositeKey);
          }

          // 変更: 値として [text, typeFlag] 配列を格納
          textMap.set(compositeKey, [text, typeFlag]);

          if (typeFlag & ENTRY_TYPE.FULL) fullTextSet.add(text);
          if (typeFlag & ENTRY_TYPE.LINE) lineTextSet.add(text);

          entriesChanged = true;
        };
      
        request.data.forEach(blockData => {
          const { fullText, lineTexts } = blockData;
          if (!fullText || typeof fullText !== 'string' || !Array.isArray(lineTexts)) {
            return;
          }
      
          const uniqueLineTexts = lineTexts.filter(lt => typeof lt === 'string' && lt.length > 0);
          const isSingleLineEffectively = uniqueLineTexts.length === 1 && fullText === uniqueLineTexts[0];
      
          if (isSingleLineEffectively) {
            const text = fullText;
            if (text.length > 0) {
              processEntry(text, ENTRY_TYPE.FULL | ENTRY_TYPE.LINE); // t: 3
            }
          } else {
            // 複数行の場合
            if (fullText.length > 0) {
              processEntry(fullText, ENTRY_TYPE.FULL); // t: 1
            }
            uniqueLineTexts.forEach(line => {
              if (line.length > 0) {
                processEntry(line, ENTRY_TYPE.LINE); // t: 2
              }
            });
          }
        }); // request.data.forEach の終わり
      
        if (entriesChanged) {
          // console.log(`[${SCRIPT_VERSION_BG}] Processed page data. Map size is now ${textMap.size}.`);
          scheduleSaveToStorage();
          respond({ message: `[${SCRIPT_VERSION_BG}] Data processed, scheduled for saving.` });
        } else {
          respond({ message: `[${SCRIPT_VERSION_BG}] No new entries to process from page data.` });
        }
        break;

      case 'getTextSets':
        respond({
          fullTexts: Array.from(fullTextSet),
          lineTexts: Array.from(lineTextSet)
        });
        break;

      default:
        respond({ error: `[${SCRIPT_VERSION_BG}] Unknown action: ${request.action}` });
    }
  })(); // IIFE を即時実行

  return true; // 非同期応答を示す
});


// コンテキストメニューの作成（選択時のみ表示）
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "search-tsumanne",
    title: 'tsumanne.net で検索: "%s"',
    contexts: ["selection"]
  });
});

// クリック時の動作
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "search-tsumanne" || !info.selectionText) return;

  const selection = sanitizeSelection(info.selectionText);
  if (!selection) return;

  const query = buildQuery(selection);
  const url = `https://www.google.co.jp/search?q=${encodeURIComponent(query)}&hl=ja`;
  chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined });
});

// 余計な空白や改行を整理し、長すぎる入力を抑制
function sanitizeSelection(text) {
  const normalized = text;
  // URL 長対策（必要に応じて調整）
  const MAX_LEN = 500;
  return normalized.length > MAX_LEN ? normalized.slice(0, MAX_LEN) : normalized;
}

// 選択文字列に二重引用符が含まれる場合は、フレーズ検索のための外側の引用を外す
// （Google 検索では \" のエスケープ挙動があいまいなための現実解）
function buildQuery(selection) {
  const hasDoubleQuote = selection.includes('"');
  const phrase = hasDoubleQuote ? selection : `"${selection}"`;
  // リクエストどおりスキーム付きで site: を付与
  return `site:https://tsumanne.net/ ${phrase}`;
}
