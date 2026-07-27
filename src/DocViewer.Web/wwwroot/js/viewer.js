import * as pdfjsLib from "/lib/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/lib/pdfjs/pdf.worker.mjs";

const root = document.getElementById("viewer-root");
const streamUrl = root.dataset.streamUrl;
const releaseUrl = root.dataset.releaseUrl;

// Drop the converted PDF from server memory as soon as the user is done
// viewing it, instead of waiting out the multi-hour TTL fallback. pagehide
// fires reliably on tab close/navigation (unlike beforeunload on mobile),
// and sendBeacon queues the request to survive the page teardown.
window.addEventListener("pagehide", () => {
    navigator.sendBeacon(releaseUrl);
});

const canvasContainer = document.getElementById("canvas-container");
const pagesContainer = document.getElementById("pages-container");

const pageInput = document.getElementById("page-input");
const pageCountEl = document.getElementById("page-count");
const zoomLevelEl = document.getElementById("zoom-level");

const thumbnailPanel = document.getElementById("thumbnail-panel");
const thumbnailList = document.getElementById("thumbnail-list");
const toggleSidebarBtn = document.getElementById("btn-toggle-sidebar");

const passwordOverlay = document.getElementById("password-overlay");
const passwordMessage = document.getElementById("password-message");
const passwordInput = document.getElementById("password-input");
const passwordSubmit = document.getElementById("password-submit");
const passwordCancel = document.getElementById("password-cancel");

const loadingOverlay = document.getElementById("loading-overlay");

const searchToggleBtn = document.getElementById("btn-search");
const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const searchCountEl = document.getElementById("search-count");
const searchPrevBtn = document.getElementById("search-prev");
const searchNextBtn = document.getElementById("search-next");
const searchCloseBtn = document.getElementById("search-close");

const ZOOM_STEP = 0.15;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const THUMBNAIL_WIDTH = 110;

// Rendering at CSS pixel resolution looks blurry on HiDPI/Retina screens
// versus the crisp native PDF - render the canvas bitmap at the device's
// actual pixel density and downscale it back to logical CSS size with
// canvas.style, so on-screen quality matches the source (both for native
// vector PDFs and scanned/rasterized ones).
// Capped at 2x - since every page renders eagerly up front, an uncapped 3x
// display would roughly double render cost/memory again for barely-visible
// extra sharpness.
const OUTPUT_SCALE = Math.min(window.devicePixelRatio || 1, 2);

let pdfDocument = null;
let currentPage = 1;
let scale = 1;
let rotation = 0;
let pageEntries = [];
let thumbnailButtons = [];

// While we programmatically scroll to a page (button/thumbnail/input), the
// IntersectionObserver below would otherwise report whatever page we're
// scrolling past as "current" - suppress it until the scroll settles.
let suppressScrollTracking = false;

// Resolves with the entered password, or rejects if the user cancels -
// used as pdf.js's onPassword callback below.
function promptForPassword(reason) {
    return new Promise((resolve, reject) => {
        passwordMessage.textContent = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
            ? "รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง"
            : "เอกสารนี้มีการป้องกันด้วยรหัสผ่าน กรุณากรอกรหัสผ่านเพื่อเปิดดู";
        passwordInput.value = "";
        // The loading overlay would otherwise sit on top of (or behind, but
        // still visually competing with) the password dialog while pdf.js is
        // paused waiting on it - hide it until the password is resolved, then
        // loadDocument's own flow puts it back until pages actually render.
        loadingOverlay.classList.add("hidden");
        passwordOverlay.classList.remove("hidden");
        passwordInput.focus();

        const cleanup = () => {
            passwordOverlay.classList.add("hidden");
            loadingOverlay.classList.remove("hidden");
            passwordSubmit.removeEventListener("click", onSubmit);
            passwordCancel.removeEventListener("click", onCancel);
            passwordInput.removeEventListener("keydown", onKeydown);
        };
        const onSubmit = () => {
            cleanup();
            resolve(passwordInput.value);
        };
        const onCancel = () => {
            cleanup();
            reject(new Error("password-cancelled"));
        };
        const onKeydown = (event) => {
            if (event.key === "Enter") onSubmit();
            if (event.key === "Escape") onCancel();
        };

        passwordSubmit.addEventListener("click", onSubmit);
        passwordCancel.addEventListener("click", onCancel);
        passwordInput.addEventListener("keydown", onKeydown);
    });
}

async function loadDocument() {
    // fetch (not a direct <a href> / <embed>) keeps the PDF bytes out of
    // browser history and the "open in new tab" / save-target surface.
    const response = await fetch(streamUrl, { credentials: "same-origin" });
    if (!response.ok) {
        throw new Error(`Failed to load document: ${response.status}`);
    }
    const data = await response.arrayBuffer();

    // onPassword only works set as a property on the loadingTask - passing
    // it inside the getDocument() params object is silently ignored, and
    // the document rejects immediately with PasswordException instead of
    // ever prompting.
    const loadingTask = pdfjsLib.getDocument({ data });
    loadingTask.onPassword = (updatePassword, reason) => {
        promptForPassword(reason).then(
            (password) => updatePassword(password),
            // pdf.js's documented way to cancel a pending password request:
            // pass an Error instead of a password string.
            () => updatePassword(new Error("password-cancelled")),
        );
    };
    pdfDocument = await loadingTask.promise;
    pageCountEl.textContent = String(pdfDocument.numPages);
    pageInput.max = String(pdfDocument.numPages);

    await buildPages();
    await renderAllPages();
    loadingOverlay.classList.add("hidden");
    await scheduleThumbnailBuild();
}

async function buildPages() {
    pagesContainer.innerHTML = "";
    pageEntries = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
        const page = await pdfDocument.getPage(pageNumber);

        const wrapper = document.createElement("div");
        wrapper.className = "pdf-page";
        wrapper.dataset.page = String(pageNumber);

        const canvas = document.createElement("canvas");
        const searchLayer = document.createElement("div");
        searchLayer.className = "search-highlight-layer";
        const textLayer = document.createElement("div");
        textLayer.className = "textLayer";
        const linkLayer = document.createElement("div");
        linkLayer.className = "link-layer";

        // Order matters: search highlights sit just above the canvas (a
        // colored background showing through the transparent text layer),
        // the text layer sits above that so its (invisible) selectable spans
        // catch the mouse, and the link layer sits above that so a link
        // always wins a click over text selection where the two overlap
        // (matches how normal PDF viewers behave).
        wrapper.appendChild(canvas);
        wrapper.appendChild(searchLayer);
        wrapper.appendChild(textLayer);
        wrapper.appendChild(linkLayer);
        pagesContainer.appendChild(wrapper);

        pageEntries.push({ pageNumber, page, wrapper, canvas, searchLayer, textLayer, linkLayer, searchIndex: null });
        pageVisibilityObserver.observe(wrapper);
    }
}

async function renderAllPages() {
    // Each page owns its own canvas, so rendering them concurrently is safe
    // (pdf.js only forbids two concurrent render() calls on the *same*
    // canvas) - and it matters here: a single slow page (large embedded
    // image, complex font) would otherwise block every page after it,
    // including ones with links, from becoming usable.
    await Promise.all(pageEntries.map((entry) => renderPageEntry(entry)));
    zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
}

async function renderPageEntry(entry) {
    const viewport = entry.page.getViewport({ scale, rotation });

    entry.canvas.width = Math.floor(viewport.width * OUTPUT_SCALE);
    entry.canvas.height = Math.floor(viewport.height * OUTPUT_SCALE);
    entry.canvas.style.width = `${Math.floor(viewport.width)}px`;
    entry.canvas.style.height = `${Math.floor(viewport.height)}px`;
    entry.wrapper.style.width = `${viewport.width}px`;
    entry.wrapper.style.height = `${viewport.height}px`;
    // pdf.js's TextLayer sizes/scales its spans off this custom property
    // rather than the viewport object directly.
    entry.wrapper.style.setProperty("--scale-factor", String(viewport.scale));

    const transform = OUTPUT_SCALE !== 1 ? [OUTPUT_SCALE, 0, 0, OUTPUT_SCALE, 0, 0] : null;

    try {
        await entry.page.render({ canvasContext: entry.canvas.getContext("2d"), viewport, transform }).promise;
    } catch (err) {
        console.error(err);
    }

    await renderTextLayer(entry, viewport);
    await renderLinks(entry, viewport);
}

async function renderTextLayer(entry, viewport) {
    entry.textLayer.innerHTML = "";
    entry.searchLayer.innerHTML = "";
    entry.searchLayer.style.width = `${viewport.width}px`;
    entry.searchLayer.style.height = `${viewport.height}px`;

    try {
        const textLayer = new pdfjsLib.TextLayer({
            textContentSource: entry.page.streamTextContent(),
            container: entry.textLayer,
            viewport,
        });
        await textLayer.render();
    } catch (err) {
        console.error(err);
    }

    linkifyTextLayer(entry);

    // The text layer just got fully rebuilt (new span elements), so any
    // previous search index/highlight boxes referencing the old ones are
    // stale - rebuild both. The match *content* (which page, which character
    // range) doesn't change across a re-render, only which DOM nodes it maps
    // to, so search results themselves don't need recomputing here.
    entry.searchIndex = buildPageSearchIndex(entry);
    if (searchState.term) {
        renderSearchHighlightsForPage(entry);
    }
}

// Not every URL in a PDF is a real /Link annotation - documents routinely
// just print "www.example.com" as plain text. Real PDF viewers auto-detect
// those and make them clickable too, so scan the rendered (invisible,
// selectable) text spans for URL-shaped substrings and wrap them in <a>
// tags in place.
//
// pdf.js splits text into one span per "item" (a font/position run), not per
// word, and a URL can straddle two items with no space between them in the
// extracted string either way - whether they're a genuinely continuous run
// (a broken URL) or two unrelated pieces of text pdf.js just didn't insert a
// space between (e.g. a URL immediately followed by the next section's
// heading number). Text content alone can't tell those apart; only their
// rendered position can - so spans are only joined into one matching window
// when they sit right next to each other on the same line with no gap.
const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<>"'฀-๿]+)/gi;
const URL_CONTINUATION_PATTERN = /^[^\s<>"'฀-๿]+/;
const ADJACENT_LINE_TOLERANCE_PX = 3;
const ADJACENT_GAP_TOLERANCE_PX = 3;

function linkifyTextLayer(entry) {
    const spans = [...entry.textLayer.querySelectorAll(":scope > span")];
    if (spans.length === 0) return;

    const rects = spans.map((span) => span.getBoundingClientRect());

    // Partition spans into runs of mutually-adjacent spans (same line, ~0 gap).
    const runGroups = [];
    let currentGroup = [0];
    for (let i = 1; i < spans.length; i++) {
        const prev = rects[i - 1];
        const cur = rects[i];
        const sameLine = Math.abs(cur.top - prev.top) <= ADJACENT_LINE_TOLERANCE_PX;
        const noGap = cur.left - prev.right <= ADJACENT_GAP_TOLERANCE_PX && cur.left - prev.right >= -ADJACENT_GAP_TOLERANCE_PX;
        if (sameLine && noGap) {
            currentGroup.push(i);
        } else {
            runGroups.push(currentGroup);
            currentGroup = [i];
        }
    }
    runGroups.push(currentGroup);

    const runs = runGroups.map((group) => {
        const runSpans = group.map((i) => spans[i]);
        const texts = runSpans.map((span) => span.textContent || "");
        return {
            spans: runSpans,
            texts,
            fullText: texts.join(""),
            firstRect: rects[group[0]],
            lastRect: rects[group[group.length - 1]],
        };
    });

    // Raw (untrimmed) per-run matches - kept untrimmed so "did this match
    // reach exactly the end of the run's text" is a reliable truncation
    // signal, not thrown off by punctuation-stripping.
    const runMatches = runs.map((run) => [...run.fullText.matchAll(URL_PATTERN)].map((m) => ({
        start: m.index,
        end: m.index + m[0].length,
        url: m[0],
    })));

    // A long unbroken URL (no spaces) can force-wrap across *lines*, not
    // just adjacent same-line items (e.g. an email's link text). A run's
    // trailing match reaching exactly that run's own text length means it
    // was cut off by the run boundary, not by a natural separator - ordinary
    // prose essentially never matches URL_PATTERN all the way to a line's
    // end, so this is a safe, specific signal to bridge into the next line.
    for (let i = 0; i < runs.length; i++) {
        const matches = runMatches[i];
        if (matches.length === 0) continue;
        const last = matches[matches.length - 1];
        if (last.end !== runs[i].fullText.length) continue;

        let combinedUrl = last.url;
        const bridgedInto = [];
        let j = i;
        while (j + 1 < runs.length) {
            const prevRect = runs[j].lastRect;
            const nextRun = runs[j + 1];
            const verticalGap = nextRun.firstRect.top - prevRect.bottom;
            const rowHeight = Math.max(4, prevRect.bottom - prevRect.top);
            const looksLikeNextLine = verticalGap >= -2 && verticalGap <= rowHeight * 1.5;
            if (!looksLikeNextLine) break;

            const continuation = URL_CONTINUATION_PATTERN.exec(nextRun.fullText);
            // Require the continuation to consume the *entire* next run, not
            // just a leading prefix of it. A partial match (e.g. "3.1.2" out
            // of a run whose full text is "3.1.2 ตัวอย่างหัวข้อ") means that
            // run is its own independent line (a heading, a new sentence)
            // that merely happens to start with non-whitespace characters -
            // not a genuine continuation of the wrapped URL. Bridging into
            // it anyway is exactly the over-matching bug this whole
            // adjacency-based approach exists to avoid.
            if (!continuation || continuation[0].length !== nextRun.fullText.length) break;

            combinedUrl += continuation[0];
            bridgedInto.push({ runIndex: j + 1, length: continuation[0].length });
            j++;
        }

        if (bridgedInto.length > 0) {
            last.url = combinedUrl;
            last.bridgedInto = bridgedInto;
        }
    }

    const fragmentsByRunIndex = new Map();
    const addFragment = (runIndex, start, end, href) => {
        if (!fragmentsByRunIndex.has(runIndex)) fragmentsByRunIndex.set(runIndex, []);
        fragmentsByRunIndex.get(runIndex).push({ start, end, href });
    };

    for (let i = 0; i < runs.length; i++) {
        for (const match of runMatches[i]) {
            const url = match.url.replace(/[),.;]+$/, "");
            const href = /^https?:\/\//i.test(url) ? url : `http://${url}`;
            addFragment(i, match.start, Math.min(match.end, url.length + match.start), href);

            if (match.bridgedInto) {
                for (const { runIndex, length } of match.bridgedInto) {
                    addFragment(runIndex, 0, length, href);
                }
            }
        }
    }

    for (const [runIndex, fragments] of fragmentsByRunIndex) {
        renderRunFragments(runs[runIndex], fragments);
    }
}

function renderRunFragments(run, fragments) {
    const spanOffsets = [];
    let cursor = 0;
    for (const text of run.texts) {
        spanOffsets.push(cursor);
        cursor += text.length;
    }

    const fragmentsBySpanIndex = new Map();
    for (const fragment of fragments) {
        for (let i = 0; i < run.spans.length; i++) {
            const spanStart = spanOffsets[i];
            const spanEnd = spanStart + run.texts[i].length;
            const overlapStart = Math.max(fragment.start, spanStart);
            const overlapEnd = Math.min(fragment.end, spanEnd);
            if (overlapStart >= overlapEnd) continue;

            if (!fragmentsBySpanIndex.has(i)) fragmentsBySpanIndex.set(i, []);
            fragmentsBySpanIndex.get(i).push({ start: overlapStart - spanStart, end: overlapEnd - spanStart, href: fragment.href });
        }
    }

    for (const [i, spanFragments] of fragmentsBySpanIndex) {
        const span = run.spans[i];
        const text = run.texts[i];
        spanFragments.sort((a, b) => a.start - b.start);

        span.textContent = "";
        let localCursor = 0;
        for (const fragment of spanFragments) {
            if (fragment.start > localCursor) {
                span.appendChild(document.createTextNode(text.slice(localCursor, fragment.start)));
            }

            const link = document.createElement("a");
            link.href = fragment.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = fragment.href;
            link.textContent = text.slice(fragment.start, fragment.end);
            span.appendChild(link);

            localCursor = fragment.end;
        }
        if (localCursor < text.length) {
            span.appendChild(document.createTextNode(text.slice(localCursor)));
        }
    }
}

async function renderLinks(entry, viewport) {
    entry.linkLayer.innerHTML = "";
    entry.linkLayer.style.width = `${viewport.width}px`;
    entry.linkLayer.style.height = `${viewport.height}px`;

    const annotations = await entry.page.getAnnotations({ intent: "display" });
    for (const annotation of annotations) {
        if (annotation.subtype !== "Link" || !annotation.url) continue;

        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
        const link = document.createElement("a");
        link.href = annotation.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = annotation.url;
        link.style.left = `${Math.min(x1, x2)}px`;
        link.style.top = `${Math.min(y1, y2)}px`;
        link.style.width = `${Math.abs(x2 - x1)}px`;
        link.style.height = `${Math.abs(y2 - y1)}px`;
        entry.linkLayer.appendChild(link);
    }
}

// --- Search --------------------------------------------------------------
//
// There's no separate "search index" fetched from the server - matches are
// found directly against the same rendered text-layer spans linkifyTextLayer
// already reads from, so search results and on-screen text can never drift
// apart. A page's flat text and span offsets get rebuilt every time its text
// layer re-renders (zoom/rotate rebuilds every span from scratch), but the
// matches themselves (page + character range) stay valid across that since
// the underlying PDF text content never changes - only which DOM nodes those
// offsets map to does, which is exactly what buildPageSearchIndex recomputes.

const searchState = {
    term: "",
    matches: [], // { pageNumber, start, end } in document order
    currentIndex: -1,
};

function buildPageSearchIndex(entry) {
    const spans = [...entry.textLayer.querySelectorAll(":scope > span")];
    let cursor = 0;
    const spanOffsets = spans.map((span) => {
        const text = span.textContent || "";
        const start = cursor;
        cursor += text.length;
        return { span, start, end: cursor };
    });
    return { flatText: spans.map((span) => span.textContent || "").join(""), spanOffsets };
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Converts a character offset within a <span>'s combined textContent into an
// actual (Text node, offset) pair Range can use - needed because linkify may
// have split a span's text across multiple child nodes (plain text + <a>).
function nodePositionAtOffset(span, offset) {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let lastNode = null;
    let remaining = offset;
    while (node) {
        lastNode = node;
        const length = node.textContent.length;
        if (remaining <= length) {
            return { node, offset: remaining };
        }
        remaining -= length;
        node = walker.nextNode();
    }
    return lastNode ? { node: lastNode, offset: lastNode.textContent.length } : null;
}

function createRangeForMatch(entry, start, end) {
    const overlapping = entry.searchIndex.spanOffsets.filter((so) => start < so.end && end > so.start);
    if (overlapping.length === 0) return null;

    const first = overlapping[0];
    const last = overlapping[overlapping.length - 1];
    const startPos = nodePositionAtOffset(first.span, Math.max(start, first.start) - first.start);
    const endPos = nodePositionAtOffset(last.span, Math.min(end, last.end) - last.start);
    if (!startPos || !endPos) return null;

    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    return range;
}

function renderSearchHighlightsForPage(entry) {
    entry.searchLayer.innerHTML = "";
    if (!searchState.term) return;

    const wrapperRect = entry.wrapper.getBoundingClientRect();
    const currentMatch = searchState.matches[searchState.currentIndex];

    for (const match of searchState.matches) {
        if (match.pageNumber !== entry.pageNumber) continue;

        const range = createRangeForMatch(entry, match.start, match.end);
        if (!range) continue;

        for (const rect of range.getClientRects()) {
            const box = document.createElement("div");
            box.className = match === currentMatch ? "search-highlight current" : "search-highlight";
            box.style.left = `${rect.left - wrapperRect.left}px`;
            box.style.top = `${rect.top - wrapperRect.top}px`;
            box.style.width = `${rect.width}px`;
            box.style.height = `${rect.height}px`;
            entry.searchLayer.appendChild(box);
        }
    }
}

function renderAllSearchHighlights() {
    for (const entry of pageEntries) {
        renderSearchHighlightsForPage(entry);
    }
}

function runSearch(term) {
    searchState.term = term;
    searchState.matches = [];
    searchState.currentIndex = -1;

    if (term) {
        const pattern = new RegExp(escapeRegExp(term), "gi");
        for (const entry of pageEntries) {
            if (!entry.searchIndex) continue;
            for (const m of entry.searchIndex.flatText.matchAll(pattern)) {
                searchState.matches.push({ pageNumber: entry.pageNumber, start: m.index, end: m.index + m[0].length });
            }
        }
    }

    if (searchState.matches.length > 0) {
        // Jump to whichever match is closest to (at or after) the page
        // currently in view, rather than always restarting from page 1.
        searchState.currentIndex = searchState.matches.findIndex((m) => m.pageNumber >= currentPage);
        if (searchState.currentIndex === -1) searchState.currentIndex = 0;
    }

    updateSearchCount();
    renderAllSearchHighlights();
    goToCurrentMatch({ behavior: "auto" });
}

function updateSearchCount() {
    if (!searchState.term) {
        searchCountEl.textContent = "";
    } else if (searchState.matches.length === 0) {
        searchCountEl.textContent = "ไม่พบผลลัพธ์";
    } else {
        searchCountEl.textContent = `${searchState.currentIndex + 1} / ${searchState.matches.length}`;
    }
}

function goToCurrentMatch({ behavior = "smooth" } = {}) {
    const match = searchState.matches[searchState.currentIndex];
    if (!match) return;

    const entry = pageEntries[match.pageNumber - 1];
    if (!entry) return;

    if (currentPage !== match.pageNumber) {
        suppressScrollTracking = true;
        setCurrentPage(match.pageNumber);
        scrollElementIntoContainer(canvasContainer, entry.wrapper, { behavior, align: "start" });
        window.setTimeout(() => { suppressScrollTracking = false; }, behavior === "smooth" ? 500 : 300);
    }

    renderSearchHighlightsForPage(entry);
    const currentBox = entry.searchLayer.querySelector(".search-highlight.current");
    if (currentBox) {
        scrollElementIntoContainer(canvasContainer, currentBox, { behavior, align: "nearest" });
    }
}

function stepSearch(delta) {
    if (searchState.matches.length === 0) return;
    const previousEntry = pageEntries[searchState.matches[searchState.currentIndex]?.pageNumber - 1];

    searchState.currentIndex = (searchState.currentIndex + delta + searchState.matches.length) % searchState.matches.length;
    updateSearchCount();

    // Only the old and new "current" page's highlight boxes actually change
    // (the .current class moves) - no need to re-render every page's layer.
    if (previousEntry) renderSearchHighlightsForPage(previousEntry);
    goToCurrentMatch();
}

function openSearchBar() {
    searchBar.classList.remove("hidden");
    searchToggleBtn.setAttribute("aria-pressed", "true");
    searchInput.focus();
    searchInput.select();
}

function closeSearchBar() {
    searchBar.classList.add("hidden");
    searchToggleBtn.setAttribute("aria-pressed", "false");
    runSearch("");
}

searchToggleBtn.addEventListener("click", () => {
    if (searchBar.classList.contains("hidden")) {
        openSearchBar();
    } else {
        closeSearchBar();
    }
});

searchCloseBtn.addEventListener("click", closeSearchBar);
searchPrevBtn.addEventListener("click", () => stepSearch(-1));
searchNextBtn.addEventListener("click", () => stepSearch(1));

let searchDebounceHandle = null;
searchInput.addEventListener("input", () => {
    window.clearTimeout(searchDebounceHandle);
    searchDebounceHandle = window.setTimeout(() => runSearch(searchInput.value.trim()), 250);
});

searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        stepSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
        closeSearchBar();
    }
});

document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSearchBar();
    }
});

// Element.scrollIntoView() is free to adjust *any* scrollable ancestor, not
// just the one we mean to move - including body, which still has an internal
// scroll position even with overflow:hidden, just no scrollbar/wheel to move
// it back. Scroll only the specific container we intend to move instead.
function scrollElementIntoContainer(container, target, { behavior = "auto", align = "start" } = {}) {
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    let delta;
    if (align === "nearest") {
        if (targetRect.top >= containerRect.top && targetRect.bottom <= containerRect.bottom) {
            return;
        }
        delta = targetRect.top < containerRect.top
            ? targetRect.top - containerRect.top
            : targetRect.bottom - containerRect.bottom;
    } else {
        delta = targetRect.top - containerRect.top;
    }

    container.scrollTo({ top: container.scrollTop + delta, behavior });
}

async function rerenderAllPages() {
    await renderAllPages();

    const entry = pageEntries[currentPage - 1];
    if (entry) {
        suppressScrollTracking = true;
        scrollElementIntoContainer(canvasContainer, entry.wrapper, { behavior: "auto", align: "start" });
        window.setTimeout(() => { suppressScrollTracking = false; }, 300);
    }
}

// Zoom/rotate both end up re-rendering every page's canvas. Two overlapping
// calls (e.g. from a rapid double-click) would each try to render the same
// canvas at once, which pdf.js rejects outright - serialize requests instead
// and coalesce a queued one into a single trailing run against the latest
// scale/rotation, rather than piling up redundant renders.
let rerenderInFlight = false;
let rerenderQueued = false;
let thumbnailsNeedRebuild = false;

async function requestRerender(rebuildThumbnails) {
    if (rebuildThumbnails) thumbnailsNeedRebuild = true;

    if (rerenderInFlight) {
        rerenderQueued = true;
        return;
    }

    rerenderInFlight = true;
    try {
        do {
            rerenderQueued = false;
            await rerenderAllPages();
            if (thumbnailsNeedRebuild) {
                thumbnailsNeedRebuild = false;
                await scheduleThumbnailBuild();
            }
        } while (rerenderQueued);
    } catch (err) {
        console.error(err);
    } finally {
        rerenderInFlight = false;
    }
}

// Multiple call sites (initial load, rotate) can each want a thumbnail
// rebuild - chain them onto one promise so they never run two rebuilds of
// the same thumbnail list at once, regardless of which triggered it first.
let thumbnailBuildChain = Promise.resolve();

function scheduleThumbnailBuild() {
    thumbnailBuildChain = thumbnailBuildChain.then(() => buildThumbnails()).catch((err) => console.error(err));
    return thumbnailBuildChain;
}

async function buildThumbnails() {
    thumbnailList.innerHTML = "";
    thumbnailButtons = [];

    // Build and append every button/canvas first so DOM order stays 1..N,
    // then render them concurrently (own canvas each, same reasoning as
    // renderAllPages - one slow page shouldn't stall every other thumbnail).
    const jobs = pageEntries.map((entry) => {
        const baseViewport = entry.page.getViewport({ scale: 1, rotation });
        const viewport = entry.page.getViewport({ scale: THUMBNAIL_WIDTH / baseViewport.width, rotation });

        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.width = viewport.width;
        thumbCanvas.height = viewport.height;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "thumbnail-item";
        button.dataset.page = String(entry.pageNumber);
        button.title = `หน้า ${entry.pageNumber}`;
        button.addEventListener("click", () => goToPage(entry.pageNumber));

        const label = document.createElement("span");
        label.className = "thumbnail-label";
        label.textContent = String(entry.pageNumber);

        button.appendChild(thumbCanvas);
        button.appendChild(label);
        thumbnailList.appendChild(button);
        thumbnailButtons.push(button);

        return { entry, thumbCanvas, viewport };
    });

    await Promise.all(jobs.map(async ({ entry, thumbCanvas, viewport }) => {
        try {
            await entry.page.render({ canvasContext: thumbCanvas.getContext("2d"), viewport }).promise;
        } catch (err) {
            console.error(err);
        }
    }));

    updateActiveThumbnail();
}

function updateActiveThumbnail() {
    for (const button of thumbnailButtons) {
        const isActive = Number(button.dataset.page) === currentPage;
        button.classList.toggle("active", isActive);
        if (isActive) {
            scrollElementIntoContainer(thumbnailPanel, button, { behavior: "auto", align: "nearest" });
        }
    }
}

function setCurrentPage(pageNumber) {
    currentPage = pageNumber;
    pageInput.value = String(pageNumber);
    updateActiveThumbnail();
}

function goToPage(pageNumber) {
    if (!pdfDocument) return;
    pageNumber = Math.min(Math.max(pageNumber, 1), pdfDocument.numPages);
    const entry = pageEntries[pageNumber - 1];
    if (!entry) return;

    suppressScrollTracking = true;
    setCurrentPage(pageNumber);
    scrollElementIntoContainer(canvasContainer, entry.wrapper, { behavior: "smooth", align: "start" });
    window.setTimeout(() => { suppressScrollTracking = false; }, 500);
}

// Tracks which page occupies the most visible area of the scroll container
// and keeps the page counter / thumbnail highlight in sync - this is what
// makes "current page" follow mouse-wheel scrolling, not just the toolbar.
const visibilityRatios = new Map();
const pageVisibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        visibilityRatios.set(entry.target, entry.intersectionRatio);
    }

    if (suppressScrollTracking) return;

    let bestPage = null;
    let bestRatio = 0;
    for (const [el, ratio] of visibilityRatios) {
        if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = Number(el.dataset.page);
        }
    }

    if (bestPage && bestPage !== currentPage) {
        setCurrentPage(bestPage);
    }
}, { root: canvasContainer, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });

document.getElementById("btn-first").addEventListener("click", () => goToPage(1));
document.getElementById("btn-prev").addEventListener("click", () => goToPage(currentPage - 1));
document.getElementById("btn-next").addEventListener("click", () => goToPage(currentPage + 1));
document.getElementById("btn-last").addEventListener("click", () => {
    if (pdfDocument) goToPage(pdfDocument.numPages);
});

toggleSidebarBtn.addEventListener("click", () => {
    const collapsed = thumbnailPanel.classList.toggle("collapsed");
    toggleSidebarBtn.setAttribute("aria-pressed", String(!collapsed));
});

pageInput.addEventListener("change", () => {
    const value = parseInt(pageInput.value, 10);
    if (!Number.isNaN(value)) {
        goToPage(value);
    }
});

document.getElementById("btn-zoom-in").addEventListener("click", () => {
    scale = Math.min(MAX_ZOOM, scale + ZOOM_STEP);
    requestRerender(false);
});

document.getElementById("btn-zoom-out").addEventListener("click", () => {
    scale = Math.max(MIN_ZOOM, scale - ZOOM_STEP);
    requestRerender(false);
});

document.getElementById("btn-rotate-left").addEventListener("click", () => {
    rotation = (rotation + 270) % 360; // -90, kept positive for pdf.js's rotation param
    requestRerender(true);
});

document.getElementById("btn-rotate-right").addEventListener("click", () => {
    rotation = (rotation + 90) % 360;
    requestRerender(true);
});

document.addEventListener("keydown", (event) => {
    if (event.target === pageInput || event.target === searchInput) return;
    if (event.key === "ArrowLeft") goToPage(currentPage - 1);
    if (event.key === "ArrowRight") goToPage(currentPage + 1);
});

loadDocument().catch((err) => {
    console.error(err);
    const message = err?.name === "PasswordException" || err?.message === "password-cancelled"
        ? "ยกเลิกการเปิดเอกสาร เนื่องจากไม่ได้กรอกรหัสผ่าน"
        : "ไม่สามารถโหลดเอกสารได้ หรือลิงก์หมดอายุ";
    root.innerHTML = `<p style="padding:24px">${message}</p>`;
});
