/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */

// content.js 上部
console.log("content.js loaded");

// インジケーターのIDをグローバルに定義
const INDICATOR_ID = 'spam-detector-indicator';


// Service Worker延命用のタイマーID
let keepAliveIntervalId = null;


let exclusionKeywords = { target: [], reference: [] };
let compiledExclusionKeywords = { target: [], reference: [] };
let isInitialized = false;
let initializationPromise = null; // 初期化処理の Promise

// テキスト/行の最小文字数
const MIN_TEXT_LENGTH = 5;

// ツールチップ消去用のタイマーIDと遅延時間
let tooltipClearTimeoutId = null;
const TOOLTIP_CLEAR_DELAY = 50; // ミリ秒

// ターゲットデータを保持する変数 (ツールチップ表示用)
let currentTargets = [];

// --- 最適化された正規表現定義 (定数化) ---
const NORMALIZE_REMOVAL_PATTERN = new RegExp(
    '[' +
    '\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F' +      // 制御文字(\n\r\t除く)
    '\\u00A0\\u115F\\u1160\\u1680\\u180E' +
    '\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u2800\\u3164' + // 紛らわしい空白
    '\\uFE00-\\uFE0F' +                                  // 異体字セレクタ (VS1〜VS16)
    ']|' +
    '\\p{Cf}|\\p{Co}|\\p{Cn}|' +                         // 不審なUnicodeプロパティ
    '[\\u{E0100}-\\u{E01EF}]',                           // 字形選択子補助 (VS17〜VS256)
    'gu' // global と unicode フラグ
);
const ZALGO_REMOVAL_PATTERN = /\p{M}/gu;
const DISPLAY_ZALGO_PATTERN = /(\P{M})(\p{M}{4,})/gu;
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const UNICODE_FORMAT_PATTERN = /\p{Cf}|\p{Co}|\p{Cn}/gu;
const MULTI_SPACE_PATTERN = /[ \t]+/g;
const TRIM_LINE_PATTERN = /[ \t]*\n[ \t]*/g;
const MULTI_NEWLINE_PATTERN = /\n{3,}/g;
const LINK_TEXT_PATTERN = /\[link\]/g;


// --- ハイライト用のCSSクラスを定義し、ページの<head>に注入 ---
const SPAM_DETECTOR_STYLE_ID = 'spam-detector-styles';
if (!document.getElementById(SPAM_DETECTOR_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = SPAM_DETECTOR_STYLE_ID;
    style.textContent = `
        .spam-highlight-suspicious {
            background-color: rgba(255, 255, 0, 0.5) !important;
            border: 2px solid red !important;
        }
        .spam-highlight-matched {
            background-color: rgba(147, 112, 219, 0.5) !important;
            border: 2px solid #9370DB !important;
        }
        .spam-highlight-clean {
            background-color: rgba(144, 238, 144, 0.5) !important;
            border: none !important;
        }
        
        .spam-highlight-source {
            background-color: rgba(173, 216, 230, 0.4) !important; /* 薄い水色の背景 */
            border: 2px solid #007bff !important; /* 青色のボーダー */
        }
        
        /* 可視化されたマーカー用のスタイルを定義 */
        .spam-marker {

            font-size: 12px;
            font-weight: bold;
            color: black;

        }

        
    `;
    document.head.appendChild(style);
}

/**
 * ページ右下に判定中であることを示すインジケーターを表示します。
 */
function showProcessingIndicator() {
    if (document.getElementById(INDICATOR_ID)) {
        return;
    }
    // keepAlive関連の処理を削除

    const indicator = document.createElement('div');
    indicator.id = INDICATOR_ID;
    indicator.textContent = '判定中...';
    Object.assign(indicator.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        padding: '10px 15px',
        backgroundColor: 'rgba(40, 40, 40, 0.9)',
        color: '#fff',
        borderRadius: '5px',
        zIndex: '2147483647',
        fontSize: '14px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
        userSelect: 'none',
        opacity: '0',
        transition: 'opacity 0.3s ease-in-out'
    });
    document.body.appendChild(indicator);
    setTimeout(() => {
        indicator.style.opacity = '1';
    }, 10);
}

/**
 * 判定中インジケーターを削除します。
 */
function removeProcessingIndicator() {
    // keepAlive関連の処理を削除

    const indicator = document.getElementById(INDICATOR_ID);
    if (indicator) {
        indicator.style.opacity = '0';
        setTimeout(() => {
            indicator.remove();
        }, 300);
    }
}


/**
 * テキストを正規化する。比較用と表示用で処理を分ける。
 * 修正: 正規表現オブジェクトを定数化し、数千回の再生成コストを排除。
 */
function normalizeText(text, forDisplay = false) {
    if (typeof text !== 'string') return text;

    let normalizedText = text;

    // 「[link]」という文字列を除去
    normalizedText = normalizedText.replace(LINK_TEXT_PATTERN, '');

    // Unicode正規化 (NFC)
    normalizedText = normalizedText.normalize('NFC');
    
    if (!forDisplay) {
        // パターンに一致する文字を削除 (定数化した正規表現を使用)
        normalizedText = normalizedText.replace(NORMALIZE_REMOVAL_PATTERN, '');

        // 結合文字を削除
        normalizedText = normalizedText.replace(ZALGO_REMOVAL_PATTERN, '');

        // 既存の空白・改行の調整
        normalizedText = normalizedText
            .replace(MULTI_SPACE_PATTERN, ' ')
            .replace(TRIM_LINE_PATTERN, '\n')
            .replace(MULTI_NEWLINE_PATTERN, '\n\n')
            .trim();
    } else {
        // 表示用の正規化
        normalizedText = normalizedText
            .replace(CONTROL_CHARS_PATTERN, '')
            .replace(UNICODE_FORMAT_PATTERN, '');
        // Zalgo対策
        normalizedText = normalizedText.replace(DISPLAY_ZALGO_PATTERN, '$1');
    }

    return normalizedText;
}



/**
 * background script に準備完了を通知し、初期除外キーワードを取得する。
 * この関数は background から 'contentReady' メッセージを受け取った後に呼び出される。
 */
function initializeContentScript() {
    // 既に初期化処理が進行中または完了している場合は何もしない
    if (initializationPromise) {
        return initializationPromise;
    }

    console.log("Initializing content script after receiving 'contentReady', requesting exclusion keywords...");
    initializationPromise = new Promise((resolve, reject) => {
        // background に contentScript が準備できたことを通知
        chrome.runtime.sendMessage({ type: 'contentScriptReady' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error sending contentScriptReady:", chrome.runtime.lastError.message);
                // isInitialized は false のまま
                resolve(); // エラーでも resolve し、初期化失敗状態とする
                return;
            }
            // background から初期除外キーワードを受け取る
            if (response && response.type === 'initialExclusionKeywords' && response.keywords) {
                console.log("Received initial exclusionKeywords:", response.keywords);
                // 修正: updateExclusionKeywords を使用
                updateExclusionKeywords(response.keywords);
                isInitialized = true;
                console.log("Content script initialized successfully.");
                resolve();
            } else if (response && response.type === 'error') {
                 console.error("Failed to receive initial exclusionKeywords from background (error response):", response.message);
                 resolve(); // 初期化失敗状態
            } else {
                console.error("Failed to receive initial exclusionKeywords from background (invalid response):", response);
                resolve(); // 初期化失敗状態
            }
        });
    }).catch(error => { // sendMessage 自体のエラー
        console.error("Exception during contentScriptReady message:", error);
        // 初期化失敗状態にする
    });
    return initializationPromise;
}

/**
 * 除外キーワードを更新し、正規表現をコンパイルしてキャッシュする
 */
function updateExclusionKeywords(keywords) {
    exclusionKeywords = keywords;
    
    const compile = (patterns) => {
        if (!Array.isArray(patterns)) return [];
        return patterns.map(pattern => {
            try {
                return new RegExp(pattern, 'gm');
            } catch (e) {
                console.error("[CS] Invalid exclusion regex:", pattern, e);
                return null;
            }
        }).filter(Boolean);
    };

    compiledExclusionKeywords.target = compile(keywords.target);
    compiledExclusionKeywords.reference = compile(keywords.reference);
    console.log(`[CS] Compiled exclusion keywords. Target: ${compiledExclusionKeywords.target.length}, Reference: ${compiledExclusionKeywords.reference.length}`);
}

/**
 * 指定されたテキストが、除外キーワード（コンパイル済み正規表現）にマッチするか判定
 * 修正: キャッシュされた正規表現を使用し、都度の new RegExp を排除
 */
function isExcluded(text, type) { // type: 'target' or 'reference'
    const regexes = compiledExclusionKeywords[type];
    if (!regexes || regexes.length === 0) return false;
    
    for (const regex of regexes) {
        regex.lastIndex = 0; // 再利用のためリセット
        if (regex.test(text)) return true;
    }
    return false;
}




/**
 * blockquote要素内を走査し、行ごとのテキスト配列を生成します。
 * 修正: 分割前に一括でNFC正規化を行い、normalizeTextの負荷を軽減。
 */
function extractLinesFromBlockquote(blockquote) {
    let text = '';

    // 再帰的にノードを走査してテキストを収集
    function traverse(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            if (tagName === 'br') {
                text += '\n';
            } else if (tagName === 'blockquote') {
                return; // 引用内の引用は無視
            } else {
                const children = node.childNodes;
                const len = children.length;
                for (let i = 0; i < len; i++) {
                    traverse(children[i]);
                }
            }
        }
    }

    const children = blockquote.childNodes;
    const len = children.length;
    for (let i = 0; i < len; i++) {
        traverse(children[i]);
    }

    // 最適化: 文字列全体に対して一度だけNFC正規化を行う
    if (text) {
        text = text.normalize('NFC');
    }

    // 改行文字で分割し、各行に残りの正規化を適用
    // normalizeTextの第3引数(skipNfc)を追加して対応するか、
    // ここでは normalizeText が NFC を含むため、多少重複するが
    // normalizeText 側の NFC 呼び出しコストは、既にNFC化されていれば低いので許容範囲。
    // 重要なのは「分割後の大量の文字列」ではなく「分割前の1つの文字列」で済ませることだが、
    // normalizeTextの実装を変えずに最適化するため、ここでは
    // 「normalizeTextを通さず、必要な置換だけ行う」アプローチをとる。
    
    const lines = text.split('\n');
    const processedLines = new Array(lines.length);
    
    for (let i = 0; i < lines.length; i++) {
        // normalizeText(line, false) の中身を展開・最適化
        let line = lines[i];
        
        // [link]除去
        line = line.replace(LINK_TEXT_PATTERN, '');
        
        // 制御文字・不要文字削除
        line = line.replace(NORMALIZE_REMOVAL_PATTERN, '');
        
        // 結合文字削除
        line = line.replace(ZALGO_REMOVAL_PATTERN, '');
        
        // 空白・改行調整
        line = line
            .replace(MULTI_SPACE_PATTERN, ' ')
            // 行単位処理なので改行置換は不要だが、trimは必要
            .trim();
            
        processedLines[i] = line;
    }

    return processedLines;
}

async function extractTargetTexts() {
  if (!isInitialized) {
      await initializationPromise;
      if (!isInitialized) {
          console.error("Cannot extract target texts: Content script initialization failed.");
          try {
              chrome.runtime.sendMessage({ type: 'targetTexts', targets: [], url: window.location.href, error: "Content script initialization failed" });
          } catch (e) { console.error("Failed to send initialization error to background:", e); }
          return;
      }
  }

  const blockquotes = document.querySelectorAll('blockquote');
  const targets = [];
  // Setを使って検索をO(1)にする
  const linesToRemove = new Set(["スレッドを立てた人によって削除されました", "書き込みをした人によって削除されました", "削除依頼によって隔離されました", "ｷﾀ━━━(ﾟ∀ﾟ)━━━!!", "ｷﾀ━━━━━━(ﾟ∀ﾟ)━━━━━━ !!!!!"]);

  for (const blockquote of blockquotes) {
      // 修正: ここで返ってくるのは既に正規化済みの行配列
      const initialLines = extractLinesFromBlockquote(blockquote);
      
      // 修正: 再度の normalizeText を削除し、Setでチェック
      const allFilteredLines = initialLines.filter(line => line.length >= MIN_TEXT_LENGTH && !linesToRemove.has(line));
      
      if (allFilteredLines.length === 0) continue;

      const nonQuoteLines = allFilteredLines.filter(line => !line.startsWith('>'));
      if (nonQuoteLines.length === 0) continue;

      const textWithBreaks = allFilteredLines.join('\n');
      const fullTextContent = nonQuoteLines.join('');

      // 修正: 第2引数にタイプ('target')を指定
      const excludedByRegex = isExcluded(fullTextContent, 'target');

      if (!excludedByRegex) {
          let parentTd = blockquote.closest('td');
          if (parentTd) {
              const spanCno = parentTd.querySelector('span.cno');
              let resno = null;
              if (spanCno) {
                  const match = spanCno.textContent.match(/No\.(\d+)/);
                  if (match) resno = match[1];
              }
              const spanRsc = parentTd.querySelector('span.rsc');
              let rsc = null;
              if (spanRsc) rsc = spanRsc.textContent.trim();
              targets.push({
                  id: "target-" + Date.now() + "-" + Math.floor(Math.random() * 10000),
                  text: fullTextContent, 
                  textWithBreaks: textWithBreaks, 
                  lines: nonQuoteLines,
                  resno: resno, rsc: rsc,
              });
          }
      }
  }

  try {
      chrome.runtime.sendMessage({ type: 'targetTexts', targets: targets, url: window.location.href });
	  console.log("[CS] sendMessage targetTexts");
  } catch (error) {
      console.error("Error sending targetTexts:", error);
  }
}

async function extractReferenceTexts() {
  if (!isInitialized) {
      await initializationPromise;
      if (!isInitialized) {
          console.error("Cannot extract reference texts: Initialization failed.");
          return;
      }
  }

  const blockquotes = document.querySelectorAll('blockquote');
  const dataToSend = [];
  const linesToRemove = new Set(["スレッドを立てた人によって削除されました", "書き込みをした人によって削除されました", "削除依頼によって隔離されました", "ｷﾀ━━━(ﾟ∀ﾟ)━━━!!", "ｷﾀ━━━━━━(ﾟ∀ﾟ)━━━━━━ !!!!!"]);

  for (const blockquote of blockquotes) {
      // 修正: 正規化済み配列を取得
      const initialLines = extractLinesFromBlockquote(blockquote);

      // 修正: 再度の normalizeText を削除
      const allFilteredLines = initialLines.filter(line => line.length >= MIN_TEXT_LENGTH && !linesToRemove.has(line));
      
      if (allFilteredLines.length === 0) continue;

      const nonQuoteLines = allFilteredLines.filter(line => !line.startsWith('>'));
      if (nonQuoteLines.length === 0) continue;

      const textWithBreaks = allFilteredLines.join('\n');
      const fullTextContent = nonQuoteLines.join('');

      // 修正: 第2引数にタイプ('reference')を指定
      const excluded = isExcluded(fullTextContent, 'reference');

      if (!excluded) {
          dataToSend.push({
              text: fullTextContent, 
              textWithBreaks: textWithBreaks, 
              lines: nonQuoteLines
          });
      }
  }

  if (dataToSend.length > 0) {
    try {
        chrome.runtime.sendMessage({ type: 'referenceTexts', data: dataToSend, url: window.location.href });
    } catch (error) {
        console.error("Error sending referenceTexts:", error);
    }
  }
}


/**
 * 指定された要素にマウスオーバー/アウトイベントリスナーを追加し、
 * ツールチップの表示/遅延消去を制御します。
 * @param {HTMLElement} element - イベントリスナーを追加する要素 (通常は <td>)。
 * @param {object} result - ツールチップに表示する判定結果オブジェクト。
 */
function addMouseoverListener(element, result) {
    // --- イベントハンドラの定義 ---
    const handleMouseOver = () => {
        // 既存の消去タイマーがあればキャンセル
        clearTimeout(tooltipClearTimeoutId);
        tooltipClearTimeoutId = null;
        // ツールチップを表示 (既存のツールチップは displayResult 内でクリアされる)
        displayResult(element, result);
    };

    const handleMouseOut = () => {
        // 既存の消去タイマーがあればキャンセル (連続mouseout対策)
        clearTimeout(tooltipClearTimeoutId);
        // 新しい消去タイマーを設定
        tooltipClearTimeoutId = setTimeout(() => {
            clearResultDisplay();
            tooltipClearTimeoutId = null; // タイマーIDをリセット
        }, TOOLTIP_CLEAR_DELAY);
    };

    // --- 既存リスナーの削除 (要素に紐付けたハンドラを削除) ---
    if (element.mouseoverHandler) {
        element.removeEventListener('mouseover', element.mouseoverHandler);
    }
    if (element.mouseoutHandler) {
        element.removeEventListener('mouseout', element.mouseoutHandler);
    }

    // --- 新しいリスナーの追加 ---
    element.addEventListener('mouseover', handleMouseOver);
    element.addEventListener('mouseout', handleMouseOut);

    // --- ハンドラを要素に紐付け (削除用) ---
    element.mouseoverHandler = handleMouseOver;
    element.mouseoutHandler = handleMouseOut;
}



/**
 * 判定結果をツールチップとして表示します。
 * ツールチップ自体にもマウスイベントリスナーを追加し、永続化を実現します。
 * @param {HTMLElement} element - ツールチップの表示位置の基準となる要素。
 * @param {object} result - 表示する判定結果オブジェクト。
 */
function displayResult(element, result) {
    clearTimeout(tooltipClearTimeoutId);
    tooltipClearTimeoutId = null;
    clearResultDisplay();

    const tooltip = document.createElement('div');
    tooltip.className = 'spam-tooltip';
    Object.assign(tooltip.style, {
        position: 'absolute', zIndex: '10000', border: '1px solid #ccc',
        backgroundColor: '#333', color: '#fff', padding: '10px',
        borderRadius: '5px', fontSize: '0.9em', wordWrap: 'break-word',
        whiteSpace: 'normal', boxShadow: '2px 2px 5px rgba(0,0,0,0.2)',
        pointerEvents: 'auto'
    });

    const createTextNode = (text) => document.createTextNode(text);
    const createStrong = (text) => {
        const strong = document.createElement('strong');
        strong.textContent = text;
        return strong;
    };
    const createDiv = (text, style) => {
        const div = document.createElement('div');
        if (style) Object.assign(div.style, style);
        if (text) div.textContent = text;
        return div;
    };
    const createHr = (dashed = false) => {
        const hr = document.createElement('hr');
        hr.style.borderTop = `1px ${dashed ? 'dashed' : 'solid'} #555`;
        hr.style.margin = '5px 0';
        return hr;
    };
    const formatNgramResult = (name, result) => {
        if (typeof result === 'object' && result !== null && typeof result.total !== 'undefined') {
            return `${name}: ${result.total} (連続:${result.longestChain})`;
        }
        return `${name}: ${result}`;
    };
    const fullTextDivStyle = {
        maxHeight: '100px', overflowY: 'auto', background: '#444',
        padding: '5px', marginBottom: '5px', border: '1px solid #555',
        borderRadius: '3px', whiteSpace: 'pre-wrap'
    };


    /** 取得元URLを表示するDOM要素を生成するヘルパー関数 */
    const createSourceUrlElement = (sourceUrl) => {
        if (!sourceUrl) return null;
        const container = document.createElement('div');
        Object.assign(container.style, {
            fontSize: '0.9em', marginTop: '3px', marginBottom: '5px',
            padding: '3px', background: '#2a2a2a', borderRadius: '3px'
        });

        const label = document.createTextNode('取得元: ');
        const link = document.createElement('a');
        link.href = sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = sourceUrl.length > 70 ? sourceUrl.substring(0, 70) + '...' : sourceUrl;
        link.style.color = '#87cefa'; // Light sky blue

        container.appendChild(label);
        container.appendChild(link);
        return container;
    };


    const createNgramDetails = (reasonData) => {
        const container = document.createDocumentFragment();
        const ngramStatsText = formatNgramResult('Trigram', reasonData.trigrams);
        container.appendChild(createTextNode(ngramStatsText));
        const allMatchedNgrams = [...(reasonData.trigrams?.matchedStrings || [])];
        if (allMatchedNgrams.length > 0) {
            const MAX_DISPLAY_NGRAMS = 10;
            const displayNgrams = allMatchedNgrams.slice(0, MAX_DISPLAY_NGRAMS);
            let matchedTextContent = `一致箇所: ${displayNgrams.map(s => `「${s}」`).join(', ')}`;
            if (allMatchedNgrams.length > MAX_DISPLAY_NGRAMS) {
                matchedTextContent += ` ... (他 ${allMatchedNgrams.length - MAX_DISPLAY_NGRAMS}件)`;
            }
            container.appendChild(document.createElement('br'));
            const matchedDiv = createDiv(matchedTextContent, {
                fontSize: '0.9em', color: '#ddd', marginTop: '3px'
            });
            container.appendChild(matchedDiv);
        }
        return container;
    };

    // 新規追加: Jaccard Hybrid の詳細表示ヘルパー
    const createJaccardHybridDetails = (reasonData) => {
        const container = document.createDocumentFragment();
        const detailStyle = { fontSize: '0.9em', color: '#ddd', marginTop: '3px', paddingLeft: '10px' };
        
        const createDetailLine = (label, value) => {
            if (typeof value !== 'number') return '';
            return `${label}: ${(value * 100).toFixed(1)}%`;
        };

        // 変更箇所：表示指標の更新
        let detailsText = [
            createDetailLine('ターゲット被覆率(T)', reasonData.coverageT),
            createDetailLine('参照被覆率(R)', reasonData.coverageR),
            createDetailLine('Jaccard係数', reasonData.jaccard),
            createDetailLine('ブロック一致率', reasonData.blockCoverage) // longestMatchRatio の代わりに blockCoverage を表示
        ].filter(Boolean).join(' / ');
        // 変更箇所

        container.appendChild(createDiv(detailsText, detailStyle));
        
        if (reasonData.kanjiCorrection && reasonData.kanjiCorrection.applied) {
            const kc = reasonData.kanjiCorrection;
            const kanjiText = `漢字補正: ${(kc.similarity * 100).toFixed(1)}% (T:${kc.targetUnique} R:${kc.refUnique} 共:${kc.common})`;
            container.appendChild(createDiv(kanjiText, {...detailStyle, color: '#aaccff'}));
        }

        if (reasonData.boostInfo && reasonData.boostInfo.total > 0) {
            const boostInfo = reasonData.boostInfo;
            const boostReasons = [];
            
            // 変更箇所：文頭ボーナスの表示を追加
            if (boostInfo.startBonus > 0) {
                boostReasons.push(`文頭一致: +${(boostInfo.startBonus * 100).toFixed(1)}%`);
            }
            // 変更箇所
            if (boostInfo.endBonus > 0) {
                boostReasons.push(`末尾一致: +${(boostInfo.endBonus * 100).toFixed(1)}%`);
            }
            if (boostInfo.lowKanjiBonus > 0) {
                boostReasons.push(`低漢字: +${(boostInfo.lowKanjiBonus * 100).toFixed(1)}%`);
            }

            const totalBoostText = `+${(boostInfo.total * 100).toFixed(1)}%`;
            const boostDetailsText = `(${boostReasons.join(' / ')})`;
            
            const boostDiv = createDiv(`ブースト: ${totalBoostText} ${boostDetailsText}`, {...detailStyle, color: '#aaeebb'});
            container.appendChild(boostDiv);
        }
        
        return container;
    };
    // 新規追加

    tooltip.appendChild(createStrong(`判定: ${result.isSuspicious ? '疑わしい' : (result.isSourceOfCopy ? 'コピー元' : '不検出')}`));
    tooltip.appendChild(createTextNode(` (No.${result.resno || 'N/A'} / ${result.rsc || 'N/A'})`));
    tooltip.appendChild(createHr());

    if (result.reason2?.isMatched) {
        tooltip.appendChild(createTextNode('根拠: キーワード一致'));
        tooltip.appendChild(document.createElement('br'));
        const keywordSpan = document.createElement('span');
        keywordSpan.innerHTML = `一致キーワード: ${result.reason2.matchedKeywords.map(k => escapeHtml(k)).join(', ')}`;
        tooltip.appendChild(keywordSpan);
    } else if (result.isSuspicious && result.reason) {
        const allMatches = result.reason.matches || [result.reason];
        tooltip.appendChild(createStrong('根拠: 高い類似度の一致'));
        tooltip.appendChild(createHr());
        
        allMatches.forEach((match, index) => {
            const reason = match.details;
            const matchType = reason.matchType;
            const comparisonType = reason.comparisonType || 'reference';

            const header = document.createElement('div');
            header.style.cursor = 'pointer';
            header.style.padding = '2px 0';
            header.style.fontWeight = 'bold';
            const typeLabel = comparisonType === 'target' ? '【ターゲット間】' : '【参照テキスト】';
            const parentLabel = reason.isParent ? ' (親)' : '';
            header.textContent = `[${index + 1}位] ${typeLabel} スコア: ${(match.score * 100).toFixed(1)}${parentLabel}`;
            
            const content = document.createElement('div');
            content.style.paddingLeft = '10px';
            content.style.borderLeft = '2px solid #555';
            content.style.marginTop = '5px';
            content.style.marginBottom = '5px';

            // 変更箇所: ターゲット間比較の表示ロジック
            if (comparisonType === 'target') {
                const resno1 = match.original[0].resno || 'N/A';
                const rsc1 = match.original[0].rsc || 'N/A';
                const resno2 = match.original[1].resno || 'N/A';
                const rsc2 = match.original[1].rsc || 'N/A';

                let subTitle = '種類: ';
                switch (matchType) {
                    case 'full-edit-dist':
                        subTitle += '全文類似 (編集距離)';
                        break;
                    case 'line-edit-dist':
                        subTitle += '行類似 (編集距離)';
                        break;
                    case 'hybrid_token_similarity':
                        subTitle += 'ハイブリッド類似度';
                        break;
                    case 'ngram':
                    default:
                        subTitle += 'N-gram 一致';
                        break;
                }
                content.appendChild(createTextNode(subTitle));
                content.appendChild(document.createElement('br'));

                if (matchType === 'line-edit-dist') {
                    content.appendChild(createTextNode(`コピー元 行: ${reason.matchedLines.lineSource}`));
                    content.appendChild(document.createElement('br'));
                    content.appendChild(createTextNode(`コピー先 行: ${reason.matchedLines.lineCopy}`));
                    content.appendChild(document.createElement('br'));
                    content.appendChild(createTextNode(`編集距離: ${reason.matchedLines.distance}`));
                } else if (matchType === 'full-edit-dist') {
                    content.appendChild(createTextNode(`編集距離: ${reason.editDistance ?? 'N/A'}`));
                } else if (matchType === 'hybrid_token_similarity') {
                    content.appendChild(createJaccardHybridDetails(reason));
                } else { // ngram
                    content.appendChild(createNgramDetails(reason));
                    content.appendChild(document.createElement('br'));
                    content.appendChild(createTextNode(`編集距離: ${reason.editDistance ?? 'N/A'}`));
                }
                
                if (reason.kanjiInfo) {
                    const ki = reason.kanjiInfo;
                    const kanjiInfoText = ` / 共通漢字率: ${(ki.similarity * 100).toFixed(0)}%`;
                    content.appendChild(createTextNode(kanjiInfoText));
                }

                content.appendChild(createHr(true));
                content.appendChild(createTextNode(`[コピー元: No.${resno1} / ${rsc1}]`));
                content.appendChild(createDiv(match.original[0].textWithBreaks, fullTextDivStyle));
                content.appendChild(createTextNode(`[コピー先: No.${resno2} / ${rsc2}]`));
                content.appendChild(createDiv(match.original[1].textWithBreaks, {...fullTextDivStyle, marginBottom: '0px'}));

                const chainInfo = reason.chainInfo;
                if (chainInfo && chainInfo.copies && chainInfo.copies.length > 0) {
                    content.appendChild(createHr(true));
                    const copiesRscList = chainInfo.copies.map(c => c.rsc || c.resno);
                    const copiesText = `この投稿のコピー: ${copiesRscList.join(', ')}`;
                    const copiesDiv = createDiv(copiesText, {
                        background: '#553333', padding: '3px',
                        borderRadius: '3px', marginTop: '5px'
                    });
                    content.appendChild(copiesDiv);
                }
            // 変更箇所: 参照テキスト比較の表示ロジック
            } else { // comparisonType === 'reference'
                const sourceUrl = match.original?.[0]?.sourceUrl;
                let matchTypeText = '';
                
                switch (matchType) {
                    case 'line-edit-dist':
                        matchTypeText = '種類: 行類似 (編集距離)';
                        break;
                    case 'full-edit-dist':
                        matchTypeText = '種類: 全文類似 (編集距離)';
                        break;
                    case 'hybrid_token_similarity':
                        matchTypeText = '種類: ハイブリッド類似度';
                        break;
                    case 'ngram':
                    default:
                        matchTypeText = '種類: N-gram 一致';
                        break;
                }
                content.appendChild(createTextNode(matchTypeText));
                content.appendChild(document.createElement('br'));

                // 各タイプごとの詳細表示
                if (matchType === 'line-edit-dist') {
                    content.appendChild(createTextNode(`ターゲット行: ${reason.matchedLines.target}`));
                    content.appendChild(document.createElement('br'));
                    content.appendChild(createTextNode(`参照行: ${reason.matchedLines.reference}`));
                    content.appendChild(document.createElement('br'));
                    content.appendChild(createTextNode(`編集距離: ${reason.matchedLines.distance}`));
                    content.appendChild(createHr(true));
                    content.appendChild(createTextNode('参照全文:'));
                    content.appendChild(createDiv(reason.matchedLines.referenceFullText, {...fullTextDivStyle, marginBottom: '0px'}));
                    const urlElement = createSourceUrlElement(sourceUrl);
                    if (urlElement) content.appendChild(urlElement);
                } else { // full-edit-dist, ngram, hybrid_token_similarity
                    content.appendChild(createTextNode('近似した原文:'));
                    if (match.original) {
                        match.original.forEach(orig => {
                            content.appendChild(createDiv(orig.textWithBreaks, fullTextDivStyle));
                            const urlElement = createSourceUrlElement(orig.sourceUrl);
                            if (urlElement) content.appendChild(urlElement);
                        });
                    }
                    content.appendChild(createHr(true));

                    if (matchType === 'full-edit-dist') {
                        content.appendChild(createTextNode(`編集距離: ${reason.editDistance}`));
                    } else if (matchType === 'hybrid_token_similarity') {
                        content.appendChild(createJaccardHybridDetails(reason));
                    } else { // ngram
                        content.appendChild(createNgramDetails(reason));
                        content.appendChild(document.createElement('br'));
                        content.appendChild(createTextNode(`(全文編集距離: ${reason.editDistance ?? 'N/A'})`));
                    }

                    if (reason.kanjiInfo) {
                        const ki = reason.kanjiInfo;
                        const kanjiInfoText = `共通漢字率: ${(ki.similarity * 100).toFixed(0)}% (共通:${ki.common} / 対象:${ki.targetUnique} / 参照:${ki.refUnique})`;
                        content.appendChild(document.createElement('br'));
                        content.appendChild(createTextNode(kanjiInfoText));
                    }
                }
            }
            // 変更箇所

            tooltip.appendChild(header);
            tooltip.appendChild(content);

            if (index === 0) {
                content.style.display = 'block';
                header.textContent += ' ▼';
            } else {
                content.style.display = 'none';
                header.textContent += ' ▶（クリックで展開）';
            }

            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const isVisible = content.style.display === 'block';
                tooltip.querySelectorAll('.spam-tooltip-accordion-content').forEach((c) => {
                    c.style.display = 'none';
                    const h = c.previousElementSibling;
                    if (h) {
                       h.textContent = h.textContent.replace(' ▼', ' ▶');
                    }
                });
                if (!isVisible) {
                    content.style.display = 'block';
                    header.textContent = header.textContent.replace(' ▶', ' ▼');
                }
            });
            content.classList.add('spam-tooltip-accordion-content');
        });
    } else if (result.isSuspicious) {
        tooltip.appendChild(createTextNode('根拠: 不明 (データ不整合の可能性)'));
    }

    document.body.appendChild(tooltip);

    const rect = element.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const maxTooltipWidth = windowWidth - 40;
    tooltip.style.maxWidth = `${maxTooltipWidth}px`;
    const finalTooltipRect = tooltip.getBoundingClientRect();

    let top = rect.bottom + window.pageYOffset - 5;
    if (top + finalTooltipRect.height > window.innerHeight + window.pageYOffset) {
        top = rect.top + window.pageYOffset + 5 - finalTooltipRect.height;
    }
    if (top < window.pageYOffset) {
        top = window.pageYOffset + 5;
    }

    let left = rect.left + window.pageXOffset;
    if (left < window.pageXOffset) left = window.pageXOffset + 10;
    if (left + finalTooltipRect.width > window.innerWidth + window.pageXOffset - 10) {
        left = window.innerWidth + window.pageXOffset - finalTooltipRect.width - 10;
    }
    if (left < 0) left = 0;

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;

    tooltip.addEventListener('mouseover', () => {
        clearTimeout(tooltipClearTimeoutId);
        tooltipClearTimeoutId = null;
    });
    tooltip.addEventListener('mouseout', () => {
        clearTimeout(tooltipClearTimeoutId);
        tooltipClearTimeoutId = setTimeout(() => {
            clearResultDisplay();
            tooltipClearTimeoutId = null;
        }, TOOLTIP_CLEAR_DELAY);
    });
}

/**
 * 表示されているすべてのツールチップを削除します。
 */
function clearResultDisplay() {
    const tooltips = document.querySelectorAll('.spam-tooltip');
    tooltips.forEach(tooltip => tooltip.remove());
}

/**
 * HTML特殊文字をエスケープし、改行文字を <br> タグに変換します。
 * @param {string} unsafe - エスケープする文字列。
 * @returns {string} エスケープされた文字列。
 */
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return unsafe; // 文字列でない場合はそのまま返す
    }
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;")
         .replace(/\n/g, "<br>"); // (1) 改行を <br> タグに変換
}


// 保留中の表示データ
let pendingDisplayData = [];

/**
 * ページ上のすべてのハイライトと関連イベントリスナーをクリアします。
 */
function clearAllHighlights() {
    try {
        // 
        const highlightedElements = document.querySelectorAll('[data-spam-highlighted]');
        highlightedElements.forEach(el => {
            // CSSクラスをすべて削除
            el.classList.remove('spam-highlight-suspicious', 'spam-highlight-matched', 'spam-highlight-clean', 'spam-highlight-source');
            el.removeAttribute('data-spam-highlighted');
            
            // イベントリスナーの削除は変更なし
            if (el.mouseoverHandler) {
                el.removeEventListener('mouseover', el.mouseoverHandler);
                delete el.mouseoverHandler;
            }
            if (el.mouseoutHandler) {
                el.removeEventListener('mouseout', el.mouseoutHandler);
                delete el.mouseoutHandler;
            }
        });
        // 
    } catch (clearError) {
        console.error("[CS] Error clearing highlights:", clearError);
    }
}


// 
// レス要素をキャッシュするためのMap
let resnoTdMap = null;

/**
 * ページ上のすべてのレス要素をスキャンし、resnoをキーとするMapを作成する。
 * この処理は一度だけ実行される。
 */
function buildResnoTdMap() {
    console.time("buildResnoTdMap");
    resnoTdMap = new Map();
    // 'cno'クラスを持つspan要素をすべて取得
    const cnoSpans = document.querySelectorAll('span.cno');
    cnoSpans.forEach(span => {
        const match = span.textContent.match(/No\.(\d+)/);
        if (match) {
            const resno = match[1];
            const parentTd = span.closest('td');
            if (parentTd) {
                resnoTdMap.set(resno, parentTd);
            }
        }
    });
    console.timeEnd("buildResnoTdMap");
    console.log(`[CS] Built resno-TD map with ${resnoTdMap.size} entries.`);
}


/**
 * 判定結果を表示するコアロジック（パフォーマンス改善版）
 * ページ内検索用の目印を、可視化されたマーカーに変更
 */
async function applyDisplayResults(message) {
    if (!resnoTdMap) {
        buildResnoTdMap();
    }

    if (!isInitialized || !resnoTdMap) {
        console.error("[CS] applyDisplayResults: Cannot apply results, script not initialized or map not built.");
        return;
    }

    // マーカー用の共通クラス名
    const MARKER_BASE_CLASS = 'spam-marker';

    if (message.results?.result) {
        requestAnimationFrame(() => {
            for (const result of message.results.result) {
                if (!result || !result.resno) continue;

                const matchingTd = resnoTdMap.get(result.resno);

                if (matchingTd) {
                    // 既存のハイライトクラスと、以前追加した可能性のあるマーカーを削除
                    matchingTd.classList.remove('spam-highlight-suspicious', 'spam-highlight-matched', 'spam-highlight-clean', 'spam-highlight-source');
                    const existingMarker = matchingTd.querySelector(`.${MARKER_BASE_CLASS}`);
                    if (existingMarker) {
                        existingMarker.remove();
                    }

                    let highlightClass = '';
                    let markerInfo = null; // マーカー情報を保持するオブジェクト { text, className }
                    
                    if (result.isSourceOfCopy) {
                        highlightClass = 'spam-highlight-source';
                    } else if (result.isSuspicious) {
                        // ターゲット間(複製)か、参照テキスト(疑わしい)かでマーカーを分ける
                        if (result.reason2?.isMatched || result.reason?.comparisonType === 'target') {
                            highlightClass = 'spam-highlight-matched';
                            markerInfo = { text: 'spam-matched' };
                        } else { // reason.comparisonType === 'reference' or other cases
                            highlightClass = 'spam-highlight-suspicious';
                            markerInfo = { text: 'spam-suspect' };
                        }
                    } else {
                        highlightClass = 'spam-highlight-clean';
                    }
                    
                    if (highlightClass) {
                        matchingTd.classList.add(highlightClass);
                    }

                    // マーカー情報があれば、可視のspan要素を a.sod の後に追加
                    if (markerInfo) {
                        const anchorElement = matchingTd.querySelector('a.sod');
                        if (anchorElement) {
                            const markerSpan = document.createElement('span');
                            markerSpan.className = `${MARKER_BASE_CLASS} ${markerInfo.className}`;
                            markerSpan.textContent = markerInfo.text;
                            // a.sod の直後に挿入
                            anchorElement.insertAdjacentElement('afterend', markerSpan);
                        }
                    }

                    matchingTd.setAttribute('data-spam-highlighted', 'true');
                    addMouseoverListener(matchingTd, result);
                }
            }
        });
    } else {
        console.warn("[CS] applyDisplayResults: Invalid results data received:", message.results);
    }
}


/**
 * background script からのメッセージを処理します。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- displayResults: 判定結果を表示 ---
  if (message.type === 'displayResults') {
    console.log(`[CS] Received displayResults. Initialized: ${isInitialized}. Results count: ${message.results?.result?.length}`);
    (async () => {
        const applyResults = async (msg) => {
            if (!isInitialized) {
                console.error("[CS] Cannot apply results, script not initialized. Storing in pending.");
                // 修正点: 届いたメッセージを配列に追加します
                pendingDisplayData.push(msg);
                return;
            }
            // 最初のチャンクを受け取った時に、既存のハイライトをすべてクリアする
            if (msg.results?.isFirstChunk) {
                console.log("[CS] First chunk received, clearing all highlights and resetting map.");
                clearAllHighlights();
                resnoTdMap = null; // Mapをリセットして再構築を促す
            }
            await applyDisplayResults(msg);
        };

        if (!isInitialized && initializationPromise) {
            console.log("[CS] displayResults: Script not initialized yet. Waiting for initialization promise...");
            try {
                await initializationPromise;
                console.log("[CS] displayResults: Initialization complete after waiting.");
                await applyResults(message);
            } catch (initError) {
                console.error("[CS] displayResults: Error waiting for initialization:", initError);
                // 初期化に失敗した場合も、後で処理できるようにデータを保持します
                pendingDisplayData.push(message);
            }
        } else {
            await applyResults(message);
        }
    })();
    return false; // 応答不要
  }

  // --- callExtractTargetTexts: ターゲットテキスト抽出を要求された ---
  if (message.type === "callExtractTargetTexts") {
    console.log("[CS] Received callExtractTargetTexts message.");
    (async () => {
        if (!isInitialized && initializationPromise) {
            await initializationPromise;
        }
        if (!isInitialized) {
             try {
                 chrome.runtime.sendMessage({ type: 'targetTexts', targets: [], url: window.location.href, error: "Content script initialization failed" });
             } catch (e) { console.error("[CS] Failed to send initialization error to background:", e); }
             return;
        }
        await extractTargetTexts();
    })();
    return false;
  }

  // --- judgmentStatus: 判定ステータスに応じてインジケーターを操作 ---
  if (message.type === 'judgmentStatus') {
    if (message.status === 'processing') {
        showProcessingIndicator();
    } else if (message.status === 'complete') {
        removeProcessingIndicator();
    }
    return false; // 応答不要
  }

  // --- contentReady: background から初期化開始の合図 ---
  if (message.type === 'contentReady') {
    console.log("[CS] Received 'contentReady' message from background. Initializing...");
    initializeContentScript().then(() => { // 初期化完了後に保留データを処理
        console.log("[CS] Initialization promise resolved after contentReady.");
        // 修正点: 配列の長さをチェックし、ループですべての保留中データを処理します
        if (isInitialized && pendingDisplayData.length > 0) {
            console.log(`[CS] Applying ${pendingDisplayData.length} pending display data chunks after initialization.`);
            (async () => {
                for (const pendingMsg of pendingDisplayData) {
                    if (pendingMsg.results?.isFirstChunk) {
                        clearAllHighlights();
                        resnoTdMap = null;
                    }
                    await applyDisplayResults(pendingMsg);
                }
                pendingDisplayData = []; // 全て処理したのでクリア
            })();
        } else if (!isInitialized) {
            console.error("[CS] Initialization failed after contentReady.");
        }
    }).catch(err => {
        console.error("[CS] Error during initialization triggered by contentReady:", err);
    });
    sendResponse({status: "Initialization started"});
    return false;
  }

  // --- exclusionKeywords: 除外ワード(正規表現)を更新 ---
  if (message.type === 'exclusionKeywords') {
    console.log("[CS] Received updated exclusionKeywords:", message.keywords);
    // 修正: updateExclusionKeywords を使用
    updateExclusionKeywords(message.keywords);
    sendResponse({ status: "exclusionKeywords updated" });
    return false;
  }

  // --- 未知のメッセージタイプ ---
  sendResponse({});
  return false;
});


/**
 * Service Worker延命のための keepAlive メッセージ送信を管理する
 */
function manageKeepAlive() {
    // タイマーを開始する関数
    const startKeepAlive = () => {
        if (keepAliveIntervalId) return; // 既に開始している場合は何もしない
        console.log("[CS] Starting keepAlive interval (tab is visible).");
        keepAliveIntervalId = setInterval(() => {
            // console.log("[CS] Sending keepAlive message to background.");
            

            try {
                chrome.runtime.sendMessage({ type: 'keepAlive' });
            } catch (error) {
                // 拡張機能が無効化された場合などにエラーが発生するが、これは正常な挙動。
                // エラーをコンソールに出さずにタイマーを停止する。
                if (error.message.includes('Extension context invalidated')) {
                    stopKeepAlive(); // タイマーを停止して以降のエラーを防ぐ
                }
            }


        }, 10000); // 10秒間隔
    };

    // タイマーを停止する関数
    const stopKeepAlive = () => {
        if (keepAliveIntervalId) {
            console.log("[CS] Stopping keepAlive interval (tab is hidden).");
            clearInterval(keepAliveIntervalId);
            keepAliveIntervalId = null;
        }
    };

    // タブの表示状態が変更されたときのイベントリスナー
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            startKeepAlive();
        } else {
            stopKeepAlive();
        }
    });

    // 初期状態でタブが表示されていればタイマーを開始
    if (document.visibilityState === 'visible') {
        startKeepAlive();
    }
}

// スクリプトの読み込み完了時に keepAlive の管理を開始
manageKeepAlive();