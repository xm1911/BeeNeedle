/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */

const localLineTextCounts = new Map();
const elementRegistry = new Map(); // Map<HTMLElement, { textKey: string, quoteCount: number }>
const textToElementsMap = new Map(); // Map<string, HTMLElement[]>
// BGから同期されるメタデータ
let globalMetadata = {};

// --- サイトごとの設定 ---
const siteConfigs = {
  'bbs.animanch.com': {
    resContainerSelector: 'li.list-group-item',
    contentSelector: 'div.resbody',
    dateSelector: 'span.resposted',
    dateRegex: /(\d{2})\/(\d{2})\/(\d{2})\(.\)\s*(\d{2}):(\d{2}):(\d{2})/,
    parseDate: (match) => {
      const [, year, month, day, hour, min, sec] = match;
      const fullYear = parseInt(year, 10) + 2000;
      return new Date(fullYear, parseInt(month, 10) - 1, day, hour, min, sec).getTime();
    },
    lineDelimiter: 'p' // 行の区切りは<p>タグ
  },
  'animanch.com': {
    resContainerSelector: 'div.res',
    contentSelector: 'div.t_b',
    dateSelector: 'span.resdate',
    dateRegex: /(\d{4})\/(\d{2})\/(\d{2})\(.\)\s*(\d{2}):(\d{2}):(\d{2})/,
    parseDate: (match) => {
      const [, year, month, day, hour, min, sec] = match;
      return new Date(year, parseInt(month, 10) - 1, day, hour, min, sec).getTime();
    },
    lineDelimiter: 'br' // 行の区切りは<br>タグ
  },
  'default': { // 2chan.net (img.2chan.net, may.2chan.net)
    resContainerSelector: 'td.rtd',
    contentSelector: 'blockquote',
    dateSelector: '.cnw',
    dateRegex: /(\d{2})\/(\d{2})\/(\d{2})\(.\)(\d{2}):(\d{2}):(\d{2})/,
    parseDate: (match) => {
      const [, year, month, day, hour, min, sec] = match;
      const fullYear = parseInt(year, 10) + 2000;
      return new Date(fullYear, parseInt(month, 10) - 1, day, hour, min, sec).getTime();
    },
    lineDelimiter: 'br' // 行の区切りは<br>タグ
  }
};

// 現在のホスト名に合った設定を選択
const config = siteConfigs[location.hostname] || siteConfigs['default'];


// --- ヘルパー関数 ---

/**
 * 要素がポップアップ内にあるか判定する
 */
function isInsidePopup(element) {
  // 2chan.netの引用ポップアップ(div.qtd)や、その他のツールによるポップアップを検出
  const popupContainer = element.closest('div.qtd, div.fvw_respop, div[style*="position: absolute"]');
  return popupContainer !== null;
}

/**
 * ページ上のレスを再スキャンし、内部マップを再構築する
 */
function rescanAndBuildMaps() {
  // 既存のマップをクリア
  localLineTextCounts.clear();
  textToElementsMap.clear();

  // 処理済みフラグをリセット
  document.querySelectorAll('[data-bns-processed="true"]').forEach(el => {
    el.removeAttribute('data-bns-processed');
  });

  // ページ上のすべてのレスコンテナを対象に、再度データ抽出を実行
  const allResContainers = document.querySelectorAll(config.resContainerSelector);
  allResContainers.forEach(resContainer => {
    // extractDataFromContainerはDOMを読み取り、マップを更新する
    extractDataFromContainer(resContainer);
  });
}


/**
 * テキストキー生成のために、文字列を高度に正規化する。
 * @param {string} text - 入力文字列
 * @returns {string} 正規化された文字列
 */
function normalizeTextForKey(text) {
  let normalizedText = text;

  // ステップ1: 基本的な正規化 (全角→半角、大文字→小文字)
  normalizedText = normalizedText.replace(/[！-～]/g, (s) => {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  }).toLowerCase();

  // ステップ2: 意味を破壊しにくい装飾的な記号を除去
  // 括弧類、一部の記号（★☆◆◇・）などを除去
  normalizedText = normalizedText.replace(/[「」『』【】()（）★☆◆◇・]/g, '');

  // ステップ3: 揺れやすい記号を統一する
  // リーダー（三点リーダー）や波線などを統一
  normalizedText = normalizedText.replace(/[…‥]/g, '...'); // 2点、3点リーダーを半角ピリオド3つに
  normalizedText = normalizedText.replace(/～/g, '~'); // 波線をチルダに

  // 注意: 算術記号(+-*/=)、比較記号(<>)、句読点(、。?!)、
  // 顔文字で多用される記号(_^;:)などは、意味を破壊するリスクが高いため、
  // この段階では意図的に除去・統一していません。

  return normalizedText;
}


/**
 * HTML文字列からテキストを抽出・整形する。引用符は保持し、見えない文字を除去する。
 */
function processLineText(lineHtml) {
  const div = document.createElement('div');
  div.innerHTML = lineHtml.replace(/&gt;/g, '>');
  
  // アンカーリンク(>>)を除外
  const reslinks = div.querySelectorAll('a.reslink');
  reslinks.forEach(link => link.remove());

  let cleanText = div.textContent || div.innerText || '';


  // 1. Unicode正規化 (NFC形式)
  cleanText = cleanText.normalize('NFC');

  // 2. 制御文字(Cc)のうち、\n, \r, \t を除くものを一括除去
  cleanText = cleanText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

  // 3. その他のほぼ確実に不審な文字 (Cf, Co, Cn)
  cleanText = cleanText.replace(/\p{Cf}|\p{Co}|\p{Cn}/gu, '');

  // 4. まぎらわしい空白（Zs）を通常の半角スペースに統一
  cleanText = cleanText.replace(/[\u00A0\u115F\u1160\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u2800\u3164]+/g, ' ');

  // 5. 異体字セレクタ (VS1〜VS16: U+FE00–U+FE0F) と
  //    字形選択子補助 (VS17〜VS256: U+E0100–U+E01EF) を除去
  cleanText = cleanText.replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, '');

  // 6. 結合文字(M)を除去
  cleanText = cleanText.replace(/\p{M}/gu, '');

  // 7. 画像ファイル拡張子のかたまりをスペースに
  cleanText = cleanText.replace(/\.(?:jpe?g|png|gif)/gi, ' ');

  // 8. 連続する空白（半角・全角）を１つの半角スペースにまとめ、両端トリム
  cleanText = cleanText.replace(/[\s\u3000]+/g, ' ').trim();

  // ★追加: 最終的なテキストキーのために正規化処理を適用
  return normalizeTextForKey(cleanText);
}

/**
 * レスコンテナ要素から投稿日時のタイムスタンプをパースする
 */
function parseTimestamp(resContainerElement) {
  const dateElement = resContainerElement.querySelector(config.dateSelector);
  if (!dateElement) return 0;

  const text = dateElement.textContent;
  const match = text.match(config.dateRegex);
  if (!match) return 0;

  return config.parseDate(match);
}


/**
 * ページ上のすべてのレスのハイライトを再適用する。
 * オリジンと重複を区別するロジックを追加。
 */
function reapplyAllHighlights() {
  // 1. 常に不審と見なす文字のパターン
  const alwaysSuspiciousPart =
    '[' +
    '\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F' +      // 制御文字(\n\r\t除く)
    '\\u00A0\\u115F\\u1160\\u1680\\u180E\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u2800\\u3164' + // 紛らわしい空白
    ']|' +
    '\\p{Cf}|\\p{Co}|\\p{Cn}|' +                  // 不審なUnicodeプロパティ (異体字セレクタは除く)
    '(\\P{M})(\\p{M}{4,})';                       // Zalgoテキスト (過剰な結合文字)

  // 2. 文脈によって不審と見なす文字（異体字セレクタ等）のパターン
  const contextSuspiciousPart =
    '(?<![\\p{Emoji}\\u200D\\uFE00-\\uFE0F\\u{E0100}-\u{E01EF}])' + // 直前が絵文字等ではない場合に限り...
    '[\\uFE00-\\uFE0F\\u{E0100}-\u{E01EF}]';                       // ...異体字セレクタ等にマッチ

  // 1と2を結合して、最終的な不審文字検出パターンを作成
  const suspiciousPattern = new RegExp(
    `${alwaysSuspiciousPart}|${contextSuspiciousPart}`,
    'u'
  );

  // 見えない不審文字の判定には、文脈依存パターンをそのまま利用
  const invisibleSuspiciousPattern = new RegExp(contextSuspiciousPart, 'u');


  // --- DOM生存確認と再スキャン ---
  let needsRescan = false;
  for (const elements of textToElementsMap.values()) {
    for (const el of elements) {
      if (!document.body.contains(el)) {
        needsRescan = true;
        break;
      }
    }
    if (needsRescan) break;
  }

  if (needsRescan) {
    console.log("BNS-C: DOM inconsistency detected. Rescanning...");
    rescanAndBuildMaps();
  }

  // --- ハイライトのリセット処理 ---
  document.querySelectorAll('.bns-highlight-base').forEach(el => {
    // ★変更点: C-invisible-suspiciousクラスもリセット対象に追加
    el.classList.remove('bns-highlight-base', 'C-internal', 'C-internal-origin', 'C-external', 'C-suspicious', 'C-invisible-suspicious');
    el.style.removeProperty('--quote-offset');
  });

  // --- ハイライトの適用処理 ---
  for (const [textKey, elements] of textToElementsMap.entries()) {
    const isInternalDuplicate = (localLineTextCounts.get(textKey) || 0) > 1;
    const originElement = isInternalDuplicate ? elements.find(el => document.body.contains(el)) : null;

    elements.forEach(element => {
      if (!document.body.contains(element)) return;

      let needsHighlight = false;
      const textContent = element.textContent || '';

      // ★変更点: 不審文字の判定ロジックを2段階に
      // 1. 通常の不審文字の判定
      if (suspiciousPattern.test(textContent)) {
        element.classList.add('C-suspicious');
        needsHighlight = true;
      }
      
      // 2. 見えない不審文字の判定
      if (invisibleSuspiciousPattern.test(textContent)) {
        // C-suspiciousも併せて付与し、基本的なスタイルを継承させる
        element.classList.add('C-suspicious', 'C-invisible-suspicious');
        needsHighlight = true;
      }

      if (isInternalDuplicate) {
        if (element === originElement) {
          element.classList.add('C-internal-origin');
        } else {
          element.classList.add('C-internal');
        }
        needsHighlight = true;
      }

      const meta = globalMetadata[textKey];
      if (meta && meta.isExternal && meta.originUrl !== location.href) {
        element.classList.add('C-external');
        needsHighlight = true;
      }

      if (needsHighlight) {
        element.classList.add('bns-highlight-base');
        const quoteMatch = textContent.match(/^(>|&gt;)+/);
        const quoteCount = quoteMatch ? quoteMatch[0].replace(/&gt;/g, '>').length : 0;
        const offsetValue = quoteCount > 0 ? `${quoteCount * 0.0}em` : '0em';
        element.style.setProperty('--quote-offset', offsetValue);
      }
    });
  }
}

/**
 * レスコンテナからデータを抽出し、マップを構築する。
 */
function extractDataFromContainer(resContainer) {
  // ポップアップ内のレスは処理対象外とする
  if (isInsidePopup(resContainer)) {
    return { pageTextData: [], needsInternalRescan: false };
  }
  const contentElement = resContainer.querySelector(config.contentSelector);
  if (!contentElement || contentElement.dataset.bnsProcessed) {
    return { pageTextData: [], needsInternalRescan: false };
  }
  contentElement.dataset.bnsProcessed = 'true';

  const timestamp = parseTimestamp(resContainer);
  const newPageTextData = [];
  let needsInternalRescan = false;

  const processLine = (lineElement, lineHtml) => {

    lineElement.classList.add('bns-line-element');

    const textKey = processLineText(lineHtml);
    if (!textKey) return;
    if (!textToElementsMap.has(textKey)) textToElementsMap.set(textKey, []);
    textToElementsMap.get(textKey).push(lineElement);
    const count = localLineTextCounts.get(textKey) || 0;
    localLineTextCounts.set(textKey, count + 1);
    newPageTextData.push([textKey, timestamp]);
    if (count === 1) needsInternalRescan = true;
  };

  if (config.lineDelimiter === 'p') {
    contentElement.querySelectorAll('p').forEach(p => processLine(p, p.innerHTML));
  } else {
    const originalNodes = Array.from(contentElement.childNodes);
    contentElement.innerHTML = '';
    let currentLineNodes = [];

    const wrapAndProcessCurrentLine = () => {
      if (currentLineNodes.length === 0) return;
      const firstNode = currentLineNodes[0];
      if (currentLineNodes.length === 1 && firstNode.nodeName === 'SPAN' && firstNode.style.fontWeight === 'bold') {
        const addonB_span = firstNode;
        contentElement.appendChild(addonB_span);
        processLine(addonB_span, addonB_span.innerHTML);
      } else {
        const lineWrapper = document.createElement('span');
        currentLineNodes.forEach(node => lineWrapper.appendChild(node));
        contentElement.appendChild(lineWrapper);
        processLine(lineWrapper, lineWrapper.innerHTML);
      }
      currentLineNodes = [];
    };

    originalNodes.forEach(node => {

      const isQuoteNode = node.nodeName === 'FONT' && (node.textContent || '').trim().startsWith('>');
      const isBoldedQuoteSpan = node.nodeName === 'SPAN' && node.style.fontWeight === 'bold' && (node.textContent || '').trim().startsWith('>');

      if (isQuoteNode || isBoldedQuoteSpan) {
        // 引用文の場合、それまでの通常行を処理
        wrapAndProcessCurrentLine();
        // 引用文ノードはラップせず、そのままハイライト対象として処理
        contentElement.appendChild(node);
        processLine(node, node.innerHTML);
      } else if (node.nodeName === 'BR') {
        wrapAndProcessCurrentLine();
        contentElement.appendChild(node);
      } else {
        currentLineNodes.push(node);
      }
    });
    wrapAndProcessCurrentLine();
  }
  return { pageTextData: newPageTextData, needsInternalRescan };
}


// --- メイン処理 ---

/**
 * ページ内の全レスをスキャンし、テキストを抽出・BGと同期する
 */
function scanAndProcessAll() {
  const allResContainers = document.querySelectorAll(config.resContainerSelector);
  let pageTextData = [];
  let needsInternalRescan = false;

  allResContainers.forEach(resContainer => {
    const result = extractDataFromContainer(resContainer);
    pageTextData = pageTextData.concat(result.pageTextData);
    if (result.needsInternalRescan) {
      needsInternalRescan = true;
    }
  });

  // 初回スキャン後に一度ハイライトを適用
  if (needsInternalRescan) {
    reapplyAllHighlights();
  }

  if (pageTextData.length > 0) {
    chrome.runtime.sendMessage({
      action: 'SYNC_TEXT_DATA',
      data: pageTextData
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("C-CS: ", chrome.runtime.lastError.message);
        return;
      }
      // BGからのデータ同期はonMessageリスナーに任せる
    });
  }
}

/**
 * DOMの動的な変更を監視する
 */
function initMutationObserver() {
  const observer = new MutationObserver((mutationsList) => {
    let newPageTextData = [];
    let needsInternalRescan = false;

    for (const mutation of mutationsList) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          const resContainers = node.matches(config.resContainerSelector) ?
            [node] :
            node.querySelectorAll(config.resContainerSelector);

          resContainers.forEach(resContainer => {
            const result = extractDataFromContainer(resContainer);
            newPageTextData = newPageTextData.concat(result.pageTextData);
            if (result.needsInternalRescan) {
              needsInternalRescan = true;
            }
          });
        });
      }
    }

    // 動的に追加された要素のハイライトを即時反映
    if (needsInternalRescan) {
      reapplyAllHighlights();
    }

    if (newPageTextData.length > 0) {
      try {
        chrome.runtime.sendMessage({
          action: 'SYNC_TEXT_DATA',
          data: newPageTextData
        }); // レスポンスはonMessageで処理するのでここでは不要
      } catch (e) {
        if (e.message.includes('Extension context invalidated')) {
          observer.disconnect();
        } else {
         // console.error("C-CS: Unexpected error on sendMessage:", e);
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

/**
 * Background Scriptからのメッセージを処理する
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SYNC_METADATA') {
    globalMetadata = request.metadata;
    reapplyAllHighlights();
    sendResponse({}); // 非同期処理が完了したことを伝える
  }
  return true; // 非同期でsendResponseを呼ぶことを示す
});

// --- 実行開始 ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    scanAndProcessAll();
    initMutationObserver();
  });
} else {
  scanAndProcessAll();
  initMutationObserver();
}