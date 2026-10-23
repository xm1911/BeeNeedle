/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */

console.log("[BG] background.js loaded");

// --- グローバル変数 ---

let fixedLengthStrings = []; // メモリ上の参照テキスト (DBと同期)
let textToTimestampMap = new Map(); // 重複チェックとLRU管理のためのMap { originalText: timestamp }
let invertedIndex = { trigram: new Map() };
let urlStore = [];
let urlMap = new Map();
let options = null;

let results = {}; // メモリ上の判定結果 (管理主体)
let resultOrder = []; // メモリ上の結果の順序 (FIFO用)

let referenceJudgmentCache = new Map(); // { normalizedText: matchResults[] }
const MAX_CACHE_SIZE = 3000; // キャッシュするターゲットテキストの最大数
let targetPairCache = new Map(); // { url: Map<pairKey, comparisonResult> }
let activeTabUrls = new Map(); // { tabId: url }

// judgmentRequests: { url: { targets?: [], tabId: number, pending?: boolean, startTime?: number } }
let judgmentRequests = {};
const JUDGMENT_REQUEST_TIMEOUT = 600000; // 10分
let judgmentTimeoutMonitors = {}; // { url: timeoutId }

// content script の準備状態を管理 (揮発性)
let contentScriptReady = {};

let isIndexDirty = true;
let currentRemoveKeywords = [];

// 正規表現オブジェクトをキャッシュするためのグローバル変数
let cachedRemoveKeywordRegexes = [];
let cachedRegexKeywordRegexes = [];

// デバウンス用タイマーID
let saveSegmentsTimeoutId = null;

// メモリ管理用定数
const MAX_SEGMENT_COUNT = 50000;

// --- 編集距離計算用バッファ (GC発生を抑えるため再利用) ---
const ED_MAX_LEN = 1024; // 一般的なコメント長なら十分なサイズ
const edBuffer = new Int32Array(ED_MAX_LEN * 2); // 2行分確保


// --- 定数化された正規表現 (最適化) ---
const TOKENIZER_PATTERNS = [
    'https?:\\/\\/[^\\s]+',
    '[\\w\\.-]+@[\\w\\.-]+\\.\\w+',
    '[\\u{1F300}-\\u{1FAFF}]|[\\u2600-\\u27BF]',
    '[一-龠々〆ヵヶ]+',
    '[ぁ-ん]+',
    '[ァ-ヴー]+',
    "[a-zA-Z]+(?:['\\-][a-zA-Z]+)*",
    '[0-9]+(?:[,\\.][0-9]+)*',
    '[!-/:-@\\[-`{-~]+',
    '\\S'
];
const TOKENIZER_REGEX = new RegExp(TOKENIZER_PATTERNS.join('|'), 'gu');
const KANJI_REGEX = /\p{Script=Han}/gu;


// 参照用テキストをchrome.storage.localに保存（5秒のデバウンス処理付き）
async function saveFixedLengthStringsToStorage() {
    if (saveSegmentsTimeoutId) {
        clearTimeout(saveSegmentsTimeoutId);
    }

    saveSegmentsTimeoutId = setTimeout(async () => {
        // 修正: 判定処理実行中はデータの削除（GC）を行わない
        // インデックスがずれて、実行中の判定プロセスが誤ったデータを参照するのを防ぐため
        const activeRequestCount = Object.keys(judgmentRequests).length;
        if (activeRequestCount > 0) {
            console.log(`[BG] Judgment in progress (${activeRequestCount} tabs). Postponing garbage collection...`);
            saveSegmentsTimeoutId = null;
            saveFixedLengthStringsToStorage(); // 再スケジュール
            return;
        }

        console.log("[BG] Debounce timer fired. Managing and saving data...");
        saveSegmentsTimeoutId = null;

        // 1. メモリ管理（LRU削除など）を実行
        manageFixedLengthStrings();

        // 2. 現在使用中のURL IDをすべて収集
        const usedUrlIds = new Set();
        for (const segment of fixedLengthStrings) {
            if (segment.s !== undefined) {
                usedUrlIds.add(segment.s);
            }
        }

        // 3. 新しいurlStoreとIDの対応表を作成
        const newUrlStore = [];
        const oldIdToNewIdMap = new Map();

        for (let oldId = 0; oldId < urlStore.length; oldId++) {
            if (usedUrlIds.has(oldId)) {
                const newId = newUrlStore.length;
                newUrlStore.push(urlStore[oldId]);
                oldIdToNewIdMap.set(oldId, newId);
            }
        }

        // 4. 各セグメントのsourceUrlIdを新しいIDに更新
        for (const segment of fixedLengthStrings) {
            if (segment.s !== undefined) {
                const newId = oldIdToNewIdMap.get(segment.s);
                if (newId !== undefined) {
                    segment.s = newId;
                }
            }
        }

        // 5. グローバル変数を新しいデータで更新
        const oldUrlCount = urlStore.length;
        urlStore = newUrlStore;
        
        // urlMapも再構築
        urlMap.clear();
        urlStore.forEach((url, id) => {
            urlMap.set(url, id);
        });
        
        console.log(`[BG] URL Store garbage collection complete. URLs reduced from ${oldUrlCount} to ${urlStore.length}.`);

        // 6. 保存用にデータを軽量化
        const stringsToSaveNow = fixedLengthStrings.map(segment => ({
            b: segment.b,
            l: segment.l,
            u: segment.u,
            s: segment.s
        }));
        
        const urlStoreToSaveNow = [...urlStore];

        try {
            await chrome.storage.local.set({ segments: stringsToSaveNow, urlStore: urlStoreToSaveNow });
            console.log(`[BG] Saved ${stringsToSaveNow.length} segments and ${urlStoreToSaveNow.length} URLs to chrome.storage.local.`);
        } catch (error) {
            console.error('[BG] Failed to save data to chrome.storage.local:', error);
        }
    }, 5000); // 5秒のデバウンス時間
}

// 参照用テキストをchrome.storage.localから読み込む
async function loadFixedLengthStringsFromStorage() {
    console.log("[BG] Loading data from chrome.storage.local...");
    try {
        const data = await chrome.storage.local.get(['segments', 'urlStore']);
        const loadedSegments = data.segments || [];
        const loadedUrlStore = data.urlStore || [];
        console.log(`[BG] Loaded ${loadedSegments.length} segments and ${loadedUrlStore.length} URLs from storage.`);
        return { segments: loadedSegments, urlStore: loadedUrlStore };
    } catch (error) {
        console.error("[BG] Failed to load data from chrome.storage.local:", error);
        return { segments: [], urlStore: [] };
    }
}

/**
 * インデックス構築用に、ユニークなN-gramのSetを直接生成する。
 * 修正: 中間配列（Array）を生成せず、メモリ消費を最小限に抑える。
 */
function getUniqueNgrams(text, length) {
    const uniqueSet = new Set();
    if (!text || text.length < length) return uniqueSet;

    const len = text.length;
    // 文字列のスライスは避けられないが、配列に格納して保持するコストを回避
    for (let i = 0; i <= len - length; i++) {
        uniqueSet.add(text.substring(i, i + length));
    }
    return uniqueSet;
}

/**
 * メモリ上の fixedLengthStrings から転置インデックスを構築する。
 * 修正: インデックスの値をSetからArrayに変更し、メモリ効率と走査速度を向上。
 */
function buildInvertedIndex() {
    console.time('[BG] buildInvertedIndex');
    
    const tempIndex = new Map();
    const totalSegments = fixedLengthStrings.length;

    if (totalSegments === 0) {
        invertedIndex = { trigram: new Map() };
        console.timeEnd('[BG] buildInvertedIndex');
        return;
    }

    let cacheHitCount = 0;

    fixedLengthStrings.forEach((segment, index) => {
        if (!segment || !segment.l) {
            segment.t = 0;
            return;
        }
        
        let uniqueTrigramsSet;

        // キャッシュがある場合はそれを使う
        if (segment.p && segment.p.uniqueTrigrams) {
            uniqueTrigramsSet = Array.isArray(segment.p.uniqueTrigrams) 
                ? new Set(segment.p.uniqueTrigrams) 
                : segment.p.uniqueTrigrams;
            cacheHitCount++;
        } else {
            // 前処理
            const joinedText = segment.l.map(line => line.trim()).join('\n');
            const userProcessedTextWithBreaks = applyRemoveKeywords(joinedText);
            const userProcessedText = userProcessedTextWithBreaks.replace(/\r\n|\r|\n/g, '');
            const processedText = applyStandardRemovals(userProcessedText);
            const normalizedText = normalizeForNgram(processedText);
            
            uniqueTrigramsSet = getUniqueNgrams(normalizedText, 3);

            segment.p = {
                text: processedText,
                normalized: normalizedText,
                uniqueTrigrams: Array.from(uniqueTrigramsSet) 
            };
        }

        segment.t = uniqueTrigramsSet.size;
        
        for (const trigram of uniqueTrigramsSet) {
            let entry = tempIndex.get(trigram);
            if (!entry) {
                entry = []; // SetではなくArrayを使用
                tempIndex.set(trigram, entry);
            }
            entry.push(index);
        }
    });

    const newInvertedIndex = new Map();
    for (const [trigram, segmentIds] of tempIndex.entries()) {
        // segmentIds は既に Array
        newInvertedIndex.set(trigram, {
            ids: segmentIds,
            df: segmentIds.length / totalSegments // .size ではなく .length
        });
    }

    invertedIndex = { trigram: newInvertedIndex };
    console.log(`[BG] Built inverted index with ${invertedIndex.trigram.size} unique trigrams. Cache hit: ${cacheHitCount}/${totalSegments}`);
    console.timeEnd('[BG] buildInvertedIndex');
}


function buildTargetInvertedIndex(targets) {
    const index = { trigram: new Map() };
    if (!targets || targets.length === 0) return index;

    targets.forEach((target, targetIndex) => {
        if (!target || !target.processed || !target.processed.normalizedText) return;
        const normalizedText = target.processed.normalizedText;
        
        // ターゲット数は少ないため、ここは既存の generateFixedLengthStrings でも大きな問題はないが
        // 一貫性のため getUniqueNgrams を使うことも可能。
        // ここでは既存ロジック維持（generateFixedLengthStringsは配列を返す）
        const trigrams = generateFixedLengthStrings(normalizedText, 3);
        for (const ngram of new Set(trigrams)) {
            if (!index.trigram.has(ngram)) {
                index.trigram.set(ngram, new Set());
            }
            index.trigram.get(ngram).add(targetIndex);
        }
    });
    return index;
}

// --- 初期化関数 ---
async function initializeExtension() {
    if (options) { return Promise.resolve(); }

    console.log("[BG] initializeExtension: Starting initialization...");

    try {
        options = await loadOptionsFromStorage();
        if (!options) throw new Error("Failed to load options during initialization.");
        
        compileAndCacheRegexes(options);

        currentRemoveKeywords = options.removeKeywords || [];
        console.log("[BG] Options loaded. Loading data from storage...");

        const { segments: loadedStrings, urlStore: loadedUrlStore } = await loadFixedLengthStringsFromStorage();

        urlStore = loadedUrlStore;
        urlMap.clear();
        urlStore.forEach((url, id) => {
            urlMap.set(url, id);
        });

        fixedLengthStrings = [];
        textToTimestampMap.clear();
        const now = Date.now();
        for (const segment of loadedStrings) {
            if (segment && segment.l && Array.isArray(segment.l)) {
                const originalText = segment.l.join('');
                if (originalText && !textToTimestampMap.has(originalText)) {
                    segment.u = segment.u || now;
                    fixedLengthStrings.push(segment);
                    textToTimestampMap.set(originalText, { timestamp: segment.u, segment: segment });
                }
            }
        }
        
        results = {};
        resultOrder = [];
        isIndexDirty = true;

        console.log(`[BG] Initialization complete. Loaded ${fixedLengthStrings.length} strings from storage.`);

    } catch (error) {
        console.error("[BG] Error during extension initialization:", error);
        options = null;
        fixedLengthStrings = []; results = {}; resultOrder = []; urlStore = []; urlMap.clear();
        throw error;
    }
}

// デフォルトオプションを返すヘルパー関数
function getDefaultOptions() {
    return {
        enableReferenceExtraction: DEFAULT_ENABLE_REFERENCE_EXTRACTION,
        trigramChainCount: DEFAULT_TRIGRAM_CHAIN_COUNT,
        editDistance: DEFAULT_EDIT_DISTANCE, enableLineBasedEditDistance: DEFAULT_ENABLE_LINE_BASED_EDIT_DISTANCE, enableFullEditDistance: DEFAULT_ENABLE_FULL_EDIT_DISTANCE,
        trigramEnabled: DEFAULT_TRIGRAM_ENABLED,
        enableKeywordSearch: DEFAULT_ENABLE_KEYWORD_SEARCH, andKeywords: DEFAULT_AND_KEYWORDS, orKeywords: DEFAULT_OR_KEYWORDS, regexKeywords: DEFAULT_REGEX_KEYWORDS,
        excludeTargetKeywords: DEFAULT_EXCLUDE_TARGET_KEYWORDS, excludeReferenceKeywords: DEFAULT_EXCLUDE_REFERENCE_KEYWORDS,
        removeKeywords: DEFAULT_REMOVE_KEYWORDS,
        enableTargetComparison: DEFAULT_ENABLE_TARGET_COMPARISON,
        targetTrigramChainCount: DEFAULT_TARGET_TRIGRAM_CHAIN_COUNT,
        targetEditDistance: DEFAULT_TARGET_EDIT_DISTANCE, enableTargetLineComparison: DEFAULT_ENABLE_TARGET_LINE_COMPARISON, enableTargetFullEditDistance: DEFAULT_ENABLE_TARGET_FULL_EDIT_DISTANCE,
        targetTrigramEnabled: DEFAULT_TARGET_TRIGRAM_ENABLED,
        enableKanjiFiltering: DEFAULT_ENABLE_KANJI_FILTERING,
        minCommonKanji: DEFAULT_MIN_COMMON_KANJI,
        kanjiScoreWeight: DEFAULT_KANJI_SCORE_WEIGHT,
        enableTargetKanjiFiltering: DEFAULT_ENABLE_TARGET_KANJI_FILTERING,
        targetMinCommonKanji: DEFAULT_TARGET_MIN_COMMON_KANJI,
        targetKanjiScoreWeight: DEFAULT_TARGET_KANJI_SCORE_WEIGHT
    };
}

// タブが閉じられた時の処理
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (contentScriptReady[tabId]) {
    delete contentScriptReady[tabId];
  }

  if (activeTabUrls.has(tabId)) {
      const url = activeTabUrls.get(tabId);
      console.log(`[BG] Tab closed: ${tabId}. Clearing cache for URL: ${url}`);
      
      if (targetPairCache.has(url)) {
          targetPairCache.delete(url);
      }
      
      // 修正: tabId をキーにして削除
      if (judgmentTimeoutMonitors[tabId]) {
          clearTimeout(judgmentTimeoutMonitors[tabId]);
          delete judgmentTimeoutMonitors[tabId];
      }
      
      if (judgmentRequests[tabId]) {
          delete judgmentRequests[tabId];
      }

      activeTabUrls.delete(tabId);
  }
  
  // 念のため judgmentRequests の残骸チェック（activeTabUrlsに登録される前のエラー等）
  // 修正: キーが tabId になったので直接チェック可能
  if (judgmentRequests[tabId]) {
      delete judgmentRequests[tabId];
  }
});


// メモリ上の固定長文字列インデックスを整理 (LRU方式)
function manageFixedLengthStrings() {
    console.log("[BG] manageFixedLengthStrings called (LRU)");
    if (fixedLengthStrings.length > MAX_SEGMENT_COUNT) {
        // lastUsed (u) が古い順にソート
        fixedLengthStrings.sort((a, b) => a.u - b.u);

        const deletedCount = fixedLengthStrings.length - MAX_SEGMENT_COUNT;
        const segmentsToDelete = fixedLengthStrings.splice(0, deletedCount);
        
        for (const segment of segmentsToDelete) {
            if (segment.l) {
                const originalText = segment.l.join('');
                textToTimestampMap.delete(originalText);
            }
        }
        console.log(`[BG] ${deletedCount} least recently used fixedLengthStrings deleted from memory.`);
        isIndexDirty = true;
    }
}


function yieldToMainThread() {
    return new Promise(resolve => setTimeout(resolve, 0));
}


function finalizeResults(judgmentResults, options) {
    const copyToSourceMap = new Map();
    const sourceToCopiesMap = new Map();

    // --- ステップA: チェーン解析 ---
    for (const result of judgmentResults) {
        if (result.isSuspicious && result.reason?.matches) {
            for (const match of result.reason.matches) {
                if (match.details.comparisonType === 'target') {
                    const matchSource = match.original[0];
                    const matchCopy = match.original[1];
                    if (copyToSourceMap.has(matchCopy.resno)) continue;
                    if (matchSource?.resno && matchCopy?.resno && matchSource.resno !== matchCopy.resno) {
                        copyToSourceMap.set(matchCopy.resno, matchSource.resno);
                        if (!sourceToCopiesMap.has(matchSource.resno)) {
                            sourceToCopiesMap.set(matchSource.resno, new Map());
                        }
                        sourceToCopiesMap.get(matchSource.resno).set(matchCopy.resno, { resno: matchCopy.resno, rsc: matchCopy.rsc });
                    }
                }
            }
        }
    }

    // --- ステップB: 親フラグと「潜在的なコピー元」フラグを付与 ---
    const trueSourceResnos = new Set();
    for (const resno of sourceToCopiesMap.keys()) {
        if (!copyToSourceMap.has(resno)) {
            trueSourceResnos.add(resno);
        }
    }

    for (const result of judgmentResults) {
        if (result.reason?.matches) {
            const parentResno = copyToSourceMap.get(result.resno);
            if (parentResno) {
                for (const match of result.reason.matches) {
                    if (match.details.comparisonType === 'target' && match.original?.[0]?.resno === parentResno) {
                        match.details.isParent = true;
                    }
                }
            }
        }
        if (trueSourceResnos.has(result.resno)) {
            result.isPotentiallySource = true;
        }
    }

    // --- ステップC: 最終的なソートとトップ理由の決定 ---
    for (const result of judgmentResults) {
        if (result.isSuspicious && result.reason?.matches) {
            result.reason.matches.sort((a, b) => {
                if (result.isPotentiallySource) {
                    const aIsRef = a.details.comparisonType === 'reference';
                    const bIsRef = b.details.comparisonType === 'reference';
                    if (aIsRef && !bIsRef) return -1;
                    if (!aIsRef && bIsRef) return 1;
                }
                const aIsParent = a.details.isParent || false;
                const bIsParent = b.details.isParent || false;
                if (aIsParent && !bIsParent) return -1;
                if (!aIsParent && bIsParent) return 1;
                return b.score - a.score;
            });

            const topMatch = result.reason.matches[0];
            if (topMatch) {
                Object.assign(result.reason, { original: topMatch.original, ...topMatch.details });
            }
        }
    }

    // --- ステップD: 「無実の親」の最終判定 ---
    const suspicionThreshold = (options.suspicionThreshold || 75) / 100.0;
    for (const result of judgmentResults) {
        if (result.isPotentiallySource) {
            const hasSignificantReferenceMatch = result.reason?.matches?.some(
                match => match.details.comparisonType === 'reference' && match.score >= suspicionThreshold
            );
            
            if (!result.reason2?.isMatched && !hasSignificantReferenceMatch) {
                result.isSuspicious = false;
                result.reason = null;
                result.isSourceOfCopy = true;
            }
        }
    }

    // --- ステップE: チェーン情報付与 ---
    for (const result of judgmentResults) {
        if (result.isSuspicious && result.reason?.matches) {
            const copiesMap = sourceToCopiesMap.get(result.resno);
            if (copiesMap) {
                const copies = Array.from(copiesMap.values());
                if (result.reason.comparisonType === 'target' && !result.reason.isParent) {
                   result.reason.matches.forEach(match => {
                        if (match.details.comparisonType === 'target') {
                           match.details.chainInfo = { copies };
                        }
                    });
                }
            }
        }
    }

    return judgmentResults;
}

/**
 * テキスト内の漢字の総数とユニークな漢字のセットを返す。
 * 修正: match()による巨大配列生成を回避し、ループ処理でカウント。
 */
function countKanji(text) {
    if (!text) {
        return { total: 0, unique: new Set() };
    }
    
    const unique = new Set();
    let total = 0;

    // 正規表現オブジェクトのlastIndexをリセット
    KANJI_REGEX.lastIndex = 0;
    
    let match;
    // exec() を使用して、マッチごとに処理を行う（配列を生成しない）
    while ((match = KANJI_REGEX.exec(text)) !== null) {
        total++;
        unique.add(match[0]);
    }

    return {
        total: total,
        unique: unique
    };
}

/// 固定長文字列分割 (スライディングウィンドウ方式)
// ※ buildTargetInvertedIndex 等で配列が必要な場合に使用
function generateFixedLengthStrings(text, length) {
  const result = [];
  if (length <= 0 || !text || text.length < length) return result;

  for (let i = 0; i <= text.length - length; i++) {
    const segment = text.substring(i, i + length);
    result.push(segment);
  }
  return result;
}

// 固定長文字列セグメント生成
function generateFixedLengthSegments(textWithBreaks, lines, sourceUrlId) {
  return {
    b: textWithBreaks || '', // originalWithBreaks
    l: lines || [],          // lines
    u: Date.now(),           // lastUsed
    s: sourceUrlId           // sourceUrlId
  };
}

/**
 * N-gram生成および比較の前に、テキストの表記揺れを吸収するための正規化を行う。
 * 修正: replaceチェーンを統合し、文字列走査回数を削減。
 */
function normalizeForNgram(text) {
    if (!text || typeof text !== 'string') return '';

    // 1. 全角英数変換と小文字化
    let res = text.toLowerCase().replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));

    // 2. 記号類の統一・削除を一括処理
    res = res.replace(/([！!？?])|([、,])|([．。]+)|([〜～ー─―])|([（(『【])|([）)』】])|([\s\t\n\r])|(‥|\.{3}|[・･]{3})/g, 
        (match, p1, p2, p3, p4, p5, p6, p7, p8) => {
            if (p1) return '。';
            if (p2) return '、';
            if (p3) return '。';
            if (p4) return 'ー';
            if (p5) return '「';
            if (p6) return '」';
            if (p7) return ''; // 空白除去
            if (p8) return '…';
            return match;
        }
    );

    return res;
}


/**
 * 比較のノイズとなる標準的なパターンを除去する。
 */
function applyStandardRemovals(text) {
    if (!text) return text;

    let processedText = text;
    const filePatterns = [
        /fu\d+\.(jpg|jpeg|png|gif|webm|webp|mp4)/g,
        /f\d+\.(jpg|jpeg|png|gif|webm|webp|mp4)/g
    ];
    for (const regex of filePatterns) {
        processedText = processedText.replace(regex, '');
    }

    return processedText;
}

/**
 * キャッシュされた正規表現を使用して、ユーザー設定のキーワードを除去します。
 * 修正: キーワード設定がない場合の早期リターンを追加。
 */
function applyRemoveKeywords(text) {
    // 設定がない、または空の場合は即座に返す
    if (!cachedRemoveKeywordRegexes || cachedRemoveKeywordRegexes.length === 0) {
        return text;
    }
    if (!text) return text;

    let processedText = text;
    for (const regex of cachedRemoveKeywordRegexes) {
        processedText = processedText.replace(regex, '');
    }
    return processedText;
}


function countCommonKanji(setA, setB) {
    let commonCount = 0;
    const [smallerSet, largerSet] = setA.size < setB.size ? [setA, setB] : [setB, setA];
    for (const kanji of smallerSet) {
        if (largerSet.has(kanji)) {
            commonCount++;
        }
    }
    return commonCount;
}


async function performJudgment(target, url, { allTargets, targetInvertedIndex }) {
  const currentOptions = options;
  if (!currentOptions) {
      return { url: url, target: target, isSuspicious: false, reason: null, reason2: null, error: "Options not loaded" };
  }

  const processedTarget = target.processed;
  if (!processedTarget) {
      return { url: url, target: target, isSuspicious: false, reason: null, reason2: null, error: "Missing processed data" };
  }
  
  let judgment = {
    url: url, target: target, isSuspicious: false,
    reason: null, reason2: { matchedKeywords: [], isMatched: false }
  };
  
  const targetText = processedTarget.text || '';
  
  // --- 1. キーワード検索 ---
    if (currentOptions.enableKeywordSearch && targetText) {
        let matchedKeywords = []; let keywordMatchFound = false;
        if (currentOptions.andKeywords.length > 0 && currentOptions.andKeywords.every(keyword => targetText.includes(keyword))) {
            matchedKeywords.push(...currentOptions.andKeywords); keywordMatchFound = true;
        }
        const orMatched = currentOptions.orKeywords.filter(keyword => targetText.includes(keyword));
        if (orMatched.length > 0) {
            matchedKeywords.push(...orMatched); keywordMatchFound = true;
        }
        cachedRegexKeywordRegexes.forEach(regexObj => {
            if (!regexObj) return;
            try {
                if (regexObj.test(targetText)) {
                    matchedKeywords.push(regexObj.source);
                    keywordMatchFound = true;
                }
            } catch (error) { console.error("[BG] Invalid regex keyword:", regexObj.source, error); }
        });
        if (keywordMatchFound) {
            judgment.reason2.matchedKeywords = [...new Set(matchedKeywords)];
            judgment.reason2.isMatched = true; judgment.isSuspicious = true;
            return judgment;
		}
    }

  // --- 2. ターゲット間比較 & 参照テキスト比較 ---
  // 修正: url を引数に追加
  const allMatches = await performAllComparisons(target, allTargets, targetInvertedIndex, currentOptions, url);

  // --- 3. 総合ランキングの作成と最終判定 ---
  allMatches.sort((a, b) => b.score - a.score);
  const topMatches = allMatches.slice(0, 3);

  const suspicionThreshold = (currentOptions.suspicionThreshold || 75) / 100.0;

  if (topMatches.length > 0 && topMatches[0].score >= suspicionThreshold) {
      judgment.isSuspicious = true;
      judgment.reason = {
          matches: topMatches,
          original: topMatches[0].original,
          ...topMatches[0].details
      };
  } else {
      judgment.isSuspicious = false;
      judgment.reason = null;
  }

  return judgment;
}



/**
 * Min-Heap (最小ヒープ) クラス
 */
class MinHeap {
    constructor(size, keyFunc) {
        this.size = size;
        this.keyFunc = keyFunc;
        this.heap = [];
    }

    push(element) {
        if (this.heap.length < this.size) {
            this.heap.push(element);
            this._bubbleUp(this.heap.length - 1);
        } else if (this.keyFunc(element) > this.keyFunc(this.heap[0])) {
            this.heap[0] = element;
            this._sinkDown(0);
        }
    }

    getSorted() {
        return this.heap.sort((a, b) => this.keyFunc(b) - this.keyFunc(a));
    }

    _bubbleUp(index) {
        const element = this.heap[index];
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            const parent = this.heap[parentIndex];
            if (this.keyFunc(element) >= this.keyFunc(parent)) break;
            this.heap[index] = parent;
            index = parentIndex;
        }
        this.heap[index] = element;
    }

    _sinkDown(index) {
        const length = this.heap.length;
        const element = this.heap[index];
        const elementKey = this.keyFunc(element);

        while (true) {
            let leftChildIndex = 2 * index + 1;
            let rightChildIndex = 2 * index + 2;
            let leftChild, rightChild;
            let swap = null;

            if (leftChildIndex < length) {
                leftChild = this.heap[leftChildIndex];
                if (this.keyFunc(leftChild) < elementKey) {
                    swap = leftChildIndex;
                }
            }
            if (rightChildIndex < length) {
                rightChild = this.heap[rightChildIndex];
                if (
                    (swap === null && this.keyFunc(rightChild) < elementKey) ||
                    (swap !== null && this.keyFunc(rightChild) < this.keyFunc(leftChild))
                ) {
                    swap = rightChildIndex;
                }
            }
            if (swap === null) break;
            this.heap[index] = this.heap[swap];
            index = swap;
        }
        this.heap[index] = element;
    }
}

function getTopCandidates(scoresMap, key, n) {
    if (scoresMap.size === 0) return [];
    const heap = new MinHeap(n, ([, score]) => score[key]);
    for (const entry of scoresMap.entries()) {
        heap.push(entry);
    }
    return heap.getSorted();
}


/**
 * LRUキャッシュに結果を保存するヘルパー関数
 */
function cacheReferenceJudgment(key, value) {
    if (referenceJudgmentCache.has(key)) {
        // 既存なら削除して末尾に追加（順序更新）
        referenceJudgmentCache.delete(key);
    } else if (referenceJudgmentCache.size >= MAX_CACHE_SIZE) {
        // 上限なら最古（先頭）を削除
        const firstKey = referenceJudgmentCache.keys().next().value;
        referenceJudgmentCache.delete(firstKey);
    }
    referenceJudgmentCache.set(key, value);
}

/**
 * LRUキャッシュから結果を取得するヘルパー関数
 */
function getCachedReferenceJudgment(key) {
    if (!referenceJudgmentCache.has(key)) return null;
    
    // アクセスがあったので末尾に移動（順序更新）
    const value = referenceJudgmentCache.get(key);
    referenceJudgmentCache.delete(key);
    referenceJudgmentCache.set(key, value);
    return value;
}


/**
 * ターゲット間比較と参照テキスト比較の両方を行い、全ての一致候補のリストを返す。
 * 修正: url引数を追加し、ターゲット比較へ伝搬。
 * 修正: キャッシュキーに行構成情報を含め、改行位置の違いによるスコア変動を正しく反映させる。
 */
async function performAllComparisons(target, allTargets, targetInvertedIndex, currentOptions, url) {
    const allMatches = [];
    
    const processedTarget = target.processed;
    const targetLines = processedTarget.lines;
    const normalizedTargetText = processedTarget.normalizedText;
    const targetKanjiStats = processedTarget.kanjiStats;

    // --- 1. ターゲット間比較 ---
    if (currentOptions.enableTargetComparison && allTargets && allTargets.length > 1) {
        const TARGET_CANDIDATE_LIMIT = 50;
        const candidateScores = new Map();
        const targetTrigrams = generateFixedLengthStrings(normalizedTargetText, 3);

        for (const ngram of new Set(targetTrigrams)) {
            const indices = targetInvertedIndex.trigram.get(ngram);
            if (indices) {
                for (const index of indices) {
                    candidateScores.set(index, (candidateScores.get(index) || 0) + 1);
                }
            }
        }

        const heap = new MinHeap(TARGET_CANDIDATE_LIMIT, (entry) => entry[1]);
        for (const entry of candidateScores.entries()) {
            heap.push(entry);
        }
        const sortedCandidates = heap.getSorted();

        for (const [targetIndex] of sortedCandidates) {
            const otherTarget = allTargets[targetIndex];
            if (!otherTarget || target.id === otherTarget.id) continue;

            const comparisonResult = await performTargetComparison([target, otherTarget], currentOptions, url);
            if (comparisonResult.isMatched) {
                const formattedMatch = {
                    score: comparisonResult.finalScore,
                    original: comparisonResult.original,
                    details: { ...comparisonResult, comparisonType: 'target' }
                };
                delete formattedMatch.details.finalScore;
                delete formattedMatch.details.isMatched;
                allMatches.push(formattedMatch);
            }
        }
    }

    // --- 2. 参照テキスト比較 ---
    if (currentOptions.enableReferenceComparison && fixedLengthStrings && fixedLengthStrings.length > 0) {
        
        // ★修正: キャッシュキーに行構成情報（各行の長さ）を追加
        // これにより、テキストは同じだが改行位置が異なるケース（line-edit-distの結果が変わる）を区別する
        const lineConfigKey = targetLines.map(l => l.length).join(',');
        const cacheKey = `${normalizedTargetText}|${lineConfigKey}`;

        const cachedMatches = getCachedReferenceJudgment(cacheKey);
        if (cachedMatches) {
            const deepCopiedMatches = cachedMatches.map(m => ({
                score: m.score,
                original: [...m.original],
                details: { ...m.details }
            }));
            
            return [...allMatches, ...deepCopiedMatches];
        }

        const referenceMatches = [];
        
        const HIT_COUNT_POOL_SIZE = 30;
        const SIMILARITY_POOL_SIZE = 20;
        
        const MIN_SEGMENTS_FOR_PRUNING = 200;
        const totalDocs = fixedLengthStrings.length;
        const enablePruning = totalDocs >= MIN_SEGMENTS_FOR_PRUNING;

        let dfThreshold = 0.1;
        if (enablePruning) {
            dfThreshold = Math.min(0.10, Math.max(1.0, 10000 / totalDocs));
        }
        
        const targetTrigrams = new Set(generateFixedLengthStrings(normalizedTargetText, 3));
        const totalTargetTrigrams = targetTrigrams.size;

        const scoresBuffer = new Uint16Array(totalDocs);
        const touchedIndices = [];

        if (totalTargetTrigrams > 0) {
            for (const trigram of targetTrigrams) {
                const indexEntry = invertedIndex.trigram.get(trigram);
                
                if (!indexEntry) continue;

                const currentDf = indexEntry.df; 
                if (enablePruning && currentDf > dfThreshold) {
                    continue;
                }
                
                const { ids } = indexEntry;
                const idsLen = ids.length;
                for (let i = 0; i < idsLen; i++) {
                    const index = ids[i];
                    if (scoresBuffer[index] === 0) {
                        touchedIndices.push(index);
                    }
                    scoresBuffer[index]++;
                }
            }
        }

        const hitHeap = new MinHeap(HIT_COUNT_POOL_SIZE, (entry) => entry.hit);
        const simHeap = new MinHeap(SIMILARITY_POOL_SIZE, (entry) => entry.sim);

        for (const index of touchedIndices) {
            const hitCount = scoresBuffer[index];
            const refSegment = fixedLengthStrings[index];
            
            if (refSegment && refSegment.l) {
                let totalRefTrigrams = refSegment.t;
                if (totalRefTrigrams === undefined) {
                    if (!refSegment.p) {
                        const joinedText = refSegment.l.join('\n');
                        const userProcessedTextWithBreaks = applyRemoveKeywords(joinedText);
                        const userProcessedText = userProcessedTextWithBreaks.replace(/\r\n|\r|\n/g, '');
                        const refProcessedText = applyStandardRemovals(userProcessedText);
                        const refNormalized = normalizeForNgram(refProcessedText);
                        
                        const uniqueTrigramsSet = getUniqueNgrams(refNormalized, 3);

                        refSegment.p = {
                            text: refProcessedText,
                            normalized: refNormalized,
                            uniqueTrigrams: Array.from(uniqueTrigramsSet)
                        };
                        totalRefTrigrams = uniqueTrigramsSet.size;
                    } else {
                        totalRefTrigrams = refSegment.p.uniqueTrigrams.length;
                    }
                    refSegment.t = totalRefTrigrams;
                }
                
                let similarity = 0;
                if (totalTargetTrigrams + totalRefTrigrams > 0) {
                    similarity = (2 * hitCount) / (totalTargetTrigrams + totalRefTrigrams);
                }

                const entry = { index, hit: hitCount, sim: similarity };
                hitHeap.push(entry);
                simHeap.push(entry);
            }
        }

        const finalCandidateIndices = new Set();
        hitHeap.getSorted().forEach(e => finalCandidateIndices.add(e.index));
        simHeap.getSorted().forEach(e => finalCandidateIndices.add(e.index));
        
        for (const refIndex of finalCandidateIndices) {
            const referenceSegment = fixedLengthStrings[refIndex];
            if (!referenceSegment || !referenceSegment.l) continue;
            
            if (!referenceSegment.p) {
                const joinedText = referenceSegment.l.join('\n');
                const userProcessedTextWithBreaks = applyRemoveKeywords(joinedText);
                const userProcessedText = userProcessedTextWithBreaks.replace(/\r\n|\r|\n/g, '');
                const refProcessedText = applyStandardRemovals(userProcessedText);
                const normalizedReferenceText = normalizeForNgram(refProcessedText);
                
                const uniqueTrigramsSet = getUniqueNgrams(normalizedReferenceText, 3);

                referenceSegment.p = {
                    text: refProcessedText,
                    normalized: normalizedReferenceText,
                    uniqueTrigrams: Array.from(uniqueTrigramsSet)
                };
                referenceSegment.t = uniqueTrigramsSet.size;
            }
            
            const referenceText = referenceSegment.p.text;
            const normalizedReferenceText = referenceSegment.p.normalized;
            
            let currentMatchInfo = { isMatched: false, score: 0, details: {} };
            let referenceLines = null;

            if (currentOptions.enableFullEditDistance || currentOptions.enableLineBasedEditDistance) {
                if (!referenceSegment.p.lines) {
                    const joinedText = referenceSegment.l.join('\n');
                    const processedJoined = applyStandardRemovals(applyRemoveKeywords(joinedText));
                    referenceSegment.p.lines = processedJoined.split('\n');
                }
                referenceLines = referenceSegment.p.lines;
            }

            if (currentOptions.enableFullEditDistance) {
                const targetNonQuoteText = targetLines.join('');
                const referenceNonQuoteText = referenceLines.join('');
                
                const lenDiff = Math.abs(targetNonQuoteText.length - referenceNonQuoteText.length);
                if (targetNonQuoteText.length > 6 && referenceNonQuoteText.length > 6 && lenDiff < 4) {
                    const dist = calculateEditDistance(targetNonQuoteText, referenceNonQuoteText, currentOptions.editDistance);
                    if (dist <= currentOptions.editDistance) {
                        currentMatchInfo = { isMatched: true, score: 2.0 - (dist * 0.02), details: { matchType: 'full-edit-dist', editDistance: dist } };
                    }
                }
            }

            if (!currentMatchInfo.isMatched && currentOptions.enableLineBasedEditDistance && targetLines.length > 0 && referenceLines && referenceLines.length > 0) {
                let bestLineMatch = { distance: Infinity, targetLine: '', refLine: '' };
                
                for (const targetLine of targetLines) {
                    const tLen = targetLine.length;
                    if (tLen <= 6) continue;

                    for (const referenceLine of referenceLines) {
                        const rLen = referenceLine.length;
                        if (rLen <= 6) continue;
                        
                        if (Math.abs(tLen - rLen) >= 4) continue;

                        const lineDist = calculateEditDistance(targetLine, referenceLine, currentOptions.editDistance);
                        if (lineDist <= currentOptions.editDistance && lineDist < bestLineMatch.distance) {
                            bestLineMatch = { distance: lineDist, targetLine, refLine: referenceLine };
                            if (lineDist === 0) break;
                        }
                    }
                    if (bestLineMatch.distance === 0) break;
                }

                if (bestLineMatch.distance !== Infinity) {
                    const referenceOriginalText = referenceSegment.l.join('');
                    const targetFull = target.textWithBreaks || target.text || '';
                    const refFull = referenceSegment.b || referenceOriginalText;

                    currentMatchInfo = { 
                        isMatched: true, 
                        score: 1.95 - (bestLineMatch.distance * 0.02), 
                        details: { 
                            matchType: 'line-edit-dist', 
                            matchedLines: { 
                                target: bestLineMatch.targetLine, 
                                reference: bestLineMatch.refLine, 
                                distance: bestLineMatch.distance,
                                targetFullText: targetFull, 
                                referenceFullText: refFull 
                            }, 
                            editDistance: null 
                        } 
                    };
                }
            }

            if (!currentMatchInfo.isMatched && (currentOptions.trigramEnabled || currentOptions.enableJaccardHybrid)) {
                let bestScore = 0;
                let bestDetails = {};
                const threshold = (currentOptions.suspicionThreshold || 75) / 100.0;

                if (currentOptions.trigramEnabled) {
                    let skipTrigram = false;
                    if (currentOptions.enableKanjiFiltering) {
                        const referenceKanjiStats = countKanji(referenceText);
                        const commonKanji = countCommonKanji(targetKanjiStats.unique, referenceKanjiStats.unique);
                        if (commonKanji < currentOptions.minCommonKanji) {
                            skipTrigram = true;
                        }
                    }

                    if (!skipTrigram) {
                        const trigramResult = compareByFixedLengthStrings(normalizedTargetText, normalizedReferenceText, 'trigram');
                        if (trigramResult.longestChain < currentOptions.trigramChainCount) {
                            bestScore = trigramResult.longestChain / currentOptions.trigramChainCount;
                        } else {
                            bestScore = 1.0 + ((trigramResult.longestChain - currentOptions.trigramChainCount) * 0.05);
                            bestScore = Math.min(bestScore, 1.89);
                        }
                        bestDetails = { matchType: 'ngram', trigrams: trigramResult, editDistance: null };
                    }
                }

                if (bestScore >= threshold) {
                    currentMatchInfo = {
                        isMatched: true,
                        score: bestScore,
                        details: bestDetails
                    };
                } 
                else if (currentOptions.enableJaccardHybrid) {
                    const targetLen = normalizedTargetText.length;
                    const refLen = normalizedReferenceText.length;
                    const lenRatio = refLen > 0 ? targetLen / refLen : 0;
                    
                    if (lenRatio >= 0.5 && lenRatio <= 2.0) {
                        const jaccardResult = calculateHybridSimilarity(normalizedTargetText, normalizedReferenceText);
                        
                        if (jaccardResult.score > bestScore) {
                            bestScore = jaccardResult.score;
                            bestDetails = { ...jaccardResult.details, editDistance: null };
                        }
                    }
                    
                    currentMatchInfo = {
                        isMatched: false,
                        score: bestScore,
                        details: bestDetails
                    };
                } else {
                    currentMatchInfo = {
                        isMatched: false,
                        score: bestScore,
                        details: bestDetails
                    };
                }
            }
            
            if (currentMatchInfo.score > 0) {
                let finalScore = currentMatchInfo.score;
                
                if (currentOptions.enableKanjiFiltering && currentMatchInfo.details.matchType === 'ngram') {
                    const referenceKanjiStats = countKanji(referenceText);
                    const commonKanji = countCommonKanji(targetKanjiStats.unique, referenceKanjiStats.unique);
                    const minUnique = Math.min(targetKanjiStats.unique.size, referenceKanjiStats.unique.size);
                    
                    const relativeSimilarity = minUnique > 0 ? commonKanji / minUnique : 0;
                    
                    const ABSOLUTE_SCORE_SATURATION_POINT = 15;
                    const absoluteScore = Math.min(commonKanji, ABSOLUTE_SCORE_SATURATION_POINT) / ABSOLUTE_SCORE_SATURATION_POINT;
                    
                    const kanjiSimilarity = Math.max(relativeSimilarity, absoluteScore);
                    
                    if (currentOptions.kanjiScoreWeight !== 'none') {
                        const weights = { low: 0.3, medium: 0.5, high: 0.7 };
                        const kanjiWeight = weights[currentOptions.kanjiScoreWeight] || 0.5;
                        finalScore = (currentMatchInfo.score * (1 - kanjiWeight)) + (kanjiSimilarity * kanjiWeight);
                    }

                    currentMatchInfo.details.kanjiInfo = { targetUnique: targetKanjiStats.unique.size, refUnique: referenceKanjiStats.unique.size, common: commonKanji, similarity: kanjiSimilarity };
                }
                
                if (finalScore > 0) {
                    const sourceUrl = urlStore[referenceSegment.s] || '';
                    const referenceOriginalText = referenceSegment.l.join('');
                    const newMatch = {
                        score: finalScore,
                        original: [{ 
                            text: referenceOriginalText, 
                            textWithBreaks: referenceSegment.b,
                            sourceUrl: sourceUrl
                        }],
                        details: { ...currentMatchInfo.details, comparisonType: 'reference' }
                    };
                    referenceMatches.push(newMatch);
                    allMatches.push(newMatch);
                }
            }
        }

        const matchesToCache = referenceMatches.map(m => ({
            score: m.score,
            original: [...m.original],
            details: { ...m.details }
        }));
        // 修正: 生成したキーを使用
        cacheReferenceJudgment(cacheKey, matchesToCache);
    }
    
    return allMatches;
}


// ターゲット間比較を行う関数
// 修正: キャッシュキーの生成においてIDのソートを廃止し、方向性を維持する。
// 修正: キャッシュ汚染を防ぐため、取得時と保存時にオブジェクトのコピーを行う。
async function performTargetComparison(targets, currentOptions, url) {
    if (!targets || targets.length < 2 || !targets[0] || !targets[1]) {
        return { isMatched: false, finalScore: 0 };
    }

    // --- キャッシュ確認 ---
    const t1 = targets[0];
    const t2 = targets[1];
    // resnoがあればそれを、なければidを使用
    const id1 = t1.resno !== undefined ? t1.resno : t1.id;
    const id2 = t2.resno !== undefined ? t2.resno : t2.id;
    
    // 非対称な比較に対応するため、IDのソートを行わず、比較の方向性を維持したキーにする。
    const key = `${id1}:${id2}`;
    
    let urlCache = targetPairCache.get(url);
    if (!urlCache) {
        urlCache = new Map();
        targetPairCache.set(url, urlCache);
    }
    
    if (urlCache.has(key)) {
        const cached = urlCache.get(key);
        // キャッシュ汚染防止のためディープコピー（必要な範囲で）を返す
        return {
            ...cached,
            original: cached.original ? [...cached.original] : undefined,
            matchedLines: cached.matchedLines ? { ...cached.matchedLines } : undefined,
            // details内の他の深いオブジェクトがあればここでもコピーが必要だが、
            // 現状の構造ならこれで十分安全
        };
    }
    // -------------------

    const target1Data = targets[0];
    const target2Data = targets[1];

    const target1NonQuoteLines = target1Data.processed.lines;
    const target2NonQuoteLines = target2Data.processed.lines;

    let currentMatchInfo = {
        isMatched: false,
        score: 0,
        details: {}
    };

    // --- 1. 【最優先】全文編集距離の評価 ---
    if (currentOptions.enableTargetFullEditDistance) {
        const target1NonQuoteText = target1Data.processed.text;
        const target2NonQuoteText = target2Data.processed.text;

        if (target1NonQuoteText.length > 6 && target2NonQuoteText.length > 6 && Math.abs(target1NonQuoteText.length - target2NonQuoteText.length) < 4) {
            const dist = calculateEditDistance(target1NonQuoteText, target2NonQuoteText, currentOptions.targetEditDistance);
            if (dist <= currentOptions.targetEditDistance) {
                const score = 2.0 - (dist * 0.02);
                currentMatchInfo = {
                    isMatched: true, score: score,
                    details: { matchType: 'full-edit-dist', editDistance: dist }
                };
            }
        }
    }

    // --- 2. 【第二段階】行単位編集距離の評価 ---
    if (!currentMatchInfo.isMatched && currentOptions.enableTargetLineComparison && target1NonQuoteLines.length > 0 && target2NonQuoteLines.length > 0) {
        
        let bestLineMatch = { distance: Infinity, line1: '', line2: '' };

        for (const line1 of target1NonQuoteLines) {
            const len1 = line1.length;
            if (len1 <= 6) continue;

            for (const line2 of target2NonQuoteLines) {
                const len2 = line2.length;
                if (len2 <= 6) continue;

                if (Math.abs(len1 - len2) < 4) {
                    const dist = calculateEditDistance(line1, line2, currentOptions.targetEditDistance);
                    if (dist <= currentOptions.targetEditDistance && dist < bestLineMatch.distance) {
                        bestLineMatch = { distance: dist, line1: line1, line2: line2 };
                        if (dist === 0) break;
                    }
                }
            }
            if (bestLineMatch.distance === 0) break;
        }

        if (bestLineMatch.distance !== Infinity) {
            const score = 1.95 - (bestLineMatch.distance * 0.02);
            currentMatchInfo = {
                isMatched: true, score: score,
                details: {
                    matchType: 'line-edit-dist',
                    matchedLines: { 
                        lineFromTarget1: bestLineMatch.line1, 
                        lineFromTarget2: bestLineMatch.line2, 
                        distance: bestLineMatch.distance 
                    },
                    editDistance: null
                }
            };
        }
    }

    // --- 3. 【第三段階】N-gram & Hybrid評価 ---
    if (!currentMatchInfo.isMatched && (currentOptions.targetTrigramEnabled || currentOptions.enableTargetJaccardHybrid)) {
        const normalizedTarget1 = target1Data.processed.normalizedText;
        const normalizedTarget2 = target2Data.processed.normalizedText;
        const threshold = (currentOptions.suspicionThreshold || 75) / 100.0;

        let bestScore = 0;
        let bestDetails = {};

        // 1. Trigramスコア計算 (高速・優先)
        if (currentOptions.targetTrigramEnabled) {
            let skipTrigram = false;
            if (currentOptions.enableTargetKanjiFiltering) {
                const target1Kanji = target1Data.processed.kanjiStats.unique;
                const target2Kanji = target2Data.processed.kanjiStats.unique;
                const commonKanji = countCommonKanji(target1Kanji, target2Kanji);
                if (commonKanji < currentOptions.targetMinCommonKanji) {
                    skipTrigram = true;
                }
            }

            if (!skipTrigram) {
                const trigramResult = compareByFixedLengthStrings(normalizedTarget1, normalizedTarget2, 'trigram');
                if (trigramResult.longestChain < currentOptions.targetTrigramChainCount) {
                    bestScore = trigramResult.longestChain / currentOptions.targetTrigramChainCount;
                } else {
                    bestScore = 1.0 + ((trigramResult.longestChain - currentOptions.targetTrigramChainCount) * 0.05);
                    bestScore = Math.min(bestScore, 1.89);
                }
                bestDetails = { matchType: 'ngram', trigrams: trigramResult, editDistance: null };
            }
        }

        // 2. 早期リターン判定
        if (bestScore >= threshold) {
            currentMatchInfo = {
                isMatched: true,
                score: bestScore,
                details: bestDetails
            };
        }
        // 3. Hybridスコア計算 (Trigramが不十分な場合のみ)
        else if (currentOptions.enableTargetJaccardHybrid) {
            const len1 = normalizedTarget1.length;
            const len2 = normalizedTarget2.length;
            const lenRatio = len2 > 0 ? len1 / len2 : 0;

            if (lenRatio >= 0.5 && lenRatio <= 2.0) {
                const jaccardResult = calculateHybridSimilarity(normalizedTarget1, normalizedTarget2);
                
                if (jaccardResult.score > bestScore) {
                    bestScore = jaccardResult.score;
                    bestDetails = { ...jaccardResult.details, editDistance: null };
                }
            }

            currentMatchInfo = {
                isMatched: false,
                score: bestScore,
                details: bestDetails
            };
        } else {
             currentMatchInfo = {
                isMatched: false,
                score: bestScore,
                details: bestDetails
            };
        }
    }

    // --- 4. 総合スコア計算 ---
    let finalScore = currentMatchInfo.score;
    if (currentOptions.enableTargetKanjiFiltering && currentMatchInfo.details.matchType === 'ngram') {
        const target1Kanji = target1Data.processed.kanjiStats.unique;
        const target2Kanji = target2Data.processed.kanjiStats.unique;
        const commonKanji = countCommonKanji(target1Kanji, target2Kanji);
        const minUnique = Math.min(target1Kanji.size, target2Kanji.size);

        const relativeSimilarity = minUnique > 0 ? commonKanji / minUnique : 0;

        const ABSOLUTE_SCORE_SATURATION_POINT = 15;
        const absoluteScore = Math.min(commonKanji, ABSOLUTE_SCORE_SATURATION_POINT) / ABSOLUTE_SCORE_SATURATION_POINT;

        const kanjiSimilarity = Math.max(relativeSimilarity, absoluteScore);

        if (currentOptions.targetKanjiScoreWeight !== 'none') {
            const weights = { low: 0.3, medium: 0.5, high: 0.7 };
            const kanjiWeight = weights[currentOptions.targetKanjiScoreWeight] || 0.5;
            finalScore = (currentMatchInfo.score * (1 - kanjiWeight)) + (kanjiSimilarity * kanjiWeight);
        }

        currentMatchInfo.details.kanjiInfo = {
            targetUnique: target1Kanji.size, refUnique: target2Kanji.size,
            common: commonKanji, similarity: kanjiSimilarity
        };
    }

    // --- 5. 最終判定 ---
    const suspicionThreshold = (currentOptions.suspicionThreshold || 75) / 100.0;
    let result = { isMatched: finalScore >= suspicionThreshold, finalScore: finalScore };
    if (result.isMatched) {
        result = {
            ...result,
            original: [targets[0], targets[1]],
            ...currentMatchInfo.details
        };
        const [targetA, targetB] = result.original;
        const resnoA = parseInt(targetA.resno, 10);
        const resnoB = parseInt(targetB.resno, 10);
        let swapped = false;
        if (!isNaN(resnoA) && !isNaN(resnoB) && resnoA > resnoB) {
            result.original = [targetB, targetA];
            swapped = true;
        }
        if (result.matchedLines) {
            const { lineFromTarget1, lineFromTarget2, distance } = result.matchedLines;
            result.matchedLines = {
                lineSource: swapped ? lineFromTarget2 : lineFromTarget1,
                lineCopy:   swapped ? lineFromTarget1 : lineFromTarget2,
                distance: distance
            };
        }
    }

    // --- キャッシュ保存 ---
    // 保存時もコピーを作成して、後続の変更から保護する
    urlCache.set(key, {
        ...result,
        original: result.original ? [...result.original] : undefined,
        matchedLines: result.matchedLines ? { ...result.matchedLines } : undefined
    });
    // -------------------

    return result;
}



/**
 * 固定長文字列による比較
 * 修正: 配列生成を最小限にし、Setのルックアップを効率化。
 */
function compareByFixedLengthStrings(text1, text2, type) {
  const result = { total: 0, longestChain: 0, matchedStrings: [] };
  if (!text1 || !text2 || !type) return result;

  const lengthMap = { "trigram": 3 };
  const length = lengthMap[type];
  if (!length) return result;
  
  // 短いテキストで早期リターン
  if (text1.length < length || text2.length < length) return result;

  // text2 (参照側) のN-gram Setを作成
  const refSet = getUniqueNgrams(text2, length);
  
  if (refSet.size === 0) return result;

  const matchedSet = new Set();
  let currentChain = 0;
  let longestChain = 0;

  // text1 を走査しながら、refSet に存在するか確認
  const len1 = text1.length;
  for (let i = 0; i <= len1 - length; i++) {
      const targetStr = text1.substring(i, i + length);
      
      if (refSet.has(targetStr)) {
          matchedSet.add(targetStr);
          currentChain++;
      } else {
          if (currentChain > longestChain) {
              longestChain = currentChain;
          }
          currentChain = 0;
      }
  }
  
  if (currentChain > longestChain) {
      longestChain = currentChain;
  }

  result.total = matchedSet.size;
  result.matchedStrings = Array.from(matchedSet);
  result.longestChain = longestChain;

  return result;
}

/**
 * 編集距離の計算 (最適化版: バッファ再利用)
 * 修正: Int32Arrayバッファを再利用し、メモリアロケーションを排除。
 */
function calculateEditDistance(text1, text2, threshold) {
    if (text1 == null || text2 == null) return Infinity;
    if (text1 === text2) return 0;
    
    const len1 = text1.length;
    const len2 = text2.length;
    
    if (threshold === undefined || threshold < 0) threshold = Infinity;
    if (Math.abs(len1 - len2) > threshold) return Infinity;

    // 長い方を外側のループ(text1)にするか、短い方を内側にするかは
    // メモリ効率上、短い方を内側(行サイズ)にするのが定石
    if (len1 < len2) {
        return calculateEditDistance(text2, text1, threshold);
    }

    // バッファサイズを超える場合は、例外的に都度確保する（安全性確保）
    const useBuffer = (len2 + 1) <= ED_MAX_LEN;
    
    let prevRow, currRow;
    let prevRowOffset = 0;
    let currRowOffset = 0;

    if (useBuffer) {
        // バッファ上のオフセットを使用（subarrayを作らず直接アクセスした方が高速だが、
        // コードの可読性と管理のため、ここでは参照変数として扱う。
        // ただしsubarrayはオブジェクトを作るので、生のTypedArrayとオフセットで管理する）
        prevRow = edBuffer;
        prevRowOffset = 0;
        
        currRow = edBuffer;
        currRowOffset = ED_MAX_LEN;
    } else {
        prevRow = new Int32Array(len2 + 1);
        currRow = new Int32Array(len2 + 1);
        prevRowOffset = 0;
        currRowOffset = 0;
    }

    // 初期化
    for (let j = 0; j <= len2; j++) {
        prevRow[prevRowOffset + j] = j;
    }

    for (let i = 1; i <= len1; i++) {
        currRow[currRowOffset + 0] = i;
        let minValInRow = i;
        const char1 = text1[i - 1];

        for (let j = 1; j <= len2; j++) {
            const cost = char1 === text2[j - 1] ? 0 : 1;
            
            // TypedArrayへのアクセス
            const vDiag = prevRow[prevRowOffset + j - 1] + cost;
            const vTop  = prevRow[prevRowOffset + j] + 1;
            const vLeft = currRow[currRowOffset + j - 1] + 1;

            // Math.min の代わりにif文展開（V8最適化）
            let val = vDiag;
            if (vTop < val) val = vTop;
            if (vLeft < val) val = vLeft;

            currRow[currRowOffset + j] = val;
            
            if (val < minValInRow) {
                minValInRow = val;
            }
        }

        if (minValInRow > threshold) {
            return Infinity;
        }

        // 行の入れ替え（オフセットまたは参照の交換）
        if (useBuffer) {
            const tempOffset = prevRowOffset;
            prevRowOffset = currRowOffset;
            currRowOffset = tempOffset;
        } else {
            const temp = prevRow;
            prevRow = currRow;
            currRow = temp;
        }
    }

    return prevRow[prevRowOffset + len2] <= threshold ? prevRow[prevRowOffset + len2] : Infinity;
}


/**
 * ハイブリッド類似度計算
 * 修正: 各指標の重みを増加させ、合計最大値を1.5（150%）に設定。
 * これにより、Jaccard係数が0になるようなケース（ひらがなのみ等）でも、
 * 被覆率やブロック一致率が高ければ閾値（0.75）を超えられるようにする。
 */
function calculateHybridSimilarity(targetText, referenceText) {
    const BLOCK_SIZE = 5; //5では5-gramになる
    const START_BONUS_LENGTH = 8; //文頭8文字
    const END_BONUS_LENGTH = 8;
    const LOW_KANJI_BONUS_THRESHOLD = 2;

    const normalizedTarget = targetText;
    const normalizedRef = referenceText;

    if (normalizedTarget.length < 7 || normalizedRef.length < 7) {
        return { score: 0, details: { matchType: 'too_short' } };
    }

    const refUnigramMap = getNgramMap(normalizedRef, 1);
    let coveredCountT = 0;
    for (let i = 0; i < normalizedTarget.length; i++) {
        if (refUnigramMap.has(normalizedTarget[i])) {
            coveredCountT++;
        }
    }
    const targetUnigramMap = getNgramMap(normalizedTarget, 1);
    let coveredCountR = 0;
    for (let i = 0; i < normalizedRef.length; i++) {
        if (targetUnigramMap.has(normalizedRef[i])) {
            coveredCountR++;
        }
    }
    const coverageT = normalizedTarget.length === 0 ? 0 : coveredCountT / normalizedTarget.length;
    const coverageR = normalizedRef.length === 0 ? 0 : coveredCountR / normalizedRef.length;

    const targetTokenMap = getTokenMap(normalizedTarget);
    const refTokenMap = getTokenMap(normalizedRef);
    const allKeys = new Set([...targetTokenMap.keys(), ...refTokenMap.keys()]);
    let intersectionSize = 0;
    let unionSize = 0;
    for (const key of allKeys) {
        const targetCount = targetTokenMap.get(key) || 0;
        const refCount = refTokenMap.get(key) || 0;
        intersectionSize += Math.min(targetCount, refCount);
        unionSize += Math.max(targetCount, refCount);
    }
    const jaccard = unionSize === 0 ? 0 : intersectionSize / unionSize;

    const targetBlocks = getNgramSet(normalizedTarget, BLOCK_SIZE);
    const refBlocks = getNgramSet(normalizedRef, BLOCK_SIZE);
    const commonBlocks = new Set([...targetBlocks].filter(x => refBlocks.has(x)));
    const blockCoverage = targetBlocks.size === 0 ? 0 : commonBlocks.size / targetBlocks.size;

    // ★修正: 重み付けの変更 (合計 1.5)
    // CoverageT (0.5) + CoverageR (0.2) + Jaccard (0.4) + Block (0.4) = 1.5
    let score =
        0.50 * coverageT +
        0.20 * coverageR +
        0.40 * jaccard +
        0.40 * blockCoverage;

    const details = {
        matchType: 'hybrid_token_similarity',
        coverageT: Number(coverageT.toFixed(4)),
        coverageR: Number(coverageR.toFixed(4)),
        jaccard: Number(jaccard.toFixed(4)),
        blockCoverage: Number(blockCoverage.toFixed(4)),
    };

    const MIN_UNIQUE_KANJI_FOR_CORRECTION = 3;
    const targetKanji = getUniqueKanjiSet(targetText);
    const refKanji = getUniqueKanjiSet(referenceText);
    if (targetKanji.size >= MIN_UNIQUE_KANJI_FOR_CORRECTION && refKanji.size >= MIN_UNIQUE_KANJI_FOR_CORRECTION) {
        const commonKanji = [...targetKanji].filter(c => refKanji.has(c)).length;
        const minUnique = Math.min(targetKanji.size, refKanji.size);
        const relativeSimilarity = minUnique > 0 ? commonKanji / minUnique : 0;
        const ABSOLUTE_SCORE_SATURATION_POINT = 15;
        const absoluteScore = Math.min(commonKanji, ABSOLUTE_SCORE_SATURATION_POINT) / ABSOLUTE_SCORE_SATURATION_POINT;
        const kanjiSimilarity = Math.max(relativeSimilarity, absoluteScore);
        const kanjiWeight = 0.5;
        
        // 漢字補正: スコアが1.0を超えている場合でも、漢字が全く合わなければ減点される挙動は維持
        score = (score * (1 - kanjiWeight)) + (kanjiSimilarity * kanjiWeight);
        
        details.kanjiCorrection = { applied: true, weight: kanjiWeight, similarity: Number(kanjiSimilarity.toFixed(4)), method: 'max(relative, absolute)', relative: Number(relativeSimilarity.toFixed(4)), absolute: Number(absoluteScore.toFixed(4)), targetUnique: targetKanji.size, refUnique: refKanji.size, common: commonKanji };
    } else {
        details.kanjiCorrection = { applied: false, reason: "not_enough_kanji" };
    }

    const boostInfo = { total: 0, startBonus: 0, endBonus: 0, lowKanjiBonus: 0 };
    if (START_BONUS_LENGTH > 0 && targetText.slice(0, START_BONUS_LENGTH) === referenceText.slice(0, START_BONUS_LENGTH)) {
        boostInfo.startBonus = 0.12; 
    }
    if (END_BONUS_LENGTH > 0 && targetText.slice(-END_BONUS_LENGTH) === referenceText.slice(-END_BONUS_LENGTH)) {
        boostInfo.endBonus = 0.12;
    }
    KANJI_REGEX.lastIndex = 0;
    const targetKanjiCount = (targetText.match(KANJI_REGEX) || []).length;
    if (targetKanjiCount <= LOW_KANJI_BONUS_THRESHOLD) {
        boostInfo.lowKanjiBonus = 0.08;
    }
    boostInfo.total = boostInfo.startBonus + boostInfo.endBonus + boostInfo.lowKanjiBonus;
    score += boostInfo.total;
    details.boostInfo = boostInfo;

    // ★修正: 上限キャップを緩和 (1.0 -> 2.0)
    // 編集距離ベースのスコアが最大2.0程度になるため、それに合わせる
    const finalScore = Math.min(score, 2.0);

    return {
        score: Number(finalScore.toFixed(4)),
        details: details
    };
}


/**
 * 正規表現を用いた高機能・軽量Tokenizer。
 * 定数化された正規表現を使用。
 */
function regexTokenizerAdvanced(text) {
    if (!text) {
        return [];
    }
    TOKENIZER_REGEX.lastIndex = 0;
    return text.match(TOKENIZER_REGEX) || [];
}

function getTokenMap(text) {
    const map = new Map();
    if (!text) return map;
    
    TOKENIZER_REGEX.lastIndex = 0;
    let match;
    while ((match = TOKENIZER_REGEX.exec(text)) !== null) {
        const token = match[0];
        map.set(token, (map.get(token) || 0) + 1);
    }
    return map;
}

function getNgramMap(text, n) {
    const map = new Map();
    if (!text || text.length < n) {
        return map;
    }
    for (let i = 0; i <= text.length - n; i++) {
        const ngram = text.substr(i, n);
        map.set(ngram, (map.get(ngram) || 0) + 1);
    }
    return map;
}

function getNgramSet(text, n) {
    const set = new Set();
    if (!text || text.length < n) {
        return set;
    }
    for (let i = 0; i <= text.length - n; i++) {
        set.add(text.substr(i, n));
    }
    return set;
}

function getUniqueKanjiSet(text) {
    const set = new Set();
    for (const ch of text) {
        if (/\p{Script=Han}/gu.test(ch)) set.add(ch);
    }
    return set;
}


// --- 判定処理を実行する独立した関数 ---
async function executeJudgmentProcess(url, tabId, targets) {
    let judgmentResults = [];
    let processError = null;

    try {
        if (isIndexDirty || !invertedIndex.trigram.size) {
            console.log("[BG] Index is dirty or not built. Rebuilding inverted index...");
            buildInvertedIndex();
            isIndexDirty = false;
        }

        if (options.enableReferenceExtraction && (!fixedLengthStrings || fixedLengthStrings.length === 0)) {
            console.warn(`[BG] executeJudgmentProcess: fixedLengthStrings is empty for URL ${url}.`);
        }
        
        const processedTargets = targets.map(target => {
            if (!target) return null;
            
            let userProcessedLines = [];
            let userProcessedText = "";

            if (target.lines && target.lines.length > 0) {
                const joined = target.lines.map(line => line.trim()).join('\n');
                const processedJoined = applyRemoveKeywords(joined);
                userProcessedLines = processedJoined.split('\n');
                userProcessedText = userProcessedLines.join('');
            } else {
                const tempLines = (target.text || '').split(/\r\n|\r|\n/);
                const joined = tempLines.map(line => line.trim()).join('\n');
                const processedJoined = applyRemoveKeywords(joined);
                userProcessedLines = processedJoined.split('\n');
                userProcessedText = userProcessedLines.join('');
            }
            
            const userProcessedTextWithBreaks = applyRemoveKeywords(target.textWithBreaks);

            const processedText = applyStandardRemovals(userProcessedText);
            const processedLines = userProcessedLines.map(line => applyStandardRemovals(line));
            const processedTextWithBreaks = applyStandardRemovals(userProcessedTextWithBreaks);

            const normalizedText = normalizeForNgram(processedText);
            const kanjiStats = countKanji(processedText);

            return {
                ...target,
                processed: {
                    text: processedText,
                    lines: processedLines,
                    textWithBreaks: processedTextWithBreaks,
                    normalizedText: normalizedText,
                    kanjiStats: kanjiStats
                }
            };
        }).filter(Boolean);

        if (processedTargets.length === 0) {
            console.log("[BG] No targets to process after initial filtering.");
            return;
        }

        const targetInvertedIndex = buildTargetInvertedIndex(processedTargets);

        let count = 0;
        for (const target of processedTargets) {
            if (!target) continue;
            try {
                let result = await performJudgment(target, url, { 
                    allTargets: processedTargets,
                    targetInvertedIndex: targetInvertedIndex
                });
                
                if (result) {
                    result.id = target.id; result.resno = target.resno; result.rsc = target.rsc;
                    judgmentResults.push({...result});
                }
            } catch (error) {
                console.error("[BG] Error during performJudgment for target:", target, error);
            }

            count++;
            if (count % 50 === 0) {
                await yieldToMainThread();
            }
        }
        
        judgmentResults = finalizeResults(judgmentResults, options);

        if (judgmentResults.length > 0) {
            const fullResultData = { result: judgmentResults, url: url, timestamp: Date.now() };
            results[url] = fullResultData;
            const existingIndex = resultOrder.indexOf(url);
            if (existingIndex > -1) resultOrder.splice(existingIndex, 1);
            resultOrder.push(url);
            
            const CHUNK_SIZE = 100;
            for (let i = 0; i < judgmentResults.length; i += CHUNK_SIZE) {
                const chunk = judgmentResults.slice(i, i + CHUNK_SIZE);
                const isFirstChunk = (i === 0);

                const chunkResultData = {
                    result: chunk,
                    url: url,
                    isFirstChunk: isFirstChunk
                };
                const dataToSend = { type: 'displayResults', results: chunkResultData };

                try {
                    const tabStillExists = await chrome.tabs.get(tabId).catch(() => null);
                    if (tabStillExists) {
                        await chrome.tabs.sendMessage(tabId, dataToSend);
                    } else {
                        console.warn(`[BG] Tab ${tabId} closed during chunk sending. Aborting.`);
                        break;
                    }
                } catch (error) {
                    if (error.message.includes("Receiving end does not exist")) {
                        console.warn(`[BG] Content script on tab ${tabId} not responding during chunk sending. Aborting.`);
                    } else {
                        console.error(`[BG] Error sending chunk to tab ${tabId}:`, error);
                    }
                    processError = error;
                    break;
                }
            }
        } else {
            console.log("[BG] No valid judgment results generated for URL:", url);
            if (results[url]) {
                delete results[url];
                resultOrder = resultOrder.filter(itemUrl => itemUrl !== url);
            }
        }
    } catch (error) {
        // console.error(`[BG] Error during executeJudgmentProcess for URL ${url}:`, error);
        processError = error;
    } finally {
        // 修正: tabId をキーにして削除
        if (judgmentRequests[tabId]) { delete judgmentRequests[tabId]; }
        if (judgmentTimeoutMonitors[tabId]) { clearTimeout(judgmentTimeoutMonitors[tabId]); delete judgmentTimeoutMonitors[tabId]; }
        
        try {
            const tabStillExists = await chrome.tabs.get(tabId).catch(() => null);
            if (tabStillExists) {
                await chrome.tabs.sendMessage(tabId, { type: 'judgmentStatus', status: 'complete' });
            }
        } catch (e) {
            if (!e.message.includes("Receiving end does not exist")) {
                console.warn(`[BG] Could not send 'complete' status to tab ${tabId}`, e);
            }
        }
        
        const summary = {
            totalSuspicious: 0,
            byKeyword: 0,
            byReference: 0,
            byTarget: 0
        };

        for (const result of judgmentResults) {
            if (result.isSuspicious) {
                summary.totalSuspicious++;
                if (result.reason2?.isMatched) {
                    summary.byKeyword++;
                } else if (result.reason?.matches?.[0]) {
                    const topMatch = result.reason.matches[0];
                    if (topMatch.details.comparisonType === 'target') {
                        summary.byTarget++;
                    } else {
                        summary.byReference++;
                    }
                }
            }
        }

        chrome.runtime.sendMessage({
            type: 'judgmentComplete',
            totalCount: judgmentResults.length,
            summary: summary,
            error: processError ? `判定エラー: ${processError.message}` : null
        }).catch(e => { /* ignore */ });
    }
}



// --- メッセージリスナー (キャッシュクリア処理を追加) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
        if (message.type !== 'contentScriptReady' && message.type !== 'keepAlive') {
             await initializeExtension();
             if (!options) throw new Error("Options not available after successful initialization.");
        }

        if (message.type === 'referenceTexts') {
            let addedOrUpdated = false;
            const now = Date.now();

            let urlId;
            const sourceUrl = message.url;
            if (urlMap.has(sourceUrl)) {
                urlId = urlMap.get(sourceUrl);
            } else {
                urlId = urlStore.length;
                urlStore.push(sourceUrl);
                urlMap.set(sourceUrl, urlId);
            }

            for (const item of message.data) {
                if (!item || !item.lines || item.lines.length === 0) continue;
                
                const originalText = item.lines.join('');
                const existingEntry = textToTimestampMap.get(originalText);

                if (existingEntry) {
                    existingEntry.timestamp = now;
                    existingEntry.segment.u = now;
                    // 修正: 重複テキストの所有権を最新のURLに移譲する
                    // これにより、古いURLが定型句によって延命されるのを防ぐ
                    existingEntry.segment.s = urlId;
                } else {
                    const newSegment = generateFixedLengthSegments(item.textWithBreaks, item.lines, urlId);
                    fixedLengthStrings.push(newSegment);
                    textToTimestampMap.set(originalText, { timestamp: newSegment.u, segment: newSegment });
                    addedOrUpdated = true;
                }
            }

            if (addedOrUpdated) {
                isIndexDirty = true;
                // キャッシュクリア: 参照テキストが増えたので過去の判定は無効
                referenceJudgmentCache.clear();
                console.log("[BG] referenceJudgmentCache cleared due to new reference texts.");
                
                saveFixedLengthStringsToStorage()
                    .catch(error => {
                        console.error("[BG] Debounced saveFixedLengthStringsToStorage failed:", error);
                    });
            }
            
            sendResponse({ status: "ok" });

        } else if (message.type === 'targetTexts') {
            const url = message.url; const tabId = sender.tab?.id;
            if (!tabId) { throw new Error("Missing tabId"); }

            if (message.error) {
                 if (judgmentRequests[tabId]) delete judgmentRequests[tabId];
                 if (judgmentTimeoutMonitors[tabId]) { clearTimeout(judgmentTimeoutMonitors[tabId]); delete judgmentTimeoutMonitors[tabId]; }
                 try {
                     await chrome.tabs.sendMessage(tabId, { type: 'judgmentStatus', status: 'complete' });
                 } catch (e) { /* ignore */ }
                 chrome.runtime.sendMessage({ type: 'judgmentComplete', count: 0, error: `ターゲット抽出失敗: ${message.error}` }).catch(e=>{/*ignore*/});
                 sendResponse({ status: "error received from content script" });
                 return;
            }

            if (judgmentRequests[tabId] && judgmentRequests[tabId].pending) {
                if (judgmentRequests[tabId].url !== url) {
                    console.warn(`[BG] URL mismatch for tab ${tabId}. Request: ${judgmentRequests[tabId].url}, Msg: ${url}`);
                }

                if (judgmentTimeoutMonitors[tabId]) { clearTimeout(judgmentTimeoutMonitors[tabId]); delete judgmentTimeoutMonitors[tabId]; }
                
                if (options.enableReferenceExtraction && (!fixedLengthStrings || fixedLengthStrings.length === 0)) {
                    console.warn("[BG] fixedLengthStrings is empty, attempting to reload before judgment.");
                    try {
                        // 修正: 戻り値はオブジェクトなので、分割代入で正しく展開して代入する
                        const { segments, urlStore: loadedUrls } = await loadFixedLengthStringsFromStorage();
                        
                        fixedLengthStrings = segments || [];
                        
                        // 整合性のため urlStore と urlMap も更新しておく
                        if (loadedUrls) {
                            urlStore = loadedUrls;
                            urlMap.clear();
                            urlStore.forEach((u, id) => urlMap.set(u, id));
                        }

                        if (!fixedLengthStrings || fixedLengthStrings.length === 0) {
                            console.warn("[BG] No reference texts found in storage after reload. Proceeding without reference comparison.");
                        }
                        isIndexDirty = true;
                    } catch (error) {
                        console.error("[BG] Error reloading fixedLengthStrings from storage:", error);
                        chrome.runtime.sendMessage({ type: 'judgmentComplete', count: 0, error: '参照テキスト読込エラー' }).catch(e=>{/*ignore*/});
                        delete judgmentRequests[tabId];
                        sendResponse({ status: "error", message: "参照テキストの読み込みエラー。" });
                        return;
                    }
                }
                judgmentRequests[tabId].targets = message.targets;
                judgmentRequests[tabId].pending = false;
                executeJudgmentProcess(url, tabId, message.targets)
                    .catch(err => console.error(`[BG] Unhandled error in executeJudgmentProcess for ${url}:`, err));
                sendResponse({ status: "ok, judgment started" });
            } else {
                 console.warn(`[BG] Received unexpected targetTexts for Tab: ${tabId} (URL: ${url}).`);
                 if (judgmentTimeoutMonitors[tabId]) { clearTimeout(judgmentTimeoutMonitors[tabId]); delete judgmentTimeoutMonitors[tabId]; }
                 if (judgmentRequests[tabId]) { delete judgmentRequests[tabId]; }
                 sendResponse({ status: "ignored, unexpected message" });
            }

        } else if (message.type === 'startJudgment') {
            await handleStartJudgment(message);

        } else if (message.type === 'Options') {
            const oldKeywordsString = JSON.stringify(currentRemoveKeywords);
            
            options = await loadOptionsFromStorage();
            compileAndCacheRegexes(options);
            
            currentRemoveKeywords = options.removeKeywords || [];
            const newKeywordsString = JSON.stringify(currentRemoveKeywords);

            if (oldKeywordsString !== newKeywordsString) {
                console.log("[BG] removeKeywords have been changed. Marking index as dirty.");
                isIndexDirty = true;
                fixedLengthStrings.forEach(seg => { delete seg.p; delete seg.t; });
            }
            
            // キャッシュクリア: オプション変更時は判定基準が変わるため
            referenceJudgmentCache.clear();
            targetPairCache.clear(); // 追加
            console.log("[BG] Caches (reference & target) cleared due to options update.");

            await sendExclusionKeywordsToAllTabs();
            sendResponse({ status: "ok" });

        } else if (message.type === 'contentScriptReady') {
            const tabId = sender.tab.id;
            contentScriptReady[tabId] = true;
            console.log(`[BG] contentScriptReady received from tab: ${tabId}. Flag set.`);
            let responseToSend;
            try {
                await initializeExtension();
                if (!options) throw new Error("Options could not be loaded after initialization for contentScriptReady");
                const exclusionKeywords = {
                    target: options.excludeTargetKeywords || [],
                    reference: options.excludeReferenceKeywords || []
                };
                responseToSend = { type: 'initialExclusionKeywords', keywords: exclusionKeywords };
            } catch (error) {
                console.error(`[BG] Error processing contentScriptReady from tab ${tabId}:`, error);
                responseToSend = { type: 'error', message: `初期化エラー: ${error.message}` };
            }
            sendResponse(responseToSend);

        } else if (message.type === 'clearMemory') {
            fixedLengthStrings = [];
            textToTimestampMap.clear();
            results = {};
            resultOrder = [];
            urlStore = [];
            urlMap.clear();
            isIndexDirty = true;
            // キャッシュクリア
            referenceJudgmentCache.clear();
            targetPairCache.clear(); // 追加
            console.log("[BG] Memory cleared (all data).");

            chrome.storage.local.remove(['segments', 'urlStore'], () => {
                console.log("[BG] Cleared 'segments' and 'urlStore' from chrome.storage.local.");
                sendResponse({ status: "ok" });
            });

        } else if (message.type === 'deleteLatestSegments') {
            const countToDelete = message.count || 500;
            const initialCount = fixedLengthStrings.length;
            if (initialCount === 0) {
                sendResponse({ status: "ok" });
                return;
            }
            console.time('[BG] deleteLatestSegments');

            const actualDeleteCount = Math.min(countToDelete, initialCount);

            const heap = new MinHeap(actualDeleteCount, (seg) => {
                return seg.u * initialCount + seg._tempIdx;
            });

            fixedLengthStrings.forEach((seg, idx) => {
                seg._tempIdx = idx;
                heap.push(seg);
            });

            const segmentsToDelete = heap.getSorted();
            const indicesToDelete = new Set();
            const textsToDelete = new Set();
            for (const segment of segmentsToDelete) {
                indicesToDelete.add(segment._tempIdx);
                if (segment.l) {
                    textsToDelete.add(segment.l.join(''));
                }
            }

            const newFixedLengthStrings = fixedLengthStrings.filter((seg, idx) => {
                return !indicesToDelete.has(idx);
            });

            fixedLengthStrings = newFixedLengthStrings;
            for (const text of textsToDelete) {
                textToTimestampMap.delete(text);
            }
            
            segmentsToDelete.forEach(seg => { delete seg._tempIdx; });
            
            console.log(`[BG] Deleted latest ${segmentsToDelete.length} segments. Remaining: ${fixedLengthStrings.length}.`);
            console.timeEnd('[BG] deleteLatestSegments');
            isIndexDirty = true;
            // キャッシュクリア: 参照テキストが減ったので
            referenceJudgmentCache.clear();
            
            saveFixedLengthStringsToStorage();
            sendResponse({ status: "ok" });

        } else if (message.type === 'keepAlive') {
            return;
        } else {
            console.log("[BG] Received unknown message type:", message.type);
            sendResponse({});
        }
    } catch (error) {
        console.error(`[BG] Error handling message ${message.type}:`, error);
        try {
            sendResponse({ status: "error", message: `Background error: ${error.message}` });
        } catch (e) {
            console.error("[BG] Failed to send error response:", e);
        }
    }
  })();

  if (['targetTexts', 'Options', 'contentScriptReady', 'clearMemory'].includes(message.type)) {
      return true;
  }
  return false;
});

// handleStartJudgment
async function handleStartJudgment(message) {
  const url = message.url; const tabId = message.tabId;
  console.log("[BG] handleStartJudgment received. URL:", url, "TabID:", tabId);

  // 同一タブでURLが変わった場合のキャッシュクリア処理
  if (activeTabUrls.has(tabId)) {
      const oldUrl = activeTabUrls.get(tabId);
      if (oldUrl !== url) {
          console.log(`[BG] Tab ${tabId} navigated from ${oldUrl} to ${url}. Clearing cache for old URL.`);
          
          if (targetPairCache.has(oldUrl)) {
              targetPairCache.delete(oldUrl);
              console.log(`[BG] targetPairCache deleted for old URL: ${oldUrl}`);
          }
          
          if (judgmentRequests[oldUrl]) {
              delete judgmentRequests[oldUrl];
          }
          
          if (judgmentTimeoutMonitors[oldUrl]) {
              clearTimeout(judgmentTimeoutMonitors[oldUrl]);
              delete judgmentTimeoutMonitors[oldUrl];
          }

          // 古い結果も削除
          if (results[oldUrl]) {
              delete results[oldUrl];
              resultOrder = resultOrder.filter(itemUrl => itemUrl !== oldUrl);
          }
      }
  }

  activeTabUrls.set(tabId, url);

  if (judgmentRequests[tabId]) {
      console.warn(`[BG] Overwriting previous judgment request for Tab: ${tabId}`);
      if (judgmentTimeoutMonitors[tabId]) {
          clearTimeout(judgmentTimeoutMonitors[tabId]);
          delete judgmentTimeoutMonitors[tabId];
      }
  }

  if (results[url]) {
      delete results[url];
      resultOrder = resultOrder.filter(itemUrl => itemUrl !== url);
  }
  
  // 修正: ここでキャッシュを削除していたため、再判定時にキャッシュが効いていなかった。
  // 掲示板の過去ログ（レス番号と内容）は不変であるため、キャッシュを維持するべき。
  // オプション変更時やメモリクリア時には別途クリアされるため、ここは削除して良い。
  /* 
  if (targetPairCache.has(url)) {
      targetPairCache.delete(url);
  }
  */

  judgmentRequests[tabId] = { url: url, pending: true, startTime: Date.now() };

  try {
    const tabExists = await chrome.tabs.get(tabId).catch(() => null);
    if (!tabExists) { throw new Error(`Tab ${tabId} not found.`); }

    await chrome.tabs.sendMessage(tabId, { type: 'judgmentStatus', status: 'processing' });
    await chrome.tabs.sendMessage(tabId, { type: "callExtractTargetTexts" });

    const timeoutMonitorId = setTimeout(() => {
        // 修正: tabId でチェック
        if (judgmentRequests[tabId] && judgmentRequests[tabId].pending) {
            console.error(`[BG] Timeout waiting for targetTexts from Tab: ${tabId} (URL: ${url})`);
            chrome.runtime.sendMessage({ type: 'judgmentComplete', count: 0, error: `タイムアウト: ターゲット抽出` }).catch(e=>{/*ignore*/});
            delete judgmentRequests[tabId];
            delete judgmentTimeoutMonitors[tabId];
        }
    }, JUDGMENT_REQUEST_TIMEOUT);
    
    // 修正: tabId で保存
    judgmentTimeoutMonitors[tabId] = timeoutMonitorId;

  } catch (error) {
    console.error(`[BG] Error in handleStartJudgment (request phase) for URL ${url}:`, error);
    try {
        const tabStillExists = await chrome.tabs.get(tabId).catch(() => null);
        if (tabStillExists) {
            await chrome.tabs.sendMessage(tabId, { type: 'judgmentStatus', status: 'complete' });
        }
    } catch (e) { /* ignore */ }
    chrome.runtime.sendMessage({ type: 'judgmentComplete', count: 0, error: error.message || 'ターゲット抽出要求失敗' }).catch(e=>{/*ignore*/});
    
    // 修正: tabId で削除
    if (judgmentRequests[tabId]) { delete judgmentRequests[tabId]; }
    if (judgmentTimeoutMonitors[tabId]) { clearTimeout(judgmentTimeoutMonitors[tabId]); delete judgmentTimeoutMonitors[tabId]; }
  }
}


/**
 * 提案2追加: オプションから正規表現オブジェクトをコンパイルし、キャッシュするヘルパー関数。
 * フラグを 'gm' (global + multiline) に変更し、行単位のマッチングを可能にする。
 */
function compileAndCacheRegexes(options) {
    console.log("[BG] Compiling and caching regular expressions...");
    cachedRemoveKeywordRegexes = (options.removeKeywords || []).map(pattern => {
        if (!pattern || typeof pattern !== 'string') return null;
        try {
            // ▼▼▼ 変更箇所: 'g' -> 'gm' ▼▼▼
            return new RegExp(pattern, 'gm');
        } catch (e) {
            console.error(`[BG] Invalid remove keyword regex, skipping: "${pattern}"`, e);
            return null;
        }
    }).filter(Boolean);

    cachedRegexKeywordRegexes = (options.regexKeywords || []).map(pattern => {
        if (!pattern || typeof pattern !== 'string') return null;
        try {
            // キーワード検索用も念のため 'm' をつけるが、こちらは通常 'i' 等が好まれる場合もある。
            // ここでは一貫性のためデフォルトの挙動 + m とする
            return new RegExp(pattern, 'm');
        } catch (e) {
            console.error(`[BG] Invalid regex keyword, skipping: "${pattern}"`, e);
            return null;
        }
    }).filter(Boolean);
    console.log(`[BG] Cached ${cachedRemoveKeywordRegexes.length} remove keyword regexes and ${cachedRegexKeywordRegexes.length} regex keywords.`);
}


//設定読み込み
const DEFAULT_SUSPICION_THRESHOLD = 80;
const DEFAULT_ENABLE_REFERENCE_EXTRACTION = true;
const DEFAULT_TRIGRAM_CHAIN_COUNT = 10;
const DEFAULT_EDIT_DISTANCE = 2; const DEFAULT_ENABLE_LINE_BASED_EDIT_DISTANCE = true; const DEFAULT_ENABLE_FULL_EDIT_DISTANCE = true;
const DEFAULT_TRIGRAM_ENABLED = true;
const DEFAULT_ENABLE_KEYWORD_SEARCH = false; const DEFAULT_AND_KEYWORDS = []; const DEFAULT_OR_KEYWORDS = []; const DEFAULT_REGEX_KEYWORDS = [];
const DEFAULT_EXCLUDE_TARGET_KEYWORDS = []; const DEFAULT_EXCLUDE_REFERENCE_KEYWORDS = [];
const DEFAULT_REMOVE_KEYWORDS = [];
const DEFAULT_ENABLE_TARGET_COMPARISON = true;
const DEFAULT_TARGET_TRIGRAM_CHAIN_COUNT = 10;
const DEFAULT_TARGET_EDIT_DISTANCE = 2; const DEFAULT_ENABLE_TARGET_LINE_COMPARISON = true; const DEFAULT_ENABLE_TARGET_FULL_EDIT_DISTANCE = true;
const DEFAULT_TARGET_TRIGRAM_ENABLED = true;
const DEFAULT_ENABLE_REFERENCE_COMPARISON = true;
const DEFAULT_ENABLE_KANJI_FILTERING = true;
const DEFAULT_MIN_COMMON_KANJI = 2;
const DEFAULT_KANJI_SCORE_WEIGHT = 'medium';
const DEFAULT_ENABLE_TARGET_KANJI_FILTERING = true;
const DEFAULT_TARGET_MIN_COMMON_KANJI = 2;
const DEFAULT_TARGET_KANJI_SCORE_WEIGHT = 'medium';
const DEFAULT_ENABLE_JACCARD_HYBRID = false;
const DEFAULT_ENABLE_TARGET_JACCARD_HYBRID = false;


async function loadOptionsFromStorage() {
    try {
        const data = await chrome.storage.local.get({
          suspicionThreshold: DEFAULT_SUSPICION_THRESHOLD,
          enableReferenceExtraction: DEFAULT_ENABLE_REFERENCE_EXTRACTION,
          enableReferenceComparison: DEFAULT_ENABLE_REFERENCE_COMPARISON,
          trigramChainCount: DEFAULT_TRIGRAM_CHAIN_COUNT,
          editDistance: DEFAULT_EDIT_DISTANCE, enableLineBasedEditDistance: DEFAULT_ENABLE_LINE_BASED_EDIT_DISTANCE, enableFullEditDistance: DEFAULT_ENABLE_FULL_EDIT_DISTANCE,
          trigramEnabled: DEFAULT_TRIGRAM_ENABLED,
          enableJaccardHybrid: DEFAULT_ENABLE_JACCARD_HYBRID,
          enableKeywordSearch: DEFAULT_ENABLE_KEYWORD_SEARCH, andKeywords: DEFAULT_AND_KEYWORDS, orKeywords: DEFAULT_OR_KEYWORDS, regexKeywords: DEFAULT_REGEX_KEYWORDS,
          excludeTargetKeywords: DEFAULT_EXCLUDE_TARGET_KEYWORDS, excludeReferenceKeywords: DEFAULT_EXCLUDE_REFERENCE_KEYWORDS,
          removeKeywords: DEFAULT_REMOVE_KEYWORDS,
          enableTargetComparison: DEFAULT_ENABLE_TARGET_COMPARISON,
          targetTrigramChainCount: DEFAULT_TARGET_TRIGRAM_CHAIN_COUNT,
          targetEditDistance: DEFAULT_TARGET_EDIT_DISTANCE, enableTargetLineComparison: DEFAULT_ENABLE_TARGET_LINE_COMPARISON, enableTargetFullEditDistance: DEFAULT_ENABLE_TARGET_FULL_EDIT_DISTANCE,
          targetTrigramEnabled: DEFAULT_TARGET_TRIGRAM_ENABLED,
          enableTargetJaccardHybrid: DEFAULT_ENABLE_TARGET_JACCARD_HYBRID,
          enableKanjiFiltering: DEFAULT_ENABLE_KANJI_FILTERING,
          minCommonKanji: DEFAULT_MIN_COMMON_KANJI,
          kanjiScoreWeight: DEFAULT_KANJI_SCORE_WEIGHT,
          enableTargetKanjiFiltering: DEFAULT_ENABLE_TARGET_KANJI_FILTERING,
          targetMinCommonKanji: DEFAULT_TARGET_MIN_COMMON_KANJI,
          targetKanjiScoreWeight: DEFAULT_TARGET_KANJI_SCORE_WEIGHT
        });
        return data;
    } catch (error) {
        console.error('[BG] Error loading options:', error);
        return getDefaultOptions();
    }
}

// --- Service Worker ライフサイクルイベント ---
chrome.runtime.onStartup.addListener(async () => {
  console.log("[BG] Extension startup.");
  try { await initializeExtension(); } catch (error) { console.error("[BG] Initialization failed on startup:", error); }
  contentScriptReady = {}; judgmentTimeoutMonitors = {}; judgmentRequests = {};
  console.log("[BG] Startup handler finished.");
});

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[BG] Extension ${details.reason}.`);
  try { await initializeExtension(); } catch (error) { console.error(`[BG] Initialization failed on ${details.reason}:`, error); }
  contentScriptReady = {}; judgmentTimeoutMonitors = {}; judgmentRequests = {};
  console.log("[BG] Installation/Update handler finished.");
});

// --- webNavigation.onCompleted ---
chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    const targetUrls = [ "https://tsumanne.net/", "https://c3.ftbucket.info/", "https://may3.ftbucket.info/", "https://may2.ftbucket.info/", "https://futafuta.site/", "https://kako.futakuro.com/", "https://img.2chan.net/", "https://may.2chan.net/" ];
    const isTargetUrl = targetUrls.some(url => details.url.startsWith(url));
    if (!isTargetUrl) return;

    console.log(`[BG] webNavigation.onCompleted triggered for: ${details.url} (Tab ID: ${details.tabId})`);

    try {
        await initializeExtension();
        const currentOptions = options;
        if (!currentOptions) { throw new Error("Options not available after successful initialization in onCompleted."); }

        try {
            await new Promise(resolve => setTimeout(resolve, 250));
            const tabExists = await chrome.tabs.get(details.tabId).catch(() => null);
            if (tabExists) {
                delete contentScriptReady[details.tabId];
                await chrome.tabs.sendMessage(details.tabId, { type: 'contentReady' });
            }
        } catch (error) {
             if (!error.message.includes("Receiving end does not exist")) { console.error(`[BG] Error sending contentReady to tab ${details.tabId}:`, error); }
        }

        if (!details.url.startsWith("https://img.2chan.net/") && !details.url.startsWith("https://may.2chan.net/")) {
            if (currentOptions.enableReferenceExtraction) {
                try {
                  const tabExists = await chrome.tabs.get(details.tabId).catch(() => null);
                  if (tabExists) {
                      await chrome.scripting.executeScript({
                        target: { tabId: details.tabId },
                        func: () => { if (typeof extractReferenceTexts === 'function') { extractReferenceTexts(); } else { console.error('extractReferenceTexts function not found.'); } }
                      });
                  }
                } catch (error) {
                  if (!error.message.includes("No script specified") && !error.message.includes("Cannot access contents of url") && !error.message.includes("Missing host permission for the tab") && !error.message.includes("The extensions gallery cannot be scripted")) {
                     console.warn("[BG] Warning injecting script for reference text:", error.message);
                  }
                }
            }
        }
    } catch (error) {
        console.error(`[BG] Error in webNavigation.onCompleted handler for ${details.url}:`, error);
    }
});

async function sendExclusionKeywordsToAllTabs() {
    const currentOptions = options || await loadOptionsFromStorage().catch(err => getDefaultOptions());
    if (!currentOptions) { console.error("[BG] Cannot send exclusion keywords: Options not loaded."); return; }
    const exclusionKeywords = { target: currentOptions.excludeTargetKeywords || [], reference: currentOptions.excludeReferenceKeywords || [] };
    const targetUrlPatterns = [ "https://tsumanne.net/", "https://c3.ftbucket.info/", "https://may3.ftbucket.info/", "https://may2.ftbucket.info/", "https://futafuta.site/", "https://kako.futakuro.com/", "https://img.2chan.net/", "https://may.2chan.net/" ];
    try {
        const tabs = await chrome.tabs.query({ url: targetUrlPatterns });
        tabs.forEach(tab => { if (tab.id) { sendExclusionKeywordsToTab(tab.id, exclusionKeywords); } });
    } catch (error) { console.error("[BG] Error querying tabs for sending exclusion keywords:", error); }
}

async function sendExclusionKeywordsToTab(tabId, exclusionKeywords) {
    if (!exclusionKeywords) {
        const currentOptions = options || await loadOptionsFromStorage().catch(err => getDefaultOptions());
        if (!currentOptions) { console.error(`[BG] Cannot send exclusion keywords to tab ${tabId}: Options not loaded.`); return; }
        exclusionKeywords = { target: currentOptions.excludeTargetKeywords || [], reference: currentOptions.excludeReferenceKeywords || [] };
    }
    if (contentScriptReady[tabId]) {
        try {
            const tabExists = await chrome.tabs.get(tabId).catch(() => null);
            if (tabExists) {
                await chrome.tabs.sendMessage(tabId, { type: 'exclusionKeywords', keywords: exclusionKeywords });
            } else { delete contentScriptReady[tabId]; }
        } catch (error) {
            if (error.message.includes("No tab with id") || error.message.includes("Receiving end does not exist")) { delete contentScriptReady[tabId]; }
            else { console.error("[BG] Error sending exclusionKeywords to tab:", tabId, error); }
        }
    }
}