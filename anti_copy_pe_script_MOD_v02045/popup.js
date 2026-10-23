/**
 * This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.
 * For more information, see the LICENSE file.
 */

// 判定開始ボタン
const startButton = document.getElementById('startButton');
// 処理状況表示
const statusDisplay = document.getElementById('status');
// ターゲット件数表示
const countDisplay = document.getElementById('count');

// 判定/再判定開始ボタンのクリックイベント (変更なし)
startButton.addEventListener('click', async () => {
  statusDisplay.textContent = '処理要求中...'; // メッセージ変更
  countDisplay.textContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url) { // URLもチェック
        throw new Error("アクティブなタブ情報が取得できません。");
    }
    // background に処理を依頼
    chrome.runtime.sendMessage({
      type: 'startJudgment',
      tabId: tab.id,
      url: tab.url
    });
    statusDisplay.textContent = '判定処理中...'; // 要求送信後のメッセージ
  } catch (error) {
    console.error("Error sending startJudgment message:", error);
    statusDisplay.textContent = `エラー: ${error.message}`;
  }
});



// background.jsからのメッセージ受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'judgmentComplete') {
    // エラーメッセージの表示
    if (message.error) {
        statusDisplay.textContent = `${message.error}`;
        statusDisplay.style.color = 'red';
        countDisplay.textContent = '';
        // console.error("Judgment completed with error:", message.error);
    } else {
        statusDisplay.textContent = '完了';
        statusDisplay.style.color = '';


        if (message.summary) {
            const { totalSuspicious, byKeyword, byReference, byTarget } = message.summary;
            let summaryText = `疑わしい件数: ${totalSuspicious}`;
            
            // 内訳を生成 (0件のものは表示しない)
            if (totalSuspicious > 0) {
                const details = [];
                if (byReference > 0) details.push(`参照:${byReference}`);
                if (byTarget > 0) details.push(`ターゲット間:${byTarget}`);
                if (byKeyword > 0) details.push(`キーワード:${byKeyword}`);
                
                if (details.length > 0) {
                    summaryText += ` (${details.join(', ')})`;
                }
            }
            countDisplay.textContent = summaryText;
        } else {
            // 古い形式のメッセージのためのフォールバック
            countDisplay.textContent = `処理件数: ${message.totalCount || 0}`;
        }
        
    }
  } else if (message.type === 'processing') {
    statusDisplay.textContent = '処理中...';
    statusDisplay.style.color = '';
  }
});

