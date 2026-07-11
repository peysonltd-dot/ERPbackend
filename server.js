const express = require('express');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// 1. 初始化 Firebase Admin SDK
// ==========================================
// 注意：這裡使用環境變數來讀取金鑰，確保安全
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ==========================================
// 2. 初始化 Gemini API
// ==========================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// 3. 核心邏輯：監聽 Firestore 待辦任務
// ==========================================
console.log("🚀 雲端 AI 機器人已啟動，正在監聽待辦任務...");

db.collection('products').where('status', '==', 'pending').onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
            const docId = change.doc.id;
            const docData = change.doc.data();
            console.log(`📦 收到新任務: ${docId}`);

            try {
                // 標記為處理中，避免重複執行
                await db.collection('products').doc(docId).update({ status: 'processing' });

                // 準備 AI Prompt
                const prompt = `你是一個 B2B 企業禮品採購專家。請為 Shopline 上架編寫文案。
                - 支援工藝：${docData.customOptions}。起訂量：${docData.moq}。不可出現價格。
                - 文字資料：${docData.rawText || '無文字，請參考圖片'}
                必須回傳嚴格的 JSON 格式，包含: title_zh, description_zh。不可有 markdown 標記。`;

                const parts = [{ text: prompt }];

                // 如果有圖片，抓取圖片轉給 Gemini
                if (docData.imageUrl) {
                    const response = await fetch(docData.imageUrl);
                    const buffer = await response.buffer();
                    parts.push({
                        inlineData: {
                            data: buffer.toString('base64'),
                            mimeType: response.headers.get('content-type') || 'image/jpeg'
                        }
                    });
                }

                // 呼叫 Gemini
                const model = genAI.getGenerativeModel({ model: docData.aiModel || 'gemini-1.5-pro' });
                const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
                let rawText = result.response.text().replace(/^```json/mi, '').replace(/```$/m, '').trim();
                const aiResult = JSON.parse(rawText);

                // 將結果寫回 Firebase，狀態改為 completed
                await db.collection('products').doc(docId).update({
                    status: 'completed',
                    aiResult: aiResult,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ 任務完成: ${docId}`);

            } catch (error) {
                console.error(`❌ 任務失敗 ${docId}:`, error);
                await db.collection('products').doc(docId).update({ status: 'error', errorMsg: error.message });
            }
        }
    }
});

// Render 需要一個 Web Server 綁定 Port 才會認為部署成功
app.get('/', (req, res) => {
  res.send('Peyson AI Worker is running!');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});