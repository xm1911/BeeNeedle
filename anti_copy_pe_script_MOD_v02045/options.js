/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */

// UI要素 (数値入力)
const suspicionThresholdInput = document.getElementById('suspicionThreshold');
const trigramChainCountInput = document.getElementById('trigramChainCount');
const editDistanceInput = document.getElementById('editDistance');

// UI要素 (チェックボックス)
const trigramEnabledCheckbox = document.getElementById('trigramEnabled');
const enableLineBasedEditDistanceCheckbox = document.getElementById('enableLineBasedEditDistance');
const enableReferenceExtractionCheckbox = document.getElementById('enableReferenceExtraction');

const enableReferenceComparisonCheckbox = document.getElementById('enableReferenceComparison');

const enableFullEditDistanceCheckbox = document.getElementById('enableFullEditDistance');
const enableTargetFullEditDistanceCheckbox = document.getElementById('enableTargetFullEditDistance');
// [追加] Jaccard Hybrid (参照)
const enableJaccardHybridCheckbox = document.getElementById('enableJaccardHybrid');

// 
// UI要素 (漢字フィルタリング)
const enableKanjiFilteringCheckbox = document.getElementById('enableKanjiFiltering');
const minCommonKanjiInput = document.getElementById('minCommonKanji');
const kanjiScoreWeightSelect = document.getElementById('kanjiScoreWeight');
// 
// 
// UI要素 (漢字フィルタリング - ターゲット間)
const enableTargetKanjiFilteringCheckbox = document.getElementById('enableTargetKanjiFiltering');
const targetMinCommonKanjiInput = document.getElementById('targetMinCommonKanji');
const targetKanjiScoreWeightSelect = document.getElementById('targetKanjiScoreWeight');
// 

// UI要素 (キーワード検索)
const enableKeywordSearchCheckbox = document.getElementById('enableKeywordSearch');
const andKeywordsTextarea = document.getElementById('andKeywords');
const orKeywordsTextarea = document.getElementById('orKeywords');
const regexKeywordsTextarea = document.getElementById('regexKeywords');

// UI要素 (ターゲット間比較)
const enableTargetComparisonCheckbox = document.getElementById('enableTargetComparison');
const targetTrigramChainCountInput = document.getElementById('targetTrigramChainCount');

const targetEditDistanceInput = document.getElementById('targetEditDistance');
const targetTrigramEnabledCheckbox = document.getElementById('targetTrigramEnabled');
const enableTargetLineComparisonCheckbox = document.getElementById('enableTargetLineComparison');
// [追加] Jaccard Hybrid (ターゲット間)
const enableTargetJaccardHybridCheckbox = document.getElementById('enableTargetJaccardHybrid');

// UI要素 (除外ワード)
const excludeTargetKeywordsTextarea = document.getElementById('excludeTargetKeywords');
const excludeReferenceKeywordsTextarea = document.getElementById('excludeReferenceKeywords');

// UI要素 (除去キーワード)
const removeKeywordsTextarea = document.getElementById('removeKeywords');

const saveButton = document.getElementById('saveButton');
const statusMessage = document.getElementById('statusMessage');
const clearMemoryButton = document.getElementById('clearMemoryButton');

const deleteLatestButton = document.getElementById('deleteLatestButton');
const clearMemoryMessage = document.getElementById('clearMemoryMessage');

// 設定値の初期値 (数値) - background.js と合わせる
const DEFAULT_SUSPICION_THRESHOLD = 80;
const DEFAULT_TRIGRAM_CHAIN_COUNT = 10;

const DEFAULT_EDIT_DISTANCE = 2;

// 設定値の初期値 (真偽値) - background.js と合わせる
const DEFAULT_TRIGRAM_ENABLED = true;
const DEFAULT_ENABLE_LINE_BASED_EDIT_DISTANCE = true;
const DEFAULT_ENABLE_FULL_EDIT_DISTANCE = true;
const DEFAULT_ENABLE_TARGET_FULL_EDIT_DISTANCE = true;
// [追加] Jaccard Hybrid
const DEFAULT_ENABLE_JACCARD_HYBRID = false;
const DEFAULT_ENABLE_TARGET_JACCARD_HYBRID = false;

// 
// 設定値の初期値 (漢字フィルタリング)
const DEFAULT_ENABLE_KANJI_FILTERING = true;
const DEFAULT_MIN_COMMON_KANJI = 2;
const DEFAULT_KANJI_SCORE_WEIGHT = 'medium'; // 'none', 'low', 'medium', 'high'
// 
// 
// 設定値の初期値 (漢字フィルタリング - ターゲット間)
const DEFAULT_ENABLE_TARGET_KANJI_FILTERING = true;
const DEFAULT_TARGET_MIN_COMMON_KANJI = 2;
const DEFAULT_TARGET_KANJI_SCORE_WEIGHT = 'medium';
// 

// 設定値の初期値 (キーワード検索) - background.js と合わせる
const DEFAULT_ENABLE_KEYWORD_SEARCH = false;
const DEFAULT_AND_KEYWORDS = [];
const DEFAULT_OR_KEYWORDS = [];
const DEFAULT_REGEX_KEYWORDS = [];

// 設定値の初期値 (除外ワード) - background.js と合わせる
const DEFAULT_EXCLUDE_TARGET_KEYWORDS = [];
const DEFAULT_EXCLUDE_REFERENCE_KEYWORDS = [];

// 設定値の初期値 (除去キーワード) - background.js と合わせる
const DEFAULT_REMOVE_KEYWORDS = [];

// 設定値の初期値 (ターゲット間比較) - background.js と合わせる
const DEFAULT_ENABLE_TARGET_COMPARISON = true;

const DEFAULT_TARGET_TRIGRAM_CHAIN_COUNT = 10;

const DEFAULT_TARGET_EDIT_DISTANCE = 2;
const DEFAULT_TARGET_TRIGRAM_ENABLED = true;
const DEFAULT_ENABLE_TARGET_LINE_COMPARISON = true;
const DEFAULT_ENABLE_REFERENCE_EXTRACTION = true;

const DEFAULT_ENABLE_REFERENCE_COMPARISON = true;


// 設定を保存
async function saveOptions() {
  // (1) 基本設定
  const enableReferenceExtraction = enableReferenceExtractionCheckbox.checked;
  const suspicionThreshold = parseInt(suspicionThresholdInput.value, 10);
  
  // 参照テキスト比較 (数値)

  const trigramChainCount = parseInt(trigramChainCountInput.value, 10);

  const editDistance = parseInt(editDistanceInput.value, 10);

  // バリデーション (参照)
  if (isNaN(suspicionThreshold) || suspicionThreshold < 0 || suspicionThreshold > 200) { // バリデーションを追加
    statusMessage.textContent = '判定スコアしきい値エラー'; return;
  }
  if (isNaN(trigramChainCount) || trigramChainCount <= 0) { statusMessage.textContent = 'Trigram連続一致数エラー'; return; }

  if (isNaN(editDistance) || editDistance < 0) { statusMessage.textContent = '編集距離エラー'; return; }

  // 参照テキスト比較 (チェックボックス)

  const enableReferenceComparison = enableReferenceComparisonCheckbox.checked;

  const trigramEnabled = trigramEnabledCheckbox.checked;
  const enableLineBasedEditDistance = enableLineBasedEditDistanceCheckbox.checked;
  const enableFullEditDistance = enableFullEditDistanceCheckbox.checked;
  // [追加] Jaccard Hybrid (参照)
  const enableJaccardHybrid = enableJaccardHybridCheckbox.checked;

  // 
  // 漢字フィルタリング
  const enableKanjiFiltering = enableKanjiFilteringCheckbox.checked;
  const minCommonKanji = parseInt(minCommonKanjiInput.value, 10);
  const kanjiScoreWeight = kanjiScoreWeightSelect.value;

  // バリデーション (漢字)
  if (isNaN(minCommonKanji) || minCommonKanji < 0) { statusMessage.textContent = '最低共通漢字数エラー'; return; }
  // 
  
  // 
  // 漢字フィルタリング (ターゲット間)
  const enableTargetKanjiFiltering = enableTargetKanjiFilteringCheckbox.checked;
  const targetMinCommonKanji = parseInt(targetMinCommonKanjiInput.value, 10);
  const targetKanjiScoreWeight = targetKanjiScoreWeightSelect.value;

  // バリデーション (漢字 - ターゲット間)
  if (isNaN(targetMinCommonKanji) || targetMinCommonKanji < 0) { statusMessage.textContent = 'ターゲット間 最低共通漢字数エラー'; return; }
  // 

  // キーワード検索
  const enableKeywordSearch = enableKeywordSearchCheckbox.checked;
  const andKeywords = andKeywordsTextarea.value.trim().split('\n').filter(line => line.trim() !== '');
  const orKeywords = orKeywordsTextarea.value.trim().split('\n').filter(line => line.trim() !== '');
  const regexKeywords = regexKeywordsTextarea.value.trim().split('\n').filter(line => line.trim() !== '');

  // 除外ワード
  const excludeTargetKeywords = excludeTargetKeywordsTextarea.value.trim().split('\n').filter(line => line.trim() !== '');
  const excludeReferenceKeywords = excludeReferenceKeywordsTextarea.value.trim().split('\n').filter(line => line.trim() !== '');
  
  // 除去キーワード
  const removeKeywords = removeKeywordsTextarea.value.trim().split('\n').filter(line => line.trim() !== '');

  // ターゲット間比較 (数値)
  const enableTargetComparison = enableTargetComparisonCheckbox.checked;
  // 
  const targetTrigramChainCount = parseInt(targetTrigramChainCountInput.value, 10);
  // 
  const targetEditDistance = parseInt(targetEditDistanceInput.value, 10);

  // バリデーション (ターゲット間)


  if (isNaN(targetTrigramChainCount) || targetTrigramChainCount <= 0) { statusMessage.textContent = 'ターゲット間Trigram連続一致数エラー'; return; }

  if (isNaN(targetEditDistance) || targetEditDistance < 0) { statusMessage.textContent = 'ターゲット間編集距離エラー'; return; }

  // ターゲット間比較 (チェックボックス)
  const targetTrigramEnabled = targetTrigramEnabledCheckbox.checked;
  const enableTargetLineComparison = enableTargetLineComparisonCheckbox.checked;
  const enableTargetFullEditDistance = enableTargetFullEditDistanceCheckbox.checked;
  // [追加] Jaccard Hybrid (ターゲット間)
  const enableTargetJaccardHybrid = enableTargetJaccardHybridCheckbox.checked;

  try {
    await chrome.storage.local.set({
      // (1) 基本設定
      enableReferenceExtraction,
      suspicionThreshold,

      enableReferenceComparison,

      // 参照比較
      editDistance,
      trigramChainCount,
      trigramEnabled,
      enableLineBasedEditDistance,
	  enableFullEditDistance,
      enableJaccardHybrid, // [追加]
      // 
      // 漢字フィルタリング
      enableKanjiFiltering, minCommonKanji, kanjiScoreWeight,
      // 
      // 
      // 漢字フィルタリング (ターゲット間)
      enableTargetKanjiFiltering, targetMinCommonKanji, targetKanjiScoreWeight,
      // 

      // キーワード検索
      enableKeywordSearch, andKeywords, orKeywords, regexKeywords,
      // 除外ワード
      excludeTargetKeywords, excludeReferenceKeywords,

      // 除去キーワード
      removeKeywords,

      // ターゲット間比較
      enableTargetComparison,
      targetEditDistance,
	  targetTrigramChainCount,
      targetTrigramEnabled,
      enableTargetLineComparison, enableTargetFullEditDistance,
      enableTargetJaccardHybrid // [追加]
    });
    statusMessage.textContent = '設定を保存しました';
    statusMessage.style.color = 'green'; // 保存成功を視覚的に強調
    
    // 3秒後にメッセージを消去
    setTimeout(() => {
        statusMessage.textContent = '';
        statusMessage.style.color = ''; // 色をリセット
    }, 3000);
    
    chrome.runtime.sendMessage({type: "Options"});
    
    
  } catch (error) {
    statusMessage.textContent = '設定の保存に失敗しました';
    statusMessage.style.color = 'red'; // 保存失敗を視覚的に強調
    console.error('Error saving options:', error);
    
    // 失敗メッセージも3秒後に消す（任意だが、ユーザー体験向上のため追加）
    setTimeout(() => {
        statusMessage.textContent = '';
        statusMessage.style.color = '';
    }, 3000);
  }
}

// 設定を読み込む
async function loadOptions() {
    try {
        const data = await chrome.storage.local.get({
            // (1) 基本設定
            enableReferenceExtraction: DEFAULT_ENABLE_REFERENCE_EXTRACTION,

            enableReferenceComparison: DEFAULT_ENABLE_REFERENCE_COMPARISON,
            suspicionThreshold: DEFAULT_SUSPICION_THRESHOLD, // 読み込む値に追加
            // デフォルト値を指定
            trigramChainCount: DEFAULT_TRIGRAM_CHAIN_COUNT,

            // 
            // 漢字フィルタリング
            enableKanjiFiltering: DEFAULT_ENABLE_KANJI_FILTERING,
            minCommonKanji: DEFAULT_MIN_COMMON_KANJI,
            kanjiScoreWeight: DEFAULT_KANJI_SCORE_WEIGHT,
            // 
            // 
            // 漢字フィルタリング (ターゲット間)
            enableTargetKanjiFiltering: DEFAULT_ENABLE_TARGET_KANJI_FILTERING,
            targetMinCommonKanji: DEFAULT_TARGET_MIN_COMMON_KANJI,
            targetKanjiScoreWeight: DEFAULT_TARGET_KANJI_SCORE_WEIGHT,
            // 
            editDistance: DEFAULT_EDIT_DISTANCE,
            trigramEnabled: DEFAULT_TRIGRAM_ENABLED,
            enableLineBasedEditDistance: DEFAULT_ENABLE_LINE_BASED_EDIT_DISTANCE,
			enableFullEditDistance: DEFAULT_ENABLE_FULL_EDIT_DISTANCE,
            enableJaccardHybrid: DEFAULT_ENABLE_JACCARD_HYBRID, // [追加]
            enableKeywordSearch: DEFAULT_ENABLE_KEYWORD_SEARCH,
            andKeywords: DEFAULT_AND_KEYWORDS,
            orKeywords: DEFAULT_OR_KEYWORDS,
            regexKeywords: DEFAULT_REGEX_KEYWORDS,
            excludeTargetKeywords: DEFAULT_EXCLUDE_TARGET_KEYWORDS,
            excludeReferenceKeywords: DEFAULT_EXCLUDE_REFERENCE_KEYWORDS,
			removeKeywords: DEFAULT_REMOVE_KEYWORDS,
            enableTargetComparison: DEFAULT_ENABLE_TARGET_COMPARISON,

            targetTrigramChainCount: DEFAULT_TARGET_TRIGRAM_CHAIN_COUNT,

            targetEditDistance: DEFAULT_TARGET_EDIT_DISTANCE,
            targetTrigramEnabled: DEFAULT_TARGET_TRIGRAM_ENABLED,
            enableTargetLineComparison: DEFAULT_ENABLE_TARGET_LINE_COMPARISON,
			enableTargetFullEditDistance: DEFAULT_ENABLE_TARGET_FULL_EDIT_DISTANCE,
            enableTargetJaccardHybrid: DEFAULT_ENABLE_TARGET_JACCARD_HYBRID // [追加]
        });

        // UIに値を設定
        // (1) 基本設定
        enableReferenceExtractionCheckbox.checked = data.enableReferenceExtraction;

        enableReferenceComparisonCheckbox.checked = data.enableReferenceComparison;
        suspicionThresholdInput.value = data.suspicionThreshold; // UIに値を設定

        trigramChainCountInput.value = data.trigramChainCount;

        // 
        // 漢字フィルタリング
        enableKanjiFilteringCheckbox.checked = data.enableKanjiFiltering;
        minCommonKanjiInput.value = data.minCommonKanji;
        kanjiScoreWeightSelect.value = data.kanjiScoreWeight;
        // 
        // 
        // 漢字フィルタリング (ターゲット間)
        enableTargetKanjiFilteringCheckbox.checked = data.enableTargetKanjiFiltering;
        targetMinCommonKanjiInput.value = data.targetMinCommonKanji;
        targetKanjiScoreWeightSelect.value = data.targetKanjiScoreWeight;
        // 
        editDistanceInput.value = data.editDistance;
        trigramEnabledCheckbox.checked = data.trigramEnabled;
        enableLineBasedEditDistanceCheckbox.checked = data.enableLineBasedEditDistance;
		enableFullEditDistanceCheckbox.checked = data.enableFullEditDistance;
        enableJaccardHybridCheckbox.checked = data.enableJaccardHybrid; // [追加]

        enableKeywordSearchCheckbox.checked = data.enableKeywordSearch;
        andKeywordsTextarea.value = data.andKeywords.join('\n');
        orKeywordsTextarea.value = data.orKeywords.join('\n');
        regexKeywordsTextarea.value = data.regexKeywords.join('\n');

        excludeTargetKeywordsTextarea.value = data.excludeTargetKeywords.join('\n');
        excludeReferenceKeywordsTextarea.value = data.excludeReferenceKeywords.join('\n');
		
		removeKeywordsTextarea.value = data.removeKeywords.join('\n');

        enableTargetComparisonCheckbox.checked = data.enableTargetComparison;

        targetTrigramChainCountInput.value = data.targetTrigramChainCount;

        targetEditDistanceInput.value = data.targetEditDistance;
        targetTrigramEnabledCheckbox.checked = data.targetTrigramEnabled;
        enableTargetLineComparisonCheckbox.checked = data.enableTargetLineComparison;
		enableTargetFullEditDistanceCheckbox.checked = data.enableTargetFullEditDistance;
        enableTargetJaccardHybridCheckbox.checked = data.enableTargetJaccardHybrid; // [追加]

    } catch (error) {
        console.error('Error loading options:', error);
        statusMessage.textContent = '設定の読み込みに失敗しました';
    }
}


// 保存ボタンのクリックイベント
saveButton.addEventListener('click', saveOptions);


deleteLatestButton.addEventListener('click', () => { // async を削除
    if (!confirm('最新500件の参照テキストを削除しますか？この操作は取り消せません。')) {
        return;
    }
    
    try {
        // 応答を待たずにメッセージを送信 (Fire-and-Forget)
        chrome.runtime.sendMessage({ type: 'deleteLatestSegments', count: 500 });
        
        // 即座にUIにフィードバックを表示
        clearMemoryMessage.textContent = '最新500件の削除をリクエストしました。';
        clearMemoryMessage.style.color = 'green';
        clearMemoryMessage.style.color = ''; // 色をリセット

    } catch (error) {
        // sendMessageが同期的に失敗した場合のエラーハンドリング
        clearMemoryMessage.textContent = `エラー: ${error.message}`;
        clearMemoryMessage.style.color = 'red';
        console.error('Error sending delete request:', error);
    } finally {
        // メッセージを3秒後に消す
        setTimeout(() => { clearMemoryMessage.textContent = ''; }, 3000);
    }
});

// メモリクリアボタンのクリックイベント
clearMemoryButton.addEventListener('click', async () => {
  // 確認ダイアログを追加
  if (!confirm('すべての参照テキストを削除しますか？この操作は取り消せません。')) {
    return; // ユーザーがキャンセルした場合は処理を中断
  }

  clearMemoryMessage.textContent = 'クリア中...';
  clearMemoryMessage.style.color = ''; // メッセージの色をリセット
  try {
    const response = await chrome.runtime.sendMessage({ type: 'clearMemory' });
    if (response && response.status === "ok") {
        clearMemoryMessage.textContent = 'クリアしました！';
        clearMemoryMessage.style.color = 'green';
    } else {
        throw new Error("Invalid response from background script");
    }
  } catch (error) {
    clearMemoryMessage.textContent = 'エラーが発生しました';
    clearMemoryMessage.style.color = 'red';
    console.error('Error clearing memory:', error);
  } finally {
      setTimeout(() => {
          clearMemoryMessage.textContent = '';
      }, 3000);
  }
});




// ページ読み込み時に設定を読み込む
document.addEventListener('DOMContentLoaded', loadOptions);