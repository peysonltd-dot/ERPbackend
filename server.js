const express = require('express');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 10000; // Render 預設慣用 Port

// ==========================================
// 1. 初始化 Firebase Admin SDK (雲端最高權限)
// ==========================================
// 透過 Render 環境變數讀取 Firebase 伺服器金鑰
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ==========================================
// 2. 初始化 Gemini AI
// ==========================================
// 透過 Render 環境變數讀取 Google API Key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// 3. 核心邏輯：監聽 Firestore 待辦任務
// ==========================================
console.log("🚀 雲端 AI 機器人已啟動，正在監聽待辦任務...");

// 24 小時監聽 products 集合中，狀態為 'pending' (待處理) 的資料
db.collection('products').where('status', '==', 'pending').onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
            const docId = change.doc.id;
            const docData = change.doc.data();
            console.log(`📦 收到新任務: ${docId}`);

            try {
                // 步驟 A：標記為處理中，避免重複執行
                await db.collection('products').doc(docId).update({ status: 'processing' });

                // 步驟 B：準備沛森專屬的 AI 系統指令 (System Prompt)
                const systemPrompt = `
你是一位隸屬於「沛森 (Peyson Ltd)」的資深 B2B 企業禮品文案行銷專家。沛森專注於提供高質感的「企業客製禮贈品」、「IP 周邊製作」以及獨特的「活動現場客製 LIVE PRINT」服務。

【品牌口吻與風格設定】
1. 專業且具溫度：強調禮品能傳遞品牌價值與真實連結。
2. B2B 導向：主要受眾為企業採購、公關行銷人員、活動策展團隊。
3. 突顯工藝：自然帶入沛森的專業加工技術，強調「少量也能做、精緻有質感」。
4. 絕對禁忌：嚴禁提及任何價格、售價、數字金額。嚴格剔除大陸用語（如：質量、定制、打印），請使用台灣慣用電商用語（如：品質、客製、列印）。

【內容結構與格式要求】
- 商品名稱 (title)：精煉且具吸引力。
- 商品摘要 (summary)：**必須**使用全形黑點「・」進行條列式排版。除了商品本身規格外，請務必根據情境自然加入沛森的優勢，例如：「・少量客製，1件起訂」、「・專屬企業LOGO客製」、「・可在活動現場客製化印製」。
- 詳細描述 (description)：需包含「產品特色介紹」、「適用場景（如尾牙、展會、VIP贈禮）」等段落。繁體中文版結尾**必須固定加上**：「※ 企業採購如需索取樣品、確認起訂量或正式報價，請聯繫沛森專員。」
- SEO：精準打中企業採購與客製化禮品的搜尋痛點。

【輸出格式限制】
你必須以「純 JSON 格式」輸出，嚴禁包含任何 Markdown 標籤 (如 \`\`\`json) 或其他說明文字。JSON 必須精準包含以下 Key：
{
  "handle": "英文與數字組合的商品網址代稱(如 custom-thermos-mug)",
  "title_en": "英文商品名稱",
  "title_zh": "繁體中文商品名稱",
  "summary_en": "英文商品摘要 (使用・列點)",
  "summary_zh": "繁體中文商品摘要 (使用・列點)",
  "description_en": "英文詳細描述 (使用純文字搭配換行符號 \\n)",
  "description_zh": "繁體中文詳細描述 (使用純文字搭配換行符號 \\n)",
  "seo_title_en": "英文 SEO 標題",
  "seo_title_zh": "繁體中文 SEO 標題",
  "seo_desc_en": "英文 SEO 簡介",
  "seo_desc_zh": "繁體中文 SEO 簡介",
  "seo_keywords": "SEO 關鍵字 (中英皆可，以逗號分隔)"
}
`;

                const userPrompt = `
請根據以下 1688 原始資料，轉換為沛森的商品文案：
- 支援客製化工藝：${docData.customOptions}
- 企業起訂量 (MOQ)：${docData.moq}
- 原始文字資料：${docData.rawText || '無文字，請專注分析圖片規格'}
`;

                const parts = [
                    { text: systemPrompt },
                    { text: userPrompt }
                ];

                // 步驟 C：如果有圖片，將圖片抓下來轉成 Base64 交給 Gemini 分析
                if (docData.imageUrl) {
                    console.log(`🖼️ 正在讀取圖片...`);
                    const response = await fetch(docData.imageUrl);
                    const buffer = await response.buffer();
                    parts.push({
                        inlineData: {
                            data: buffer.toString('base64'),
                            mimeType: response.headers.get('content-type') || 'image/jpeg'
                        }
                    });
                }

                // 步驟 D：呼叫 Gemini AI
                console.log(`🧠 正在呼叫 Gemini 模型 (${docData.aiModel || 'gemini-1.5-pro'})...`);
                const model = genAI.getGenerativeModel({ model: docData.aiModel || 'gemini-1.5-pro' });
                const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
                
                // 步驟 E：清理與解析 AI 回傳的 JSON 格式
                let rawText = result.response.text();
                // 移除前後可能帶有的 Markdown json 標籤
                rawText = rawText.replace(/^```json/mi, '').replace(/```$/m, '').trim();
                const aiResult = JSON.parse(rawText);

                // 步驟 F：將完美轉換的結果寫回 Firebase，狀態改為 'completed'
                await db.collection('products').doc(docId).update({
                    status: 'completed',
                    aiResult: aiResult,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ 任務完成: ${docId}`);

            } catch (error) {
                console.error(`❌ 任務失敗 ${docId}:`, error);
                // 發生錯誤時，將狀態改為 'error' 並記錄錯誤訊息，前端就不會無止盡等待
                await db.collection('products').doc(docId).update({ 
                    status: 'error', 
                    errorMsg: error.message,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }
    }
});

// ==========================================
// 4. 啟動 Web Server (為了讓 Render 偵測到服務存活)
// ==========================================
app.get('/', (req, res) => {
  res.send('Peyson AI Worker is running securely!');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
