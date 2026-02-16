const ENABLED_KEY = "okechikaEnabled";
const RUBY_SWAP_KEY = "okechikaRubySwap";
const DOMAIN_ONLY_KEY = "okechikaDomainOnly";

// Firefox は `browser.*` が Promise ベース。
const EXT = globalThis.browser ?? globalThis.chrome;

function normalizeEnabled(v) {
    return v === undefined ? true : Boolean(v);
}

function normalizeRubySwap(v) {
    return v === undefined ? false : Boolean(v);
}

function normalizeDomainOnly(v) {
    return v === undefined ? true : Boolean(v);
}

async function getEnabled() {
    try {
        const obj = (await EXT.storage.local.get(ENABLED_KEY)) ?? {};
        return normalizeEnabled(obj?.[ENABLED_KEY]);
    } catch {
        return true;
    }
}

async function getRubySwap() {
    try {
        const obj = (await EXT.storage.local.get(RUBY_SWAP_KEY)) ?? {};
        return normalizeRubySwap(obj?.[RUBY_SWAP_KEY]);
    } catch {
        return false;
    }
}

async function getDomainOnly() {
    try {
        const obj = (await EXT.storage.local.get(DOMAIN_ONLY_KEY)) ?? {};
        return normalizeDomainOnly(obj?.[DOMAIN_ONLY_KEY]);
    } catch {
        return true;
    }
}

async function setEnabled(next) {
    try {
        await EXT.storage.local.set({ [ENABLED_KEY]: Boolean(next) });
    } catch {
        // ignore
    }
}

async function setRubySwap(next) {
    try {
        await EXT.storage.local.set({ [RUBY_SWAP_KEY]: Boolean(next) });
    } catch {
        // ignore
    }
}

async function setDomainOnly(next) {
    try {
        await EXT.storage.local.set({ [DOMAIN_ONLY_KEY]: Boolean(next) });
    } catch {
        // ignore
    }
}

function renderStatus(el, enabled) {
    el.textContent = enabled ? "状態: ON（翻訳有効）" : "状態: OFF（翻訳無効）";
}

document.addEventListener("DOMContentLoaded", async () => {
    const checkbox = document.getElementById("enabled");
    const domainOnly = document.getElementById("domainOnly");
    const rubySwap = document.getElementById("rubySwap");
    const status = document.getElementById("status");

    const enabled = await getEnabled();
    checkbox.checked = enabled;

    const rubySwapValue = await getRubySwap();
    rubySwap.checked = rubySwapValue;

    const domainOnlyValue = await getDomainOnly();
    domainOnly.checked = domainOnlyValue;
    renderStatus(status, enabled);

    checkbox.addEventListener("change", async () => {
        const next = checkbox.checked;
        renderStatus(status, next);
        await setEnabled(next);
    });

    rubySwap.addEventListener("change", async () => {
        await setRubySwap(rubySwap.checked);
    });

    domainOnly.addEventListener("change", async () => {
        await setDomainOnly(domainOnly.checked);
    });

    try {
        EXT.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local") return;
            if (!changes) return;
            if (Object.prototype.hasOwnProperty.call(changes, ENABLED_KEY)) {
                const next = normalizeEnabled(changes[ENABLED_KEY]?.newValue);
                checkbox.checked = next;
                renderStatus(status, next);
            }
            if (Object.prototype.hasOwnProperty.call(changes, RUBY_SWAP_KEY)) {
                rubySwap.checked = normalizeRubySwap(changes[RUBY_SWAP_KEY]?.newValue);
            }
            if (Object.prototype.hasOwnProperty.call(changes, DOMAIN_ONLY_KEY)) {
                domainOnly.checked = normalizeDomainOnly(changes[DOMAIN_ONLY_KEY]?.newValue);
            }
        });
    } catch {
        // ignore
    }
});
