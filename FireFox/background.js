// Firefox は `browser.*` が Promise ベース。
// `chrome.*` は callback ベースで、await すると undefined になり得るため、
// ここでは Promise を返す API を必ず使う。
const EXT = globalThis.browser ?? globalThis.chrome;

const DOC_ID = "13ctjzzbfV6AHE218r-aHGLBq8j4JL0pLOYw1R_pIiTg";
// export?format=csv は gid 指定が必要です（シート名は使えないため）。
// gid が分かる場合のみ設定してください。
// ※ユーザー指定URLの gid=676289731 を使用
const SHEET_GID = 676289731;

const STORAGE_KEY = "cipherMapping";
// スプレッドシートの対応表より「ローカル保存の対応表」を優先したい場合に使うキー。
// 例: { "一乱丣丄": "公式" }
const LOCAL_OVERRIDE_KEY = "localOverrideMapping";

function sanitizeMappingObject(obj) {
    const out = {};
    if (!obj || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
        const key = String(k ?? "").trim();
        const val = String(v ?? "");
        if (!key) continue;
        // 空文字は「未翻訳」と同じ扱い（上書きしない）
        if (val.trim().length === 0) continue;
        out[key] = val;
    }
    return out;
}

async function loadLocalOverrideMapping() {
    try {
        const stored = (await EXT.storage.local.get(LOCAL_OVERRIDE_KEY)) ?? {};
        return sanitizeMappingObject(stored?.[LOCAL_OVERRIDE_KEY]);
    } catch {
        return {};
    }
}

function buildCsvUrls() {
    if (typeof SHEET_GID !== "number") {
        throw new Error("SHEET_GID is required");
    }

    return [`https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=csv&gid=${SHEET_GID}`];
}

/**
 * CSV（RFC4180相当）をざっくり安全にパース。
 * - ダブルクォートで囲まれたセル中のカンマ/改行を扱う
 * - "" は " として扱う
 */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"') {
                const next = text[i + 1];
                if (next === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
            continue;
        }

        if (ch === ",") {
            row.push(field);
            field = "";
            continue;
        }

        if (ch === "\r") {
            continue;
        }

        if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            continue;
        }

        field += ch;
    }

    row.push(field);
    rows.push(row);

    // 末尾の空行を削除
    while (rows.length > 0) {
        const last = rows[rows.length - 1];
        const allEmpty = last.every((c) => (c ?? "").trim() === "");
        if (!allEmpty) break;
        rows.pop();
    }

    return rows;
}

async function fetchFirstWorkingCsv(url) {
    let lastError = null;

    try {
        const res = await fetch(url, { cache: "no-store" });
        const text = await res.text();

        if (!res.ok) {
            const err = new Error(`HTTP ${res.status} ${res.statusText}`);
            err.status = res.status;
            err.url = url;
            err.bodySnippet = (text ?? "").slice(0, 300);
            throw err;
        }

        if (!text || text.trim().length === 0) {
            const err = new Error("Empty CSV");
            err.status = res.status;
            err.url = url;
            throw err;
        }

        // 公開されていない/認証が必要な場合、HTML(ログインページ等)が返ることがある
        const head = text.slice(0, 2000).toLowerCase();
        if (head.includes("<html") || head.includes("<!doctype html")) {
            const err = new Error("Non-CSV response (HTML). Spreadsheet may require sign-in or is not published.");
            err.status = res.status;
            err.url = url;
            err.bodySnippet = (text ?? "").slice(0, 300);
            throw err;
        }

        return { url, text, status: res.status };
    } catch (e) {
        lastError = e;
    }

    throw lastError ?? new Error("CSV fetch failed");
}

function mappingFromRows(rows) {
    // A=0, B=1
    const mapping = {};

    const isNonNegativeIntegerString = (s) => /^\d+$/.test(String(s ?? "").trim());

    const getCell = (cols, index) => {
        if (!cols || index < 0 || index >= cols.length) return "";
        return String(cols[index] ?? "");
    };

    const looksLikePackedFirstRow = (firstRowA) => {
        const trimmed = String(firstRowA ?? "").trim();
        if (!trimmed) return false;
        const tokens = trimmed.split(/[\s\u3000]+/).filter(Boolean);
        // 1セルに大量の暗号トークンが入っているケースのみ packed とみなす
        return tokens.length >= 100;
    };

    // 1) 行形式: A列=平文文字, B列=数値インデックス（0..N-1） を収集
    //    例: "ァ","0" のような行
    const plainByIndex = new Map();
    let maxIndex = -1;
    for (let i = 0; i < rows.length; i++) {
        const cols = rows[i];
        if (!cols || cols.length < 2) continue;
        const a = getCell(cols, 0).trim();
        const b = getCell(cols, 1).trim();
        if (!a || !b) continue;
        if (!isNonNegativeIntegerString(b)) continue;

        const idx = Number.parseInt(b, 10);
        if (!Number.isFinite(idx) || idx < 0) continue;
        plainByIndex.set(idx, a);
        if (idx > maxIndex) maxIndex = idx;
    }

    // 2) packed形式
    const firstRowA = getCell(rows?.[0], 0);
    const packed = looksLikePackedFirstRow(firstRowA);
    if (packed) {
        const firstRowB = getCell(rows?.[0], 1);
        const cipherTokens = firstRowA.trim().split(/[\s\u3000]+/).filter(Boolean);
        const plainTokens = String(firstRowB ?? "")
            .trim()
            .split(/[\s\u3000]+/)
            .filter(Boolean);

        const hasPackedDirect = plainTokens.length >= 100;

        if (hasPackedDirect) {
            const len = Math.min(cipherTokens.length, plainTokens.length);
            for (let i = 0; i < len; i++) {
                const from = cipherTokens[i];
                const to = plainTokens[i];
                if (!from || !to) continue;
                mapping[from] = to;
            }
        } else {
            const base = maxIndex >= 0 ? maxIndex + 1 : 0;
            if (plainByIndex.size >= 10 && base > 0) {
                for (let i = 0; i < cipherTokens.length; i++) {
                    const from = cipherTokens[i];
                    const to = plainByIndex.get(i % base);
                    if (!from || !to) continue;
                    mapping[from] = to;
                }
            }
        }
    }

    // 3) 直接置換(A->B)
    for (let i = 0; i < rows.length; i++) {
        const cols = rows[i];
        if (!cols || cols.length < 2) continue;
        if (packed && i === 0) continue;

        const from = getCell(cols, 0).trim();
        const toRaw = getCell(cols, 1);
        const to = toRaw.trim();
        if (!from || !to) continue;

        mapping[from] = to;
    }

    return mapping;
}

async function refreshMapping() {
    const startedAt = Date.now();
    const urls = buildCsvUrls();
    try {
        let chosen = null;
        let mapping = null;

        for (const candidateUrl of urls) {
            try {
                const fetched = await fetchFirstWorkingCsv(candidateUrl);
                const rows = parseCsv(fetched.text);
                const m = mappingFromRows(rows);
                if (Object.keys(m).length === 0) continue;
                chosen = fetched;
                mapping = m;
                break;
            } catch {
                // try next
            }
        }

        if (!chosen || !mapping || Object.keys(mapping).length === 0) {
            throw new Error("Mapping is empty (check A列→B列 and sheet contents)");
        }

        // ローカル上書き（特定文字列だけ別の訳語にしたい等）
        const localOverrides = await loadLocalOverrideMapping();
        const mergedMapping = { ...mapping, ...localOverrides };

        await EXT.storage.local.set({
            [STORAGE_KEY]: {
                ok: true,
                mapping: mergedMapping,
                fetchedAt: Date.now(),
                sourceUrl: chosen.url,
                durationMs: Date.now() - startedAt,
                count: Object.keys(mergedMapping).length
            }
        });

        console.info("[OkechikaTranslater] refreshMapping ok", {
            count: Object.keys(mergedMapping).length,
            sourceUrl: chosen.url,
            durationMs: Date.now() - startedAt
        });

        return { ok: true, count: Object.keys(mergedMapping).length };
    } catch (e) {
        const status = typeof e?.status === "number" ? e.status : undefined;
        const privateOrAuthRequired = status === 401 || status === 403;

        console.warn("[OkechikaTranslater] refreshMapping failed", {
            error: String(e?.message ?? e),
            status,
            privateOrAuthRequired,
            url: e?.url
        });

        await EXT.storage.local.set({
            [STORAGE_KEY]: {
                ok: false,
                error: String(e?.message ?? e),
                status,
                privateOrAuthRequired,
                bodySnippet: typeof e?.bodySnippet === "string" ? e.bodySnippet : undefined,
                fetchedAt: Date.now(),
                sourceUrlCandidates: urls
            }
        });
        return { ok: false, error: String(e?.message ?? e) };
    }
}

EXT.runtime.onInstalled.addListener(() => {
    refreshMapping();
});

EXT.runtime.onStartup?.addListener(() => {
    refreshMapping();
});

EXT.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg?.type === "GET_MAPPING") {
            const stored = (await EXT.storage.local.get(STORAGE_KEY)) ?? {};
            sendResponse(stored[STORAGE_KEY] ?? { ok: false, error: "No mapping yet" });
            return;
        }

        if (msg?.type === "REFRESH_MAPPING") {
            const result = await refreshMapping();
            sendResponse(result);
            return;
        }

        sendResponse({ ok: false, error: "Unknown message" });
    })();

    // async sendResponse
    return true;
});
