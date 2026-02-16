const IGNORED_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
    "INPUT",
    "NOSCRIPT"
]);

const ENABLED_KEY = "okechikaEnabled";
const RUBY_SWAP_KEY = "okechikaRubySwap";
const DOMAIN_ONLY_KEY = "okechikaDomainOnly";

// 「桶地下サイトのみ翻訳」がONのときに翻訳を許可するドメイン
const ALLOWED_HOSTS = new Set([
    "0cacd3226ad7.ngrok.app",
    "www.qtes9gu0k.xyz"
]);

// Firefox は `browser.*` が Promise ベース。
// `chrome.*` は callback ベースで、await すると undefined になり得るため、
// ここでは Promise を返す API を必ず使う。
const EXT = globalThis.browser ?? globalThis.chrome;

// 同じ箇所に何度も置換が走る（初回＋リトライ＋MutationObserver）ため、
// 置換後の文字列をさらに置換してしまう連鎖変換（例: 儺→下→確）を防ぐ。
// span化できないケースでも、元の文字列を保持して常にそこから再計算する。
const ORIGINAL_TEXT_BY_NODE = new WeakMap();

// false: 本文=翻訳後 / ルビ=原文（従来）
// true:  本文=原文 / ルビ=翻訳後
let rubySwap = false;
let domainOnly = true;

function isAllowedOkechikaSite() {
    const isAllowed = (proto, host) => {
        const p = String(proto ?? "");
        const h = String(host ?? "").toLowerCase();
        if (p !== "http:" && p !== "https:") return false;
        if (!h) return false;
        return ALLOWED_HOSTS.has(h);
    };

    // 1) まずは「このフレーム自身のURL」で判定
    try {
        if (isAllowed(location?.protocol, location?.hostname)) return true;
    } catch {
        // ignore
    }

    // 2) same-origin の場合は top のURLで判定（srcdoc/about:blank iframe で有効）
    try {
        if (window.top && window.top !== window) {
            if (isAllowed(window.top.location.protocol, window.top.location.hostname)) return true;
        }
    } catch {
        // cross-origin の場合は例外になるため無視
    }

    // 3) referrer から推測して判定（Firefox は ancestorOrigins が基本無い）
    const candidates = [];
    try {
        if (document.referrer) candidates.push(document.referrer);
    } catch {
        // ignore
    }

    for (let i = candidates.length - 1; i >= 0; i--) {
        try {
            const u = new URL(candidates[i]);
            if (isAllowed(u.protocol, u.hostname)) return true;
        } catch {
            // ignore
        }
    }

    return false;
}

function shouldIgnoreTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) return true;
    if (IGNORED_TAGS.has(parent.tagName)) return true;
    // ルビの注釈側(rt/rp)は翻訳対象にしない
    if (parent.tagName === "RT" || parent.tagName === "RP") return true;
    const editable = parent.closest("[contenteditable='true']");
    if (editable) {
        // 表示専用ビューアが contenteditable を使うことがあるため、
        // ユーザーが操作中（フォーカス中）のときだけ避ける。
        const active = document.activeElement;
        if (active && editable.contains(active)) return true;
    }
    return false;
}

function buildReplacer(mapping) {
    const entries = Object.entries(mapping ?? {});
    if (entries.length === 0) return null;

    // 置換元が1文字とは限らない想定で、長いキーを優先して置換
    entries.sort((a, b) => b[0].length - a[0].length);

    const keys = entries.map(([k]) => k);
    const escapedKeys = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(escapedKeys.join("|"), "g");
    const map = new Map(entries);

    return (text) => text.replace(re, (m) => map.get(m) ?? m);
}

function buildMatchRegex(mapping) {
    const entries = Object.entries(mapping ?? {});
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[0].length - a[0].length);
    const escapedKeys = entries
        .map(([k]) => k)
        .filter((k) => typeof k === "string" && k.length > 0)
        .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (escapedKeys.length === 0) return null;
    return new RegExp(escapedKeys.join("|"), "g");
}

function countMatchesInText(text, re) {
    if (!text || !re) return 0;
    re.lastIndex = 0;
    let count = 0;
    while (re.exec(text)) {
        count++;
        // 念のため無限ループ防止（空文字マッチは発生しない想定だが保険）
        if (re.lastIndex === 0) break;
    }
    re.lastIndex = 0;
    return count;
}

function estimateMatchesInRoot(root, re) {
    if (!re) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let n;
    while ((n = walker.nextNode())) {
        if (shouldIgnoreTextNode(n)) continue;
        const before = n.nodeValue;
        if (!before || before.trim().length === 0) continue;
        total += countMatchesInText(before, re);
    }
    return total;
}

function ensureDefaultFontStyle() {
    const id = "okechika-translater-font";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    // 暗号用フォントに引っ張られないよう、読みやすい日本語サンセリフを優先
    // ページが Noto Sans JP を読み込んでいない場合でも、他の一般的なフォントへフォールバックする
    const fontStack = [
        '"Noto Sans JP"',
        '"Noto Sans CJK JP"',
        '"Hiragino Sans"',
        '"Yu Gothic"',
        'Meiryo',
        'system-ui',
        'sans-serif'
    ].join(",");
    // ルビ(rt)はページ既定フォントのままにしたいので、翻訳本文側だけフォントを当てる。
    // ルビ表示がページCSSで崩れることがあるため、最低限の ruby/rt スタイルも付与する。
    style.textContent = [
        `.okechika-translated-base{font-family:${fontStack} !important;}`,
        // コンテナ配下の ruby だけにスタイルを当てる（コンテナ自体は span）
        `.okechika-translated ruby{ruby-position:over; ruby-align:center;}`,
        `.okechika-translated ruby rt{font-size:0.6em; line-height:1;}`
    ].join("\n");
    document.documentElement.appendChild(style);
}

function createTranslatedRuby(original, translated) {
    const ruby = document.createElement("ruby");
    const base = document.createElement("span");
    // ルビ表示入替時はフォントも入替える
    // - 通常: 本文(翻訳後)に読みやすいフォントを適用
    // - 入替: 本文(原文)はページ既定フォント、ルビ(翻訳後)に読みやすいフォントを適用
    base.className = rubySwap ? "" : "okechika-translated-base";
    base.textContent = rubySwap ? original : translated;
    ruby.appendChild(base);
    const rt = document.createElement("rt");
    rt.className = rubySwap ? "okechika-translated-base" : "";
    rt.textContent = rubySwap ? translated : original;
    ruby.appendChild(rt);
    return ruby;
}

function createSegmentedTranslationFragment(originalText, replaceFn) {
    const frag = document.createDocumentFragment();
    const parts = String(originalText ?? "").split(/(\s+)/);
    for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(part));
            continue;
        }

        const translated = replaceFn(part);
        if (translated === part) {
            frag.appendChild(document.createTextNode(part));
        } else {
            frag.appendChild(createTranslatedRuby(part, translated));
        }
    }
    return frag;
}

function fillTranslatedContainer(containerEl, originalText, replaceFn) {
    while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
    containerEl.appendChild(createSegmentedTranslationFragment(originalText, replaceFn));
}

function canWrapWithSpan(parentEl) {
    if (!parentEl) return false;
    const tag = parentEl.tagName;
    // span を子に置けない要素を避ける
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    if (tag === "HEAD" || tag === "HTML") return false;
    return true;
}

function translateRoot(root, replaceFn) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];

    let n;
    while ((n = walker.nextNode())) {
        nodes.push(n);
    }

    let changedNodes = 0;
    const samples = [];

    const processedWrappers = new Set();

    for (const textNode of nodes) {
        if (shouldIgnoreTextNode(textNode)) continue;

        const current = textNode.nodeValue;
        if (!current || current.trim().length === 0) continue;

        const parent = textNode.parentElement;
        const wrapper = parent?.closest
            ? parent.closest("span.okechika-translated[data-okechika-original], ruby.okechika-translated[data-okechika-original]")
            : null;

        // 既に翻訳済みコンテナがある場合は、原文(=コンテナに保持)から一括で再計算して更新する
        if (wrapper && wrapper.dataset?.okechikaOriginal !== undefined) {
            if (processedWrappers.has(wrapper)) continue;

            const original = wrapper.dataset.okechikaOriginal;
            const after = replaceFn(original);

            if (wrapper.tagName === "RUBY") {
                // 旧形式(ruby直置き)をspanコンテナ形式に変換
                const container = document.createElement("span");
                container.className = "okechika-translated";
                container.dataset.okechikaOriginal = original;
                ensureDefaultFontStyle();
                fillTranslatedContainer(container, original, replaceFn);
                wrapper.replaceWith(container);
                processedWrappers.add(container);
            } else {
                ensureDefaultFontStyle();
                fillTranslatedContainer(wrapper, original, replaceFn);
                processedWrappers.add(wrapper);
            }

            changedNodes++;
            if (samples.length < 3) {
                samples.push({ before: String(original).slice(0, 80), after: String(after).slice(0, 80) });
            }
            continue;
        }

        const storedOriginal = ORIGINAL_TEXT_BY_NODE.get(textNode);
        const original = storedOriginal ?? current;

        const after = replaceFn(original);
        if (after !== current) {
            if (parent && canWrapWithSpan(parent)) {
                ensureDefaultFontStyle();
                const container = document.createElement("span");
                container.className = "okechika-translated";
                container.dataset.okechikaOriginal = original;
                fillTranslatedContainer(container, original, replaceFn);
                parent.replaceChild(container, textNode);
            } else {
                if (!ORIGINAL_TEXT_BY_NODE.has(textNode)) {
                    ORIGINAL_TEXT_BY_NODE.set(textNode, original);
                }
                textNode.nodeValue = after;
            }
            changedNodes++;
            if (samples.length < 3) {
                samples.push({ before: String(original).slice(0, 80), after: String(after).slice(0, 80) });
            }
        }
    }

    return { changedNodes, samples };
}

function translateFormFields(root, replaceFn) {
    let changed = 0;

    const nodes = root.querySelectorAll?.(
        "textarea, input:not([type]), input[type='text'], input[type='search'], input[type='url'], input[type='email'], input[type='tel']"
    );
    if (!nodes) return changed;

    for (const el of nodes) {
        try {
            const tag = el.tagName;
            const isActive = document.activeElement === el;
            // 入力中は触らない
            if (isActive) continue;

            const current = tag === "TEXTAREA" ? el.value : el.value;
            if (!current || current.trim().length === 0) continue;

            const original = el.dataset.okechikaOriginal ?? current;
            const after = replaceFn(original);
            if (after !== current) {
                if (!el.dataset.okechikaOriginal) el.dataset.okechikaOriginal = original;
                el.value = after;
                try {
                    // フィールド自体も暗号用フォントを避ける
                    el.style.fontFamily = '"Noto Sans JP","Noto Sans CJK JP","Hiragino Sans","Yu Gothic",Meiryo,system-ui,sans-serif';
                } catch {
                    // ignore
                }
                changed++;
            }
        } catch {
            // ignore
        }
    }

    return changed;
}

function collectOpenShadowRoots(root) {
    const roots = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
        if (n.shadowRoot) roots.push(n.shadowRoot);
    }
    // ネストした shadow root も拾う
    for (let i = 0; i < roots.length; i++) {
        const sr = roots[i];
        const inner = document.createTreeWalker(sr, NodeFilter.SHOW_ELEMENT);
        let e;
        while ((e = inner.nextNode())) {
            if (e.shadowRoot) roots.push(e.shadowRoot);
        }
    }
    return roots;
}

function reverseMapping(mapping) {
    const reversed = {};
    for (const [k, v] of Object.entries(mapping ?? {})) {
        if (!k || !v) continue;
        // 衝突した場合は先勝ち（ここでは安定性優先で上書きしない）
        if (reversed[v] === undefined) reversed[v] = k;
    }
    return reversed;
}

async function getMappingFromBackground() {
    try {
        const res = await EXT.runtime.sendMessage({ type: "GET_MAPPING" });
        return res ?? null;
    } catch {
        return null;
    }
}

async function refreshMappingInBackground() {
    try {
        const res = await EXT.runtime.sendMessage({ type: "REFRESH_MAPPING" });
        return res ?? null;
    } catch {
        return null;
    }
}

function showMappingErrorBanner(info) {
    // ユーザー要望: 「置換が適用されません」系の警告バナーは不要。
    // 対応表取得失敗などの実エラー（ok:false）のみ表示する。
    if (info?.warning) return;

    // 特殊なdocument（ごく稀）ではdocumentElementが無いことがある
    if (!document?.documentElement) return;

    const id = "okechika-translater-error";
    if (document.getElementById(id)) return;

    const box = document.createElement("div");
    box.id = id;
    box.style.position = "fixed";
    box.style.left = "12px";
    box.style.right = "12px";
    box.style.bottom = "12px";
    box.style.zIndex = "2147483647";
    box.style.padding = "10px 12px";
    box.style.border = "1px solid #d0d0d0";
    box.style.background = "#ffffff";
    box.style.color = "#111111";
    box.style.font = "12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif";
    box.style.maxHeight = "35vh";
    box.style.overflow = "auto";

    const title = document.createElement("div");
    title.textContent = info?.warning
        ? "OkechikaTranslater: 置換が適用されません"
        : "OkechikaTranslater: 対応表を取得できません";
    title.style.fontWeight = "600";
    title.style.marginBottom = "4px";

    const body = document.createElement("div");
    const status = info?.status ? ` (HTTP ${info.status})` : "";
    const hint = info?.warning
        ? "対応表の読み込みは成功しましたが、ページ本文で置換対象が見つかりませんでした。暗号文が画像/Canvas/閉じたShadow DOM内の場合や、対応表の向きが逆の場合に起きます。"
        : info?.messageFailure
            ? "拡張機能のバックグラウンドに接続できません。このページでは拡張が動作しないか、拡張が無効/未読み込みの可能性があります。"
            : info?.privateOrAuthRequired
                ? "スプレッドシートが非公開、または閲覧にログインが必要な可能性があります。"
                : "スプレッドシートが公開（リンク閲覧可 / ウェブに公開）になっているか確認してください。";
    const errText = info?.error ? `\n詳細: ${info.error}${status}` : "";
    const countsText =
        typeof info?.changedTextNodes === "number" || typeof info?.changedFields === "number"
            ? `\n置換: テキスト ${info.changedTextNodes ?? 0} 件 / フィールド ${info.changedFields ?? 0} 件`
            : "";
    body.textContent = `${hint}${errText}${countsText}`;

    box.appendChild(title);
    box.appendChild(body);

    document.documentElement.appendChild(box);
}

async function getEnabledFlag() {
    try {
        const obj = (await EXT.storage.local.get(ENABLED_KEY)) ?? {};
        const v = obj?.[ENABLED_KEY];
        return v === undefined ? true : Boolean(v);
    } catch {
        return true;
    }
}

async function getRubySwapFlag() {
    try {
        const obj = (await EXT.storage.local.get(RUBY_SWAP_KEY)) ?? {};
        const v = obj?.[RUBY_SWAP_KEY];
        return v === undefined ? false : Boolean(v);
    } catch {
        return false;
    }
}

async function getDomainOnlyFlag() {
    try {
        const obj = (await EXT.storage.local.get(DOMAIN_ONLY_KEY)) ?? {};
        const v = obj?.[DOMAIN_ONLY_KEY];
        return v === undefined ? true : Boolean(v);
    } catch {
        return true;
    }
}

function restoreTranslatedInRoot(root) {
    try {
        const translated = root.querySelectorAll?.(
            "span.okechika-translated[data-okechika-original], ruby.okechika-translated[data-okechika-original]"
        );
        if (translated) {
            for (const el of translated) {
                const original = el.dataset.okechikaOriginal;
                if (original === undefined) continue;
                el.replaceWith(document.createTextNode(original));
            }
        }

        const fields = root.querySelectorAll?.("textarea[data-okechika-original], input[data-okechika-original]");
        if (fields) {
            for (const el of fields) {
                const original = el.dataset.okechikaOriginal;
                if (original === undefined) continue;
                el.value = original;
                try {
                    delete el.dataset.okechikaOriginal;
                } catch {
                    // ignore
                }
            }
        }
    } catch {
        // ignore
    }
}

(async () => {
    try {
        console.info("[OkechikaTranslater] content script loaded", location.href);

        if (!document.body) {
            await new Promise((resolve) => {
                document.addEventListener("DOMContentLoaded", resolve, { once: true });
            });
        }

        if (!document.body) {
            throw new Error("document.body is not available");
        }

        let enabled = await getEnabledFlag();
        rubySwap = await getRubySwapFlag();
        domainOnly = await getDomainOnlyFlag();
        let observer = null;
        let replaceFn = null;

        function stopAndRestore() {
            try {
                observer?.disconnect();
            } catch {
                // ignore
            }
            observer = null;

            restoreTranslatedInRoot(document.body);
            for (const sr of collectOpenShadowRoots(document.body)) {
                restoreTranslatedInRoot(sr);
            }
        }

        async function startIfNeeded() {
            if (!enabled) return;
            if (domainOnly && !isAllowedOkechikaSite()) return;
            if (observer) return;

            // まずは対応表の更新を試みる（onInstalled/onStartup が走っていない場合もあるため）
            const refreshResult = await refreshMappingInBackground();
            if (refreshResult && refreshResult.ok === false) {
                console.warn("[OkechikaTranslater] refresh failed", refreshResult);
            }

            const result = await getMappingFromBackground();
            if (!result) {
                showMappingErrorBanner({ ok: false, error: "Failed to message background", messageFailure: true });
                console.warn("[OkechikaTranslater] failed to get mapping (message failed)");
                return;
            }

            if (!result.ok) {
                showMappingErrorBanner(result);
                console.warn("[OkechikaTranslater] mapping not ok", result);
                return;
            }

            const mapping = result.mapping ?? null;
            if (!mapping) {
                showMappingErrorBanner({ ok: false, error: "No mapping in storage" });
                console.warn("[OkechikaTranslater] no mapping in storage");
                return;
            }

            // マッピング方向は forward 固定（A列→B列）。
            // 数字変換（例: ソ→28）が入ると reverse 自動判定が誤作動しやすいため。
            console.info("[OkechikaTranslater] mapping direction", { chosen: "forward" });

            replaceFn = buildReplacer(mapping);
            if (!replaceFn) {
                showMappingErrorBanner({ ok: false, error: "Mapping is empty" });
                console.warn("[OkechikaTranslater] mapping is empty");
                return;
            }

            function translateAllRoots(fn) {
                let changedTextNodes = 0;
                let changedFields = 0;
                const sampleChanges = [];

                const r1 = translateRoot(document.body, fn);
                changedTextNodes += r1.changedNodes;
                sampleChanges.push(...r1.samples);
                changedFields += translateFormFields(document.body, fn);

                for (const sr of collectOpenShadowRoots(document.body)) {
                    const r = translateRoot(sr, fn);
                    changedTextNodes += r.changedNodes;
                    sampleChanges.push(...r.samples);
                    // shadow root 内の input/textarea は基本少ないが、一応
                    try {
                        changedFields += translateFormFields(sr, fn);
                    } catch {
                        // ignore
                    }
                }

                return { changedTextNodes, changedFields, sampleChanges: sampleChanges.slice(0, 3) };
            }

            function rerenderAllRoots() {
                if (!replaceFn) return;
                try {
                    translateAllRoots(replaceFn);
                } catch {
                    // ignore
                }
            }

            // 初回翻訳
            let changed = translateAllRoots(replaceFn);

            const totalReplacements = (changed.changedTextNodes ?? 0) + (changed.changedFields ?? 0);
            if (totalReplacements === 0) {
                showMappingErrorBanner({ warning: true, error: "0 replacements", ...changed });
                console.warn("[OkechikaTranslater] 0 replacements; nothing to translate");
            } else {
                console.info("[OkechikaTranslater] initial replacements", changed);

                // 少なすぎる場合は、ユーザーが見ている本文に効いていない可能性が高いので注意喚起
                if (totalReplacements < 10) {
                    showMappingErrorBanner({ warning: true, error: "Too few replacements", ...changed });
                    console.warn("[OkechikaTranslater] too few replacements", changed);
                }
            }

            // SPA/ビューアで遅れて描画される場合があるので、数回だけ再実行
            const retryDelaysMs = [500, 1500, 3000];
            for (const d of retryDelaysMs) {
                setTimeout(() => {
                    try {
                        if (!enabled) return;
                        const retry = translateAllRoots(replaceFn);
                        const retryTotal = (retry.changedTextNodes ?? 0) + (retry.changedFields ?? 0);
                        if (retryTotal > 0) {
                            console.info("[OkechikaTranslater] retry replacements", { delayMs: d, ...retry });
                        }
                    } catch {
                        // ignore
                    }
                }, d);
            }

            // 追加・更新された箇所を翻訳
            let scheduled = false;
            const pendingRoots = new Set();
            let isApplying = false;

            function isInsideTranslated(node) {
                try {
                    if (!node) return false;
                    const el =
                        node.nodeType === Node.ELEMENT_NODE
                            ? node
                            : node.nodeType === Node.TEXT_NODE
                                ? node.parentElement
                                : null;
                    if (!el) return false;
                    if (el.classList?.contains("okechika-translated")) return true;
                    return Boolean(el.closest?.(".okechika-translated"));
                } catch {
                    return false;
                }
            }

            function scheduleTranslate(observer) {
                if (scheduled) return;
                scheduled = true;
                queueMicrotask(() => {
                    scheduled = false;
                    const roots = Array.from(pendingRoots);
                    pendingRoots.clear();

                    if (isApplying) return;
                    isApplying = true;
                    try {
                        for (const r of roots) {
                            if (!r) continue;
                            // 拡張が入れた要素配下は監視経由で再翻訳しない
                            if (isInsideTranslated(r)) continue;
                            if (r.nodeType === Node.ELEMENT_NODE || r.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                                try {
                                    translateRoot(r, replaceFn);
                                } catch {
                                    // ignore
                                }
                                try {
                                    if (r.nodeType === Node.ELEMENT_NODE) translateFormFields(r, replaceFn);
                                } catch {
                                    // ignore
                                }
                            }
                        }

                        // 新規に追加された open shadow root も追従
                        for (const sr of collectOpenShadowRoots(document.body)) {
                            try {
                                translateRoot(sr, replaceFn);
                            } catch {
                                // ignore
                            }
                            try {
                                translateFormFields(sr, replaceFn);
                            } catch {
                                // ignore
                            }
                        }
                    } finally {
                        isApplying = false;
                    }
                });
            }

            observer = new MutationObserver((mutations) => {
                // 翻訳適用中のDOM変更は全て無視（自分で入れた変更が再トリガーになるのを防ぐ）
                if (isApplying) return;

                for (const m of mutations) {
                    if (m.type === "characterData") {
                        if (m.target?.nodeType === Node.TEXT_NODE) {
                            if (!isInsideTranslated(m.target)) {
                                pendingRoots.add(m.target.parentElement ?? document.body);
                            }
                        }
                        continue;
                    }

                    if (m.type === "childList") {
                        for (const node of m.addedNodes) {
                            if (isInsideTranslated(node)) continue;
                            if (node.nodeType === Node.ELEMENT_NODE) pendingRoots.add(node);
                            else if (node.nodeType === Node.TEXT_NODE) pendingRoots.add(node.parentElement ?? document.body);
                        }
                    }
                }

                if (!enabled) return;
                scheduleTranslate(observer);
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });

            startIfNeeded.rerenderAllRoots = rerenderAllRoots;
        }

        // 初期状態に応じて開始
        await startIfNeeded();

        // ポップアップの切替に追従
        try {
            EXT.storage.onChanged.addListener((changes, areaName) => {
                if (areaName !== "local") return;
                if (!changes) return;

                if (Object.prototype.hasOwnProperty.call(changes, ENABLED_KEY)) {
                    const newValue = changes[ENABLED_KEY]?.newValue;
                    const next = newValue === undefined ? true : Boolean(newValue);
                    if (next !== enabled) {
                        enabled = next;
                        if (enabled) startIfNeeded();
                        else stopAndRestore();
                    }
                }

                if (Object.prototype.hasOwnProperty.call(changes, RUBY_SWAP_KEY)) {
                    const newValue = changes[RUBY_SWAP_KEY]?.newValue;
                    const next = newValue === undefined ? false : Boolean(newValue);
                    if (next !== rubySwap) {
                        rubySwap = next;
                        if (enabled) {
                            try {
                                startIfNeeded.rerenderAllRoots?.();
                            } catch {
                                // ignore
                            }
                        }
                    }
                }

                if (Object.prototype.hasOwnProperty.call(changes, DOMAIN_ONLY_KEY)) {
                    const newValue = changes[DOMAIN_ONLY_KEY]?.newValue;
                    const next = newValue === undefined ? true : Boolean(newValue);
                    if (next !== domainOnly) {
                        domainOnly = next;
                        if (enabled) {
                            if (domainOnly && !isAllowedOkechikaSite()) stopAndRestore();
                            else startIfNeeded();
                        }
                    }
                }
            });
        } catch {
            // ignore
        }
    } catch (e) {
        console.error("[OkechikaTranslater] unexpected error", e);
        try {
            showMappingErrorBanner({ ok: false, error: String(e?.message ?? e) });
        } catch {
            // ignore
        }
    }
})();
