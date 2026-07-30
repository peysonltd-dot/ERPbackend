const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const SERVICE_NAME = "Peyson AI Worker";
const WORKER_VERSION = "2.5.1";
const PORT = Number(process.env.PORT) || 10000;
const DEFAULT_MODEL = "gemini-3.6-flash";
const MODEL_FALLBACK = "gemini-flash-latest";
const MAX_CONCURRENT_JOBS = 2;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 120000;
const IMAGE_TIMEOUT_MS = 30000;
const MAX_API_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 15 * 60 * 1000;

const ALLOWED_MODELS = new Set([
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-flash-latest",
  "gemini-pro-latest",
]);

const ALLOWED_IMAGE_HOSTS = new Set([
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
]);

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
]);

const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    title_zh: {
      type: "string",
      description: "專業、自然的繁體中文商品名稱；不得加入來源未提供的規格。",
    },
    title_en: {
      type: "string",
      description: "與中文名稱事實一致的自然英文商品名稱。",
    },
    product_highlights_zh: {
      type: "array",
      items: { type: "string" },
      description: "2至6點繁體中文商品特色；採官網列點規格邏輯，優先列出 MOQ、尺寸、容量、重量、材質、功能與客製方式，每點只寫一項有來源依據、具有搜尋價值的資訊。",
    },
    product_highlights_en: {
      type: "array",
      items: { type: "string" },
      description: "與中文特色逐點對應的英文內容。",
    },
    description_zh: {
      type: "string",
      description: "適合台灣B2B搜尋與閱讀的精簡繁體中文純文字文案，不含價格、HTML、空泛口號或重複資訊。",
    },
    description_en: {
      type: "string",
      description: "與中文文案事實一致的英文純文字文案，不含價格與HTML。",
    },
    extracted: {
      type: "object",
      properties: {
        product_type: { type: "string" },
        material: { type: "string" },
        dimensions: { type: "string" },
        capacity: { type: "string" },
        weight: { type: "string" },
        colors: { type: "array", items: { type: "string" } },
        variants: { type: "array", items: { type: "string" } },
        supplier_moq: { type: "string" },
        customization: { type: "string" },
        certifications: { type: "array", items: { type: "string" } },
      },
      required: [
        "product_type",
        "material",
        "dimensions",
        "capacity",
        "weight",
        "colors",
        "variants",
        "supplier_moq",
        "customization",
        "certifications",
      ],
    },
    specifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label_zh: { type: "string" },
          label_en: { type: "string" },
          value: { type: "string" },
          source: {
            type: "string",
            description: "text、image_1、image_2、user_input 等來源標記。",
          },
        },
        required: ["label_zh", "label_en", "value", "source"],
      },
    },
    seo_title_zh: { type: "string" },
    seo_title_en: { type: "string" },
    seo_description_zh: { type: "string" },
    seo_description_en: { type: "string" },
    seo_keywords: { type: "array", items: { type: "string" } },
    missing_fields: {
      type: "array",
      items: { type: "string" },
      description: "來源沒有提供、上架前建議人工補充的欄位。",
    },
    conflicts: {
      type: "array",
      items: { type: "string" },
      description: "不同來源互相矛盾的資訊；沒有則回傳空陣列。",
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          value: { type: "string" },
          source: { type: "string" },
          raw_quote: {
            type: "string",
            description: "支持此欄位的短原文或圖片辨識文字。",
          },
        },
        required: ["field", "value", "source", "raw_quote"],
      },
    },
    confidence: {
      type: "number",
      description: "整體資料可信度，0到1。",
    },
  },
  required: [
    "title_zh",
    "title_en",
    "product_highlights_zh",
    "product_highlights_en",
    "description_zh",
    "description_en",
    "extracted",
    "specifications",
    "seo_title_zh",
    "seo_title_en",
    "seo_description_zh",
    "seo_description_en",
    "seo_keywords",
    "missing_fields",
    "conflicts",
    "evidence",
    "confidence",
  ],
};

const ENGLISH_SYNC_SCHEMA = {
  type: "object",
  properties: {
    title_en: { type: "string" },
    product_highlights_en: {
      type: "array",
      items: { type: "string" },
    },
    description_en: { type: "string" },
    seo_title_en: { type: "string" },
    seo_description_en: { type: "string" },
  },
  required: [
    "title_en",
    "product_highlights_en",
    "description_en",
    "seo_title_en",
    "seo_description_en",
  ],
};

const SYSTEM_INSTRUCTION = `
你是 Peyson 沛森顧問有限公司旗下「沛森禮品」的 B2B 商品資料整理與雙語文案助理。

工作原則：
1. 先從使用者提供的文字與圖片中辨識商品資訊，再撰寫繁體中文與英文文案。
2. 只能使用來源中明確出現的事實；不得自行猜測材質、尺寸、容量、重量、認證、產地、交期、庫存或供應商起訂量。
3. 圖片中的簡體中文可轉為台灣常用繁體中文，但數值、單位、型號與規格不可改變。
4. 圖片與文字矛盾時，不可擅自選一個答案，必須記錄在 conflicts。
5. 資料不足時使用空字串或空陣列，並把重要缺漏列入 missing_fields。
6. evidence 必須標示資訊來自 text、image_1、image_2 或 user_input，並保留簡短原文。
7. 使用者輸入的「目標 MOQ」是沛森希望提供客戶的目標，不可寫成供應商保證的 MOQ。
8. 不輸出任何價格、原價、計價方式、庫存數量、隱藏商品設定或付款承諾。
9. 所有文案以 SEO 搜尋意圖為優先：自然納入來源可證實的商品類型、材質、用途、客製工藝與企業禮贈品情境；關鍵字必須自然，不可堆疊。
10. 中文使用台灣繁體中文；英文內容必須與中文事實一致。
11. description 欄位只輸出純文字，不輸出 Markdown、HTML 或程式碼區塊。
12. 品牌名稱一律使用「沛森禮品」，公司正式名稱為「沛森顧問有限公司」；不得產生「沛森國際」或「沛森國際有限公司」。
13. 來源只寫「保溫」時，英文使用 insulated，不得自行延伸為 vacuum；只有來源明確寫出真空結構時才可使用 vacuum。
14. 商品特色採沛森官網既有的列點式規格邏輯，依資料完整度寫 2 至 6 點。優先排列：目標 MOQ、尺寸、容量、重量、材質與產品功能；沒有來源的欄位不要硬湊。
15. 商品描述使用自然敘述，說明外觀、使用方式、適用情境與企業採購用途；不得改用規格清單，也不可逐句重抄商品特色。
16. 禁止「質感升級、理想選擇、彰顯品味、精緻呈現、為您打造」等沒有具體資訊的空泛句；沒有新資訊就不要寫。
17. 商品特色與商品描述合計最多出現一次「沛森禮品」或「沛森顧問有限公司」；一般情況不要主動加入品牌名稱。SEO 欄位不受此限制。
18. 「印製工藝」與「活動現場客製」特色由 ERP 依使用者選項統一附加；AI 的商品特色與商品描述正文不得自行加入或重複這兩類句子。
19. 若 source_text 只有 1688 網址，該網址只是來源紀錄，不代表已讀取頁面；不得從網址猜測任何商品事實。
`;

const ENGLISH_SYNC_INSTRUCTION = `
你是 Peyson 沛森顧問有限公司旗下「沛森禮品」的雙語商品編輯。

請將使用者提供的最新繁體中文商品內容同步為自然、專業的英文，適合 B2B 企業禮贈品網站。

規則：
1. 英文必須忠實對應目前繁中內容，不得沿用舊英文內容。
2. 不得新增來源未提供的材質、尺寸、容量、重量、認證、產地、交期、價格、庫存或功能。
3. 中文只寫「保溫」時使用 insulated，不得擅自翻譯成 vacuum；只有中文明確寫「真空」時才可使用 vacuum。
4. 品牌名稱使用 Peyson Gifts；公司正式英文名稱使用 Peyson Consulting Co., Ltd.
5. product_highlights_en 必須與繁中特色逐點對應，數量及順序一致；保留列點式規格結構。
6. description_en 使用自然敘述，SEO 欄位使用自然英文；不輸出 Markdown、HTML 或額外說明。
7. 以 SEO 搜尋意圖為優先，使用具體商品詞、材質、用途與客製工藝；不得加入空泛銷售句或關鍵字堆疊。
8. 商品特色與商品描述不得重複同一資訊；兩者合計最多出現一次 Peyson Gifts 或 Peyson Consulting Co., Ltd.，SEO 欄位不受此限制。
9. 「印製工藝」與「活動現場客製」特色由 ERP 統一整理；若輸入中已有這兩類特色，忠實翻譯一次，不得另加同義句。
`;

function requireEnvironment() {
  const missing = ["FIREBASE_SERVICE_ACCOUNT", "GEMINI_API_KEY"].filter(
    (name) => !process.env[name]
  );

  if (missing.length > 0) {
    throw new Error(`缺少必要的 Render 環境變數：${missing.join(", ")}`);
  }
}

function parseServiceAccount(rawValue) {
  let parsed = JSON.parse(rawValue);

  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed);
  }

  if (typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  return parsed;
}

requireEnvironment();

const serviceAccount = parseServiceAccount(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    "https://peysonltd-dot.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(origin && allowedOrigins.has(origin) ? 204 : 403);
  }

  return next();
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(`${SERVICE_NAME} is running securely!`);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    version: WORKER_VERSION,
    defaultModel: DEFAULT_MODEL,
    firebase: "connected",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/sync-english", requireAuthenticatedUser, async (req, res) => {
  try {
    const englishInput = {
      title_zh: cleanText(req.body?.title_zh, 300),
      product_highlights_zh: Array.isArray(req.body?.product_highlights_zh)
        ? req.body.product_highlights_zh.map((item) => cleanText(item, 600)).slice(0, 12)
        : [],
      description_zh: cleanText(req.body?.description_zh, 8000),
      seo_title_zh: cleanText(req.body?.seo_title_zh, 300),
      seo_description_zh: cleanText(req.body?.seo_description_zh, 1000),
    };

    if (
      !englishInput.title_zh &&
      !englishInput.description_zh &&
      englishInput.product_highlights_zh.length === 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "請先提供繁中商品名稱或商品文案。",
      });
    }

    const generated = await generateEnglishSync(englishInput);
    return res.json({
      ok: true,
      result: sanitizeEnglishSyncCopy(generated.result),
      meta: {
        model: generated.model,
        usedFallback: generated.usedFallback,
        apiAttempts: generated.apiAttempts,
      },
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    console.error(
      `[English sync] uid=${req.user?.uid || "unknown"} error=${sanitizeError(error)}`
    );
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: sanitizeError(error),
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value, maxLength = 12000) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLength);
}

function stripNonSeoBrands(value) {
  return cleanText(value)
    .replace(/沛森顧問有限公司/g, "")
    .replace(/沛森禮品/g, "")
    .replace(/Peyson Consulting Co\.,?\s*Ltd\.?/gi, "")
    .replace(/Peyson Gifts/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。！？,.!?])/g, "$1")
    .trim();
}

function dedupeParagraphs(value) {
  const seen = new Set();
  return cleanText(value)
    .split(/\n+/)
    .map((paragraph) => stripNonSeoBrands(paragraph))
    .filter((paragraph) => {
      const key = paragraph.toLowerCase().replace(/\s+/g, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n\n");
}

function sanitizeProductCopy(result = {}) {
  const highlightsZh = Array.isArray(result.product_highlights_zh)
    ? result.product_highlights_zh
    : [];
  const highlightsEn = Array.isArray(result.product_highlights_en)
    ? result.product_highlights_en
    : [];
  const seen = new Set();
  const pairs = [];

  for (let index = 0; index < Math.max(highlightsZh.length, highlightsEn.length); index += 1) {
    const zh = stripNonSeoBrands(highlightsZh[index]);
    const en = stripNonSeoBrands(highlightsEn[index]);
    const key = (zh || en).toLowerCase().replace(/\s+/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ zh, en });
    if (pairs.length === 6) break;
  }

  return {
    ...result,
    product_highlights_zh: pairs.map((item) => item.zh),
    product_highlights_en: pairs.map((item) => item.en),
    description_zh: dedupeParagraphs(result.description_zh),
    description_en: dedupeParagraphs(result.description_en),
  };
}

function sanitizeEnglishSyncCopy(result = {}) {
  const seen = new Set();
  const highlights = (Array.isArray(result.product_highlights_en)
    ? result.product_highlights_en
    : [])
    .map((item) => stripNonSeoBrands(item))
    .filter((item) => {
      const key = item.toLowerCase().replace(/\s+/g, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);

  return {
    ...result,
    product_highlights_en: highlights,
    description_en: dedupeParagraphs(result.description_en),
  };
}

function sanitizeError(error) {
  return cleanText(error && error.message ? error.message : error, 1200)
    .replace(process.env.GEMINI_API_KEY, "[REDACTED]")
    .replace(/\s+/g, " ");
}

async function requireAuthenticatedUser(req, res, next) {
  const authorization = cleanText(req.headers.authorization, 5000);
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ ok: false, error: "缺少登入驗證資訊。" });
  }

  try {
    req.user = await getAuth().verifyIdToken(match[1]);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "登入驗證已失效，請重新登入。" });
  }
}

function resolveModel(requestedModel) {
  const requested = cleanText(requestedModel, 80);
  return ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;
}

function normalizeImageUrls(data) {
  const candidates = [];

  if (Array.isArray(data.sourceImages)) {
    candidates.push(...data.sourceImages);
  }

  if (Array.isArray(data.imageUrls)) {
    candidates.push(...data.imageUrls);
  }

  if (data.imageUrl) {
    candidates.push(data.imageUrl);
  }

  const urls = candidates
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.downloadURL || item.url || item.src || "";
    })
    .map((url) => cleanText(url, 3000))
    .filter(Boolean);

  return [...new Set(urls)].slice(0, MAX_IMAGES);
}

function validateImageUrl(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("圖片網址格式不正確。");
  }

  if (url.protocol !== "https:") {
    throw new Error("圖片網址必須使用 HTTPS。");
  }

  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname)) {
    throw new Error(
      `目前只接受 Firebase Storage 圖片，無法讀取主機：${url.hostname}`
    );
  }

  return url.toString();
}

async function fetchImageAsInput(rawUrl, imageNumber) {
  const url = validateImageUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`圖片 ${imageNumber} 下載失敗（HTTP ${response.status}）。`);
    }

    let mimeType = cleanText(
      response.headers.get("content-type"),
      100
    ).split(";")[0];

    if (mimeType === "image/jpg") mimeType = "image/jpeg";

    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      throw new Error(`圖片 ${imageNumber} 的檔案類型不正確。`);
    }

    const declaredSize = Number(response.headers.get("content-length")) || 0;
    if (declaredSize > MAX_IMAGE_BYTES) {
      throw new Error(`圖片 ${imageNumber} 超過 4 MB，請先壓縮後再上傳。`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`圖片 ${imageNumber} 超過 4 MB，請先壓縮後再上傳。`);
    }

    return {
      bytes: bytes.length,
      input: {
        type: "image",
        data: bytes.toString("base64"),
        mime_type: mimeType,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function buildImageInputs(imageUrls) {
  const downloaded = await Promise.all(
    imageUrls.map((url, index) => fetchImageAsInput(url, index + 1))
  );

  const totalBytes = downloaded.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error("全部圖片合計超過 12 MB，請減少張數或先壓縮圖片。");
  }

  const inputs = [];
  downloaded.forEach((item, index) => {
    inputs.push({
      type: "text",
      text: `以下是 image_${index + 1}：`,
    });
    inputs.push(item.input);
  });

  return inputs;
}

function buildUserPrompt(data, imageCount) {
  const payload = {
    source_text: cleanText(data.rawText),
    current_category: cleanText(data.category, 200),
    peyson_target_moq: cleanText(data.moq, 100),
    requested_customization: cleanText(data.customOptions, 1000),
    image_count: imageCount,
  };

  return `
請依照系統規則整理以下商品資料，並嚴格依照指定 JSON Schema 回傳。

輸入資料：
${JSON.stringify(payload, null, 2)}

補充要求：
- current_category 是 ERP 已選分類，不要擅自改分類。
- peyson_target_moq 只可視為 user_input，不可填入 supplier_moq。
- peyson_target_moq 若大於 0，可在商品特色中寫成「最低訂購量：X 件」；requested_customization 只作為 ERP 欄位資料，不要自行寫入商品特色。
- 若圖片中包含售價或批發價，只忽略價格，不要把它寫入商品文案。
- 中英文特色需逐點對應；若某特色沒有可靠來源就不要寫。
- 商品特色使用列點式規格，優先列出 MOQ、尺寸、容量、重量、材質與功能；商品描述改用敘述式文案，兩者不要重複。
- source_text 中的網址只作為來源紀錄，無法證明頁面內容；不得把網址本身當作商品資料。
- 「印製工藝」與「活動現場客製」特色由 ERP 另行處理，正文不要自行加入。
`;
}

class GeminiApiError extends Error {
  constructor(message, status = 0, retryable = false) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

function extractInteractionText(responseBody) {
  if (typeof responseBody.output_text === "string") {
    return responseBody.output_text;
  }

  const texts = [];
  for (const step of responseBody.steps || []) {
    if (step.type !== "model_output") continue;
    for (const content of step.content || []) {
      if (content.type === "text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }

  return texts.join("");
}

async function callGeminiOnce(model, input, options = {}) {
  const {
    systemInstruction = SYSTEM_INSTRUCTION,
    responseSchema = PRODUCT_SCHEMA,
    maxOutputTokens = 8192,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          input,
          system_instruction: systemInstruction,
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: responseSchema,
          },
          generation_config: {
            temperature: 0.2,
            max_output_tokens: maxOutputTokens,
          },
          store: false,
        }),
      }
    );

    const responseText = await response.text();
    let responseBody = {};

    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new GeminiApiError(
        `Gemini 回傳非 JSON 格式（HTTP ${response.status}）。`,
        response.status,
        response.status >= 500
      );
    }

    if (!response.ok) {
      const message =
        responseBody.error?.message ||
        responseBody.message ||
        `Gemini API 呼叫失敗（HTTP ${response.status}）。`;
      const retryable = [408, 429, 500, 502, 503, 504].includes(
        response.status
      );
      throw new GeminiApiError(message, response.status, retryable);
    }

    if (responseBody.status && responseBody.status !== "completed") {
      throw new GeminiApiError(
        `Gemini 工作未完成，狀態：${responseBody.status}`,
        0,
        true
      );
    }

    const outputText = extractInteractionText(responseBody);
    if (!outputText) {
      throw new GeminiApiError("Gemini 沒有回傳可用文字。", 0, true);
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new GeminiApiError("Gemini 回傳內容無法解析為 JSON。", 0, true);
    }

    for (const requiredField of responseSchema.required || []) {
      if (!(requiredField in parsed)) {
        throw new GeminiApiError(
          `Gemini 結果缺少必要欄位：${requiredField}`,
          0,
          true
        );
      }
    }

    return {
      result: parsed,
      interactionId: responseBody.id || "",
      usage: responseBody.usage || {},
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new GeminiApiError("Gemini API 等待逾時。", 408, true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetries(model, input, options = {}) {
  const delays = [0, 2500, 7000];
  let lastError;

  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    if (delays[attempt - 1] > 0) {
      await sleep(delays[attempt - 1]);
    }

    try {
      const response = await callGeminiOnce(model, input, options);
      return { ...response, apiAttempts: attempt };
    } catch (error) {
      lastError = error;
      console.warn(
        `[Gemini] model=${model} attempt=${attempt}/${MAX_API_ATTEMPTS} status=${
          error.status || "n/a"
        } message=${sanitizeError(error)}`
      );

      if (!error.retryable || attempt === MAX_API_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function generateProductContent(requestedModel, input, options = {}) {
  const primaryModel = resolveModel(requestedModel);

  try {
    const response = await callWithRetries(primaryModel, input, options);
    return { ...response, model: primaryModel, usedFallback: false };
  } catch (error) {
    if (error.status !== 404 || primaryModel === MODEL_FALLBACK) {
      throw error;
    }

    console.warn(
      `[Gemini] model=${primaryModel} not found; falling back to ${MODEL_FALLBACK}`
    );
    const response = await callWithRetries(MODEL_FALLBACK, input, options);
    return { ...response, model: MODEL_FALLBACK, usedFallback: true };
  }
}

async function generateEnglishSync(englishInput) {
  const input = [
    {
      type: "text",
      text: `請依規則將以下最新繁中商品內容同步為英文，並嚴格按照 JSON Schema 回傳：\n${JSON.stringify(
        englishInput,
        null,
        2
      )}`,
    },
  ];

  return generateProductContent(DEFAULT_MODEL, input, {
    systemInstruction: ENGLISH_SYNC_INSTRUCTION,
    responseSchema: ENGLISH_SYNC_SCHEMA,
    maxOutputTokens: 4096,
  });
}

async function claimProduct(ref) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists || snapshot.data().status !== "pending") {
      return null;
    }

    const attemptCount = (Number(snapshot.data().attemptCount) || 0) + 1;

    transaction.update(ref, {
      status: "processing",
      processingStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      attemptCount,
      workerVersion: WORKER_VERSION,
      errorMsg: FieldValue.delete(),
    });

    return {
      data: snapshot.data(),
      attemptCount,
    };
  });
}

async function processProduct(ref) {
  const claimed = await claimProduct(ref);
  if (!claimed) return;

  const { data, attemptCount } = claimed;
  const imageUrls = normalizeImageUrls(data);
  const startedAt = Date.now();

  console.log(
    `[Job ${ref.id}] started images=${imageUrls.length} requestedModel=${cleanText(
      data.aiModel,
      80
    ) || "default"}`
  );

  try {
    if (!cleanText(data.rawText) && imageUrls.length === 0) {
      throw new Error("沒有可供 AI 分析的商品文字或圖片。");
    }

    const imageInputs = await buildImageInputs(imageUrls);
    const input = [
      {
        type: "text",
        text: buildUserPrompt(data, imageUrls.length),
      },
      ...imageInputs,
    ];

    const generated = await generateProductContent(data.aiModel, input);
    const result = {
      ...sanitizeProductCopy(generated.result),
      category: cleanText(data.category, 200),
      target_moq: cleanText(data.moq, 100),
      requested_customization: cleanText(data.customOptions, 1000),
    };

    await ref.update({
      aiResult: result,
      status: "completed",
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      errorMsg: FieldValue.delete(),
      aiMeta: {
        provider: "google",
        api: "interactions-v1beta",
        model: generated.model,
        requestedModel: cleanText(data.aiModel, 80),
        usedFallback: generated.usedFallback,
        workerVersion: WORKER_VERSION,
        imageCount: imageUrls.length,
        apiAttempts: generated.apiAttempts,
        jobAttemptCount: attemptCount,
        interactionId: generated.interactionId,
        processingMs: Date.now() - startedAt,
        inputTokens: Number(generated.usage.total_input_tokens) || 0,
        outputTokens: Number(generated.usage.total_output_tokens) || 0,
      },
    });

    console.log(
      `[Job ${ref.id}] completed model=${generated.model} durationMs=${
        Date.now() - startedAt
      }`
    );
  } catch (error) {
    const errorMessage = sanitizeError(error);

    await ref.update({
      status: "error",
      errorMsg: errorMessage,
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      aiMeta: {
        provider: "google",
        requestedModel: cleanText(data.aiModel, 80),
        workerVersion: WORKER_VERSION,
        imageCount: imageUrls.length,
        jobAttemptCount: attemptCount,
        processingMs: Date.now() - startedAt,
        httpStatus: Number(error.status) || 0,
      },
    });

    console.error(`[Job ${ref.id}] failed: ${errorMessage}`);
  }
}

const queuedIds = new Set();
const activeIds = new Set();
const jobQueue = [];

function drainQueue() {
  while (
    activeIds.size < MAX_CONCURRENT_JOBS &&
    jobQueue.length > 0
  ) {
    const ref = jobQueue.shift();
    queuedIds.delete(ref.id);
    activeIds.add(ref.id);

    processProduct(ref)
      .catch((error) => {
        console.error(
          `[Job ${ref.id}] unexpected worker error: ${sanitizeError(error)}`
        );
      })
      .finally(() => {
        activeIds.delete(ref.id);
        drainQueue();
      });
  }
}

function enqueueProduct(ref) {
  if (queuedIds.has(ref.id) || activeIds.has(ref.id)) return;
  queuedIds.add(ref.id);
  jobQueue.push(ref);
  drainQueue();
}

const unsubscribe = db
  .collection("products")
  .where("status", "==", "pending")
  .onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          enqueueProduct(change.doc.ref);
        }
      });
    },
    (error) => {
      console.error(`[Firestore listener] ${sanitizeError(error)}`);
    }
  );

async function recoverStaleProducts() {
  const snapshot = await db
    .collection("products")
    .where("status", "==", "processing")
    .get();
  const now = Date.now();
  const staleRefs = snapshot.docs.filter((doc) => {
    const startedAt = doc.data().processingStartedAt;
    return !startedAt || now - startedAt.toMillis() >= STALE_PROCESSING_MS;
  });

  await Promise.all(
    staleRefs.map((doc) =>
      doc.ref.update({
        status: "pending",
        updatedAt: FieldValue.serverTimestamp(),
        recoveryNote: "Worker restarted after stale processing state.",
      })
    )
  );

  if (staleRefs.length > 0) {
    console.log(`Recovered ${staleRefs.length} stale product job(s).`);
  }
}

const server = app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} v${WORKER_VERSION} listening on port ${PORT}`);
  console.log(
    `Listening for pending product tasks; default model=${DEFAULT_MODEL}`
  );
});

recoverStaleProducts().catch((error) => {
  console.error(`[Recovery] ${sanitizeError(error)}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  unsubscribe();
  server.close(() => process.exit(0));

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
