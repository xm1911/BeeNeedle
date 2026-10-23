/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */


const textMetadata = new Map(); // Map<text, { urls: Map<urlId, timestamp> }>
let tabUrlMap = new Map();
let urlIdMap = new Map();
let idUrlMap = new Map();
let nextUrlId = 1;

let isStorageFull = false;
const STORAGE_QUOTA = chrome.storage.session.QUOTA_BYTES || 5 * 1024 * 1024;
const STORAGE_QUOTA_THRESHOLD = STORAGE_QUOTA * 0.95;
const STORAGE_KEY = 'beeneedleC_sessionData_v4';

let initializationPromise = null;
let lastCleanupTimestamp = 0;

function initialize() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    try {
      const result = await chrome.storage.session.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        const data = result[STORAGE_KEY];
        if (data.urls) {
          idUrlMap = new Map(Object.entries(data.urls).map(([id, url]) => [parseInt(id, 10), url]));
          urlIdMap = new Map(Array.from(idUrlMap.entries()).map(([id, url]) => [url, id]));
          nextUrlId = idUrlMap.size > 0 ? Math.max(...Array.from(idUrlMap.keys())) + 1 : 1;
        }
        if (data.texts) {
          for (const [text, meta] of Object.entries(data.texts)) {
            textMetadata.set(text, { urls: new Map(Object.entries(meta.urls).map(([id, ts]) => [parseInt(id, 10), ts])) });
          }
        }
        if (data.tabUrls) {
          tabUrlMap = new Map(Object.entries(data.tabUrls).map(([id, url]) => [parseInt(id, 10), url]));
        }
        console.log(`C-BG: Restored ${textMetadata.size} texts, ${urlIdMap.size} URLs, and ${tabUrlMap.size} managed tabs.`);
      } else {
        console.log(`C-BG: No session data found.`);
      }
    } catch (e) { console.error("C-BG: Error restoring data.", e); }
  })();
  return initializationPromise;
}


async function updateAndSaveMetadata() {
  if (isStorageFull) return;
  const textsToSave = {};
  for (const [text, meta] of textMetadata.entries()) {
    textsToSave[text] = { urls: Object.fromEntries(meta.urls) };
  }
  const urlsToSave = Object.fromEntries(idUrlMap);
  const tabUrlsToSave = Object.fromEntries(tabUrlMap);
  const dataToSave = { texts: textsToSave, urls: urlsToSave, tabUrls: tabUrlsToSave };
  const size = new Blob([JSON.stringify(dataToSave)]).size;
  if (size > STORAGE_QUOTA_THRESHOLD) {
    isStorageFull = true;
    // console.error(`C-BG: STORAGE QUOTA EXCEEDED.`);
    await chrome.action.setBadgeText({ text: 'Full' });
    await chrome.action.setBadgeBackgroundColor({ color: '#D32F2F' });
    return;
  }
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: dataToSave });
  } catch (e) { console.error("C-BG: Error saving data.", e); }
}

async function recomputeAndNotify() {
  const metadataForBroadcast = {};
  for (const [text, meta] of textMetadata.entries()) {
    const originUrl = idUrlMap.get(meta.originUrlId);
    if (originUrl) {
      metadataForBroadcast[text] = { originUrl, isExternal: meta.urlIds.size > 1 };
    }
  }
  const promises = [];
  for (const tabId of tabUrlMap.keys()) {
    promises.push(chrome.tabs.sendMessage(tabId, {
      action: 'SYNC_METADATA',
      metadata: metadataForBroadcast
    }).catch(() => {}));
  }
  await Promise.all(promises);
}

function performCleanup(closedUrl) {
  const closedUrlId = urlIdMap.get(closedUrl);
  if (closedUrlId === undefined) return false;
  let changed = false;
  const textsToDelete = [];
  for (const [text, meta] of textMetadata.entries()) {
    if (meta.urls.has(closedUrlId)) {
      meta.urls.delete(closedUrlId);
      changed = true;
      if (meta.urls.size === 0) {
        textsToDelete.push(text);
      }
    }
  }
  if (textsToDelete.length > 0) {
    textsToDelete.forEach(text => textMetadata.delete(text));
  }
  urlIdMap.delete(closedUrl);
  idUrlMap.delete(closedUrlId);
  if (isStorageFull && changed) {
    isStorageFull = false;
    chrome.action.setBadgeText({ text: '' });
  }
  return changed;
}

async function cleanupOrphanedData() {
  const now = Date.now();
  if (now - lastCleanupTimestamp < 30000) return;
  lastCleanupTimestamp = now;
  await initialize();
  const activeTabs = await chrome.tabs.query({});
  const activeTabIds = new Set(activeTabs.map(t => t.id));
  const orphanedTabIds = Array.from(tabUrlMap.keys()).filter(id => !activeTabIds.has(id));
  if (orphanedTabIds.length === 0) return;
  console.log(`C-BG: Found ${orphanedTabIds.length} orphaned tabs. Cleaning up...`);
  let needsUpdate = false;
  for (const tabId of orphanedTabIds) {
    const closedUrl = tabUrlMap.get(tabId);
    tabUrlMap.delete(tabId);
    const isUrlStillManaged = Array.from(tabUrlMap.values()).includes(closedUrl);
    if (!isUrlStillManaged) {
      if (performCleanup(closedUrl)) {
        needsUpdate = true;
      }
    }
  }
  if (needsUpdate) {
    await updateAndSaveMetadata();
    await broadcastMetadata();
  }
}

async function broadcastMetadata() {
  const metadataForBroadcast = {};
  for (const [text, meta] of textMetadata.entries()) {
    if (meta.urls.size === 0) continue;
    let originUrlId = -1;
    let minTimestamp = Infinity;
    for (const [urlId, timestamp] of meta.urls.entries()) {
      if (timestamp < minTimestamp) {
        minTimestamp = timestamp;
        originUrlId = urlId;
      }
    }
    const originUrl = idUrlMap.get(originUrlId);
    if (originUrl) {
      metadataForBroadcast[text] = { originUrl, isExternal: meta.urls.size > 1 };
    }
  }
  for (const tabId of tabUrlMap.keys()) {
    chrome.tabs.sendMessage(tabId, { action: 'SYNC_METADATA', metadata: metadataForBroadcast }).catch(() => {});
  }
}

// --- イベントリスナー ---

chrome.runtime.onStartup.addListener(() => {
  console.log("C-BG: Browser startup. Initializing...");
  initialize();
});


chrome.tabs.onRemoved.addListener(async (tabId) => {
  await initialize();
  if (!tabUrlMap.has(tabId)) return;

  const closedUrl = tabUrlMap.get(tabId);
  tabUrlMap.delete(tabId);

  // 同じURLのタブが他に開かれていないか確認
  const isUrlStillManaged = Array.from(tabUrlMap.values()).includes(closedUrl);
  if (!isUrlStillManaged) {
    // このURLを持つ最後のタブが閉じられた場合のみ、クリーンアップを実行
    if (performCleanup(closedUrl)) {
      await updateAndSaveMetadata();
      await broadcastMetadata();
    }
  }
});


chrome.tabs.onActivated.addListener(cleanupOrphanedData);


chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // URLの変更があった場合のみ処理を実行
  if (changeInfo.url) {
    await initialize();

    // このタブが以前に管理していた古いURLを取得
    const oldUrl = tabUrlMap.get(tabId);
    const newUrl = changeInfo.url;

    // 古いURLが存在し、新しいURLと異なる場合、クリーンアップを試みる
    if (oldUrl && oldUrl !== newUrl) {
      // 新しいURLをマップに登録
      tabUrlMap.set(tabId, newUrl);

      // 古いURLが他のタブでまだ使われているかチェック
      const isOldUrlStillManaged = Array.from(tabUrlMap.values()).includes(oldUrl);

      if (!isOldUrlStillManaged) {
        // 他のどのタブでも使われていなければ、クリーンアップを実行
        console.log(`C-BG: Cleaning up data for navigated-away URL: ${oldUrl}`);
        if (performCleanup(oldUrl)) {
          await updateAndSaveMetadata();
          // この時点ではまだメタデータをブロードキャストしない
          // なぜなら、新しいページのコンテンツがまだ読み込まれていないから
        }
      }
    } else {
      // 新規またはURLが同じ場合、単純に更新
      tabUrlMap.set(tabId, newUrl);
    }
  }

  // ページの読み込み完了時に孤児データをクリーンアップする処理は維持
  if (changeInfo.status === 'complete') {
    await cleanupOrphanedData();
  }
});


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SYNC_TEXT_DATA') {
    (async () => {
      await initialize();
      // cleanupOrphanedDataはonUpdatedで呼ばれるので、ここでは不要になる場合もあるが、念のため残す
      await cleanupOrphanedData(); 

      // sender.tab.url ではなく、sender.url を使うことで、遷移中のURLを正確に捉える
      const { tab, url } = sender; 
      if (!tab || !url) { // sender情報が不完全な場合は何もしない
        sendResponse({});
        return;
      }

      let needsUpdate = false;
      if (!isStorageFull) {
        const getUrlId = (u) => {
          if (urlIdMap.has(u)) return urlIdMap.get(u);
          const id = nextUrlId++;
          urlIdMap.set(u, id);
          idUrlMap.set(id, u);
          return id;
        };
        const currentUrlId = getUrlId(url);
        
        // onUpdatedで既に設定されているはずだが、念のためここでも設定
        tabUrlMap.set(tab.id, url); 

        for (const [text, timestamp] of request.data) {
          if (timestamp === 0) continue;

          const meta = textMetadata.get(text);
          if (!meta) {
            textMetadata.set(text, { urls: new Map([[currentUrlId, timestamp]]) });
            needsUpdate = true;
          } else {
            const existingTimestamp = meta.urls.get(currentUrlId);
            if (existingTimestamp === undefined || timestamp < existingTimestamp) {
              meta.urls.set(currentUrlId, timestamp);
              needsUpdate = true;
            }
          }
        }
      }
      if (needsUpdate) {
        await updateAndSaveMetadata();
      }
      await broadcastMetadata();
      sendResponse({});
    })();
  }
  return true;
});