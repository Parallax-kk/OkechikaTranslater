const DOC_ID = "13ctjzzbfV6AHE218r-aHGLBq8j4JL0pLOYw1R_pIiTg";
// export?format=csv は gid 指定が必要です（シート名は使えないため）。
// gid が分かる場合のみ設定してください。
// ※ユーザー指定URLの gid=676289731 を使用
const SHEET_GID = 676289731;

const STORAGE_KEY = "cipherMapping";

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

    // 2) packed形式: 1行目に
    //    - A列: 暗号文字（空白区切り）
    //    - B列: 復号文字列（空白区切り）
    //    が同じ並びで入っている。
    //    例: "一 丁 ..." / "こ コ？ ..." のように、位置 i 同士を対応付ける。
    //
    //    （フォールバック）もしB列のpackedが無い場合のみ、従来の i%N（同音換字）方式を使う。
    const firstRowA = getCell(rows?.[0], 0);
    const packed = looksLikePackedFirstRow(firstRowA);
    if (packed) {
        const firstRowB = getCell(rows?.[0], 1);
        const cipherTokens = firstRowA.trim().split(/[\s\u3000]+/).filter(Boolean);
        const plainTokens = String(firstRowB ?? "")
            .trim()
            .split(/[\s\u3000]+/)
            .filter(Boolean);

        // packed B列がある場合は、それを「暗号トークン列の先頭から順に対応する直接置換値」として扱う。
        // （B列がA列と同数である保証はないため、B列の長さ分だけ対応付ける）
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
            // フォールバック（旧方式）: 暗号リストの位置 i の復号は (i % N)
            // ※ユーザー要望「中間に仮名は使わない」には反するため、B列packedが無い場合のみ使う。
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
    //    - B列が数値の行（例: ソ,28）も直接置換として扱う
    //    - 1行目が packed の巨大セルの場合のみ、そのセルは除外（他の行は通常通り）
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

        await chrome.storage.local.set({
            [STORAGE_KEY]: {
                ok: true,
                mapping,
                fetchedAt: Date.now(),
                sourceUrl: chosen.url,
                durationMs: Date.now() - startedAt,
                count: Object.keys(mapping).length
            }
        });

        console.info("[OkechikaTranslater] refreshMapping ok", {
            count: Object.keys(mapping).length,
            sourceUrl: chosen.url,
            durationMs: Date.now() - startedAt
        });

        return { ok: true, count: Object.keys(mapping).length };
    } catch (e) {
        const status = typeof e?.status === "number" ? e.status : undefined;
        const privateOrAuthRequired = status === 401 || status === 403;

        console.warn("[OkechikaTranslater] refreshMapping failed", {
            error: String(e?.message ?? e),
            status,
            privateOrAuthRequired,
            url: e?.url
        });

        await chrome.storage.local.set({
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

chrome.runtime.onInstalled.addListener(() => {
    refreshMapping();
});

chrome.runtime.onStartup?.addListener(() => {
    refreshMapping();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg?.type === "GET_MAPPING") {
            const stored = await chrome.storage.local.get(STORAGE_KEY);
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
