/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */

const SCRIPT_VERSION_CS = "A2_cs";

let savedFullTextSet = new Set();
let savedLineTextSet = new Set();
let mutationObserver = null;

// --- テキスト処理関数 ---

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


function processFullTextForSaving(htmlContent) {
  // 1. <br>タグを改行コードに置換
  const htmlWithBreaks = htmlContent.replace(/<br\s*\/?>/gi, '\n');
  const div = document.createElement('div');
  div.innerHTML = htmlWithBreaks;
  let text = div.textContent || div.innerText || '';

  // 2. Unicode正規化 (NFC)
  text = text.normalize('NFC');

  // 3. 制御文字（改行・タブ以外）とフォーマット用文字 (Cf/Co/Cn) を削除
  text = text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/\p{Cf}|\p{Co}|\p{Cn}/gu, '');

  // 4. 異体字セレクタ (VS1〜VS16: U+FE00–U+FE0F) と
  //    字形選択子補助 (VS17〜VS256: U+E0100–U+E01EF) を除去
  text = text.replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, '');

  // 5. 各種空白 (Zs + 全角スペース) を半角スペースに統一
  text = text.replace(/[\u00A0\u115F\u1160\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u2800\u3164]+/g, ' ');

  // 6. 結合文字 (Mカテゴリ) を削除
  text = text.replace(/\p{M}/gu, '');

  // 7. 画像ファイル拡張子 (.jpg/.jpeg/.png/.gif) を一括除去
  text = text.replace(/\.(?:jpe?g|png|gif)/gi, ' ');

  // 8. 余分な空白・改行の調整
  text = text
    .replace(/[ ]+/g, ' ')           // 複数の半角空白→1つ
    .replace(/[ \t]*\n[ \t]*/g, '\n') // 行頭行末の空白・タブを削除
    .replace(/\n{3,}/g, '\n\n')      // 空行が3つ以上→2つにまとめる
    .trim();

  // 9. テキストキー用の高度な正規化を適用 (★ここから変更)
  return normalizeTextForKey(text);
  // (★ここまで変更)
}



function processLineTextForSaving(lineHtml) {
  const div = document.createElement('div');
  div.innerHTML = lineHtml;
  let text = div.textContent || div.innerText || '';

  // NFC正規化
  text = text.normalize('NFC');

  // 制御文字（改行・タブ以外）と非表示フォーマット文字を削除
  text = text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/\p{Cf}|\p{Co}|\p{Cn}/gu, '')

    // 異体字セレクタ (VS1〜VS16: U+FE00–U+FE0F) と
    // 字形選択子補助 (VS17〜VS256: U+E0100–U+E01EF) を除去
    .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, '')

    // 空白統一（Zsカテゴリー＋全角スペース → 半角）
    .replace(/[\u00A0\u115F\u1160\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u2800\u3164]+/g, ' ')

    // 結合文字を除去
    .replace(/\p{M}/gu, '')

    // 画像拡張子を一括除去（ケースインセンシティブ）
    .replace(/\.(?:jpe?g|png|gif)/gi, ' ')

    // 余分な空白をまとめてトリム
    .replace(/[\s]+/g, ' ')
    .trim();

  // テキストキー用の高度な正規化を適用 (★ここから変更)
  return normalizeTextForKey(text);
  // (★ここまで変更)
}


// --- メッセージ送信 (リトライ機能付き) ---
function sendMessageWithRetry(message, callback, retryCount = 0) {
  const MAX_RETRIES = 5; // 少し多めに
  const RETRY_DELAY = 600;

  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      console.error(`[${SCRIPT_VERSION_CS}] Error sending message (Action: ${message.action}):`, chrome.runtime.lastError.message);
      if (retryCount < MAX_RETRIES && chrome.runtime.lastError.message.includes("Receiving end does not exist")) {
        console.log(`[${SCRIPT_VERSION_CS}] Retrying action '${message.action}' due to 'Receiving end does not exist' (Attempt ${retryCount + 2})`);
        setTimeout(() => sendMessageWithRetry(message, callback, retryCount + 1), RETRY_DELAY * (retryCount + 1));
      } else if (typeof callback === 'function') {
        callback(null, chrome.runtime.lastError);
      }
      return;
    }

    if (response) {
      if (response.error && (response.error.includes("Data not loaded") || response.error.includes("Internal data error"))) {
        console.warn(`[${SCRIPT_VERSION_CS}] Received '${response.error}' for action '${message.action}'.`);
        if (retryCount < MAX_RETRIES) {
          console.log(`[${SCRIPT_VERSION_CS}] Retrying action '${message.action}' in ${RETRY_DELAY}ms... (Attempt ${retryCount + 2})`);
          setTimeout(() => sendMessageWithRetry(message, callback, retryCount + 1), RETRY_DELAY);
        } else {
          console.error(`[${SCRIPT_VERSION_CS}] Failed action '${message.action}' after ${MAX_RETRIES + 1} attempts due to persistent error: ${response.error}.`);
          if (typeof callback === 'function') callback(response, null);
        }
      } else if (response.error) {
        console.error(`[${SCRIPT_VERSION_CS}] Received error for action '${message.action}': ${response.error}`);
        if (typeof callback === 'function') callback(response, null);
      } else {
        if (typeof callback === 'function') callback(response, null);
      }
    } else {
      console.warn(`[${SCRIPT_VERSION_CS}] Received unexpected null/undefined response for action '${message.action}'.`);
      if (retryCount < MAX_RETRIES) { // null応答もリトライ対象に含める場合
          console.log(`[${SCRIPT_VERSION_CS}] Retrying action '${message.action}' due to null response (Attempt ${retryCount + 2})`);
          setTimeout(() => sendMessageWithRetry(message, callback, retryCount + 1), RETRY_DELAY);
      } else if (typeof callback === 'function') {
        callback(null, new Error("Unexpected null response from background after retries."));
      }
    }
  });
}

function applyHighlightToElement(el) {

  // 既にハイライト処理済みの場合はスキップ
  if (el.dataset.beeneedleBHighlighted) {
    return;
  }

  // --- 全文一致判定 (変更なし) ---
  const fullText = processFullTextForSaving(el.innerHTML);
  if (fullText.length > 0 && savedFullTextSet.has(fullText)) {
    el.style.setProperty('color', 'red', 'important');
    el.style.setProperty('font-weight', 'bold', 'important');
    el.dataset.beeneedleBHighlighted = 'full';
    return;
  }

  // --- 行一致判定 ---
  const lineElements = el.querySelectorAll('.bns-line-element');

  // 併用アドオンが存在する場合のロジック (従来通り)
  if (lineElements.length > 0) {
    let hasLineMatch = false;
    lineElements.forEach(lineEl => {
      if (lineEl.dataset.bnsBLineProcessed) return;

      const lineTextForComparison = processLineTextForSaving(lineEl.innerHTML);
      if (lineTextForComparison.length > 0 && savedLineTextSet.has(lineTextForComparison)) {
        hasLineMatch = true;
        lineEl.dataset.bnsBLineProcessed = 'true'; // 処理済みフラグ

        // 行の種類を問わず、一律に太字にする
        lineEl.style.setProperty('font-weight', 'bold', 'important');

        // 引用文(<font>)でなければ、文字色を黒にする
        if (lineEl.nodeName !== 'FONT') {
          lineEl.style.setProperty('color', 'black', 'important');
        }
      }
    });

    if (hasLineMatch) {
      el.dataset.beeneedleBHighlighted = 'line';
    }
  }
  // 単独で動作する場合の新しいロジック
  else {
    // <br>タグで分割して行ごとのHTML配列を作成
    // (<br>と<br/>の両方に対応)
    const linesHTML = el.innerHTML.split(/<br\s*\/?>/i);
    const newLinesHTML = [];
    let hasLineMatch = false;

    linesHTML.forEach(lineHTML => {
      const lineTextForComparison = processLineTextForSaving(lineHTML);

      if (lineTextForComparison.length > 0 && savedLineTextSet.has(lineTextForComparison)) {
        hasLineMatch = true;
        
        // --- 変更ここから ---

        // 引用文（<font>タグで始まる行）かどうかを判定
        const isQuote = lineHTML.trim().toLowerCase().startsWith('<font');
        
        if (isQuote) {
          // 引用文の場合：<font>タグに直接スタイルを適用する
          // 一時的なDOM要素を作成し、HTML文字列を安全に操作する
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = lineHTML;
          const fontTag = tempDiv.querySelector('font');

          // fontタグが見つかった場合のみスタイルを適用
          if (fontTag) {
            fontTag.style.setProperty('font-weight', 'bold', 'important');
            // 変更後のHTMLを配列に追加
            newLinesHTML.push(tempDiv.innerHTML);
          } else {
            // 万が一fontタグが見つからない場合は、元のHTMLをそのまま追加（フォールバック）
            newLinesHTML.push(lineHTML);
          }
        } else {
          // 引用文でない場合：従来通りspanで囲む
          const style = 'font-weight: bold !important; color: black !important;';
          newLinesHTML.push(`<span style="${style}">${lineHTML}</span>`);
        }
        // --- 変更ここまで ---

      } else {
        // 一致しない行はそのまま追加
        newLinesHTML.push(lineHTML);
      }
    });

    // 一致する行があった場合のみ、DOMを書き換える
    if (hasLineMatch) {
      el.innerHTML = newLinesHTML.join('<br>');
      el.dataset.beeneedleBHighlighted = 'line';
    }
  }
}


// --- DOM監視 ---
function initMutationObserver() {
  if (mutationObserver) mutationObserver.disconnect(); // 既存のものを停止

  mutationObserver = new MutationObserver((mutationsList) => {
    let addedBlockquotes = [];
    for (const mutation of mutationsList) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'BLOCKQUOTE') {
              addedBlockquotes.push(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll('blockquote').forEach(bq => addedBlockquotes.push(bq));
            }
          }
        });
      }
    }

    if (addedBlockquotes.length > 0) {
      // console.log(`[${SCRIPT_VERSION_CS}] MutationObserver: Found ${addedBlockquotes.length} new blockquote(s).`);
      // 新しく追加された要素群をまとめて送信
      extractAndSendData(addedBlockquotes);

      // 強調表示 (img.2chan.net のみ)
      if (location.hostname === 'img.2chan.net' || location.hostname === 'may.2chan.net') {
        addedBlockquotes.forEach(el => {
          applyHighlightToElement(el);
        });
      }
    }
  });

  mutationObserver.observe(document.body, { childList: true, subtree: true });
  // console.log(`[${SCRIPT_VERSION_CS}] MutationObserver initialized.`);
}

// --- データ抽出と保存 ---
function extractAndSendData(elements) {
  const currentUrl = location.href;
  if (location.hostname === 'img.2chan.net' || location.hostname === 'may.2chan.net') return;
  if (!Array.isArray(elements) || elements.length === 0) return;

  const pageData = [];
  elements.forEach(el => {
    // 既に処理済みの要素はスキップ (MutationObserver用)
    if (el.dataset.beeneedleSaved) return;

    const htmlContent = el.innerHTML;
    const fullText = processFullTextForSaving(htmlContent);
    const linesHtml = htmlContent.split(/<br\s*\/?>/gi);
    const lineTexts = linesHtml
        .map(lineHtml => processLineTextForSaving(lineHtml))
        .filter(text => text.length > 0);

    if (fullText.length > 0 || lineTexts.length > 0) {
      pageData.push({
        fullText: fullText,
        lineTexts: lineTexts
      });
    }
    el.dataset.beeneedleSaved = 'true'; // 処理済みマーク
  });

  if (pageData.length > 0) {
    // console.log(`[${SCRIPT_VERSION_CS}] Sending ${pageData.length} block(s) of data to background.`);
    // 新しいアクション名 'savePageData' で一括送信
    sendMessageWithRetry(
      { action: 'savePageData', data: pageData, url: currentUrl },
      (response, error) => {
        if (error) console.error(`[${SCRIPT_VERSION_CS}] Error saving page data:`, error);
        // else console.log(`[${SCRIPT_VERSION_CS}] Page data save response:`, response?.message);
      }
    );
  }
}


// --- メイン処理 ---
function main() {
  // console.log(`[${SCRIPT_VERSION_CS}] main() called on ${location.href}`);

  sendMessageWithRetry({ action: 'isDataReady' }, (response, error) => {
    if (error || !response || !response.ready) {
      console.error(`[${SCRIPT_VERSION_CS}] Background not ready or error checking readiness. Aborting main. Error:`, error, "Response:", response);
      return;
    }
    // console.log(`[${SCRIPT_VERSION_CS}] Background confirmed ready.`);

    // 初期データの抽出と一括保存
    const initialElements = Array.from(document.querySelectorAll('blockquote'));
    extractAndSendData(initialElements);

    // 初期強調表示
    if (location.hostname === 'img.2chan.net' || location.hostname === 'may.2chan.net') {
      sendMessageWithRetry({ action: 'getTextSets' }, (response, error) => {
        if (error || !response || !response.fullTexts || !response.lineTexts) {
          console.error(`[${SCRIPT_VERSION_CS}] Failed to get initial text sets for highlighting:`, error, response);
        } else {
          savedFullTextSet = new Set(response.fullTexts);
          savedLineTextSet = new Set(response.lineTexts);
          document.querySelectorAll('blockquote').forEach(el => {
            applyHighlightToElement(el);
          });
        }
        initMutationObserver();
      });
    } else {
      initMutationObserver();
    }
  });
}

// DOM読み込み完了後に関数を実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}