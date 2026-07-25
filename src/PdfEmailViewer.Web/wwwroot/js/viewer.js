import * as pdfjsLib from "/lib/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/lib/pdfjs/pdf.worker.mjs";

const root = document.getElementById("viewer-root");
const streamUrl = root.dataset.streamUrl;

const canvasContainer = document.getElementById("canvas-container");
const pagesContainer = document.getElementById("pages-container");

const pageInput = document.getElementById("page-input");
const pageCountEl = document.getElementById("page-count");
const zoomLevelEl = document.getElementById("zoom-level");

const thumbnailPanel = document.getElementById("thumbnail-panel");
const thumbnailList = document.getElementById("thumbnail-list");
const toggleSidebarBtn = document.getElementById("btn-toggle-sidebar");

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

async function loadDocument() {
    // fetch (not a direct <a href> / <embed>) keeps the PDF bytes out of
    // browser history and the "open in new tab" / save-target surface.
    const response = await fetch(streamUrl, { credentials: "same-origin" });
    if (!response.ok) {
        throw new Error(`Failed to load document: ${response.status}`);
    }
    const data = await response.arrayBuffer();
    pdfDocument = await pdfjsLib.getDocument({ data }).promise;
    pageCountEl.textContent = String(pdfDocument.numPages);
    pageInput.max = String(pdfDocument.numPages);

    await buildPages();
    await renderAllPages();
    buildThumbnails().catch((err) => console.error(err));
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
        const linkLayer = document.createElement("div");
        linkLayer.className = "link-layer";

        wrapper.appendChild(canvas);
        wrapper.appendChild(linkLayer);
        pagesContainer.appendChild(wrapper);

        pageEntries.push({ pageNumber, page, wrapper, canvas, linkLayer });
        pageVisibilityObserver.observe(wrapper);
    }
}

async function renderAllPages() {
    for (const entry of pageEntries) {
        await renderPageEntry(entry);
    }
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

    const transform = OUTPUT_SCALE !== 1 ? [OUTPUT_SCALE, 0, 0, OUTPUT_SCALE, 0, 0] : null;

    try {
        await entry.page.render({ canvasContext: entry.canvas.getContext("2d"), viewport, transform }).promise;
    } catch (err) {
        console.error(err);
    }

    await renderLinks(entry, viewport);
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

async function rerenderAllPages() {
    await renderAllPages();

    const entry = pageEntries[currentPage - 1];
    if (entry) {
        suppressScrollTracking = true;
        entry.wrapper.scrollIntoView({ behavior: "auto", block: "start" });
        window.setTimeout(() => { suppressScrollTracking = false; }, 300);
    }
}

async function buildThumbnails() {
    thumbnailList.innerHTML = "";
    thumbnailButtons = [];

    for (const entry of pageEntries) {
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

        try {
            await entry.page.render({ canvasContext: thumbCanvas.getContext("2d"), viewport }).promise;
        } catch (err) {
            console.error(err);
        }
    }

    updateActiveThumbnail();
}

function updateActiveThumbnail() {
    for (const button of thumbnailButtons) {
        const isActive = Number(button.dataset.page) === currentPage;
        button.classList.toggle("active", isActive);
        if (isActive) {
            button.scrollIntoView({ block: "nearest" });
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
    entry.wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
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
    rerenderAllPages();
});

document.getElementById("btn-zoom-out").addEventListener("click", () => {
    scale = Math.max(MIN_ZOOM, scale - ZOOM_STEP);
    rerenderAllPages();
});

document.getElementById("btn-rotate").addEventListener("click", () => {
    rotation = (rotation + 90) % 360;
    rerenderAllPages();
    buildThumbnails().catch((err) => console.error(err));
});

document.addEventListener("keydown", (event) => {
    if (event.target === pageInput) return;
    if (event.key === "ArrowLeft") goToPage(currentPage - 1);
    if (event.key === "ArrowRight") goToPage(currentPage + 1);
});

loadDocument().catch((err) => {
    console.error(err);
    root.innerHTML = "<p style=\"padding:24px\">ไม่สามารถโหลดเอกสารได้ หรือลิงก์หมดอายุ</p>";
});
