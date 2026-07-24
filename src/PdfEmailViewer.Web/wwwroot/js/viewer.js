import * as pdfjsLib from "/lib/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/lib/pdfjs/pdf.worker.mjs";

const root = document.getElementById("viewer-root");
const streamUrl = root.dataset.streamUrl;

const canvas = document.getElementById("pdf-canvas");
const ctx = canvas.getContext("2d");

const pageInput = document.getElementById("page-input");
const pageCountEl = document.getElementById("page-count");
const zoomLevelEl = document.getElementById("zoom-level");

const ZOOM_STEP = 0.15;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

let pdfDocument = null;
let currentPage = 1;
let scale = 1;
let rotation = 0;
let renderTask = null;

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
    await renderPage(currentPage);
}

async function renderPage(pageNumber) {
    if (!pdfDocument) return;
    pageNumber = Math.min(Math.max(pageNumber, 1), pdfDocument.numPages);
    currentPage = pageNumber;
    pageInput.value = String(pageNumber);

    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale, rotation });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    if (renderTask) {
        renderTask.cancel();
    }

    renderTask = page.render({ canvasContext: ctx, viewport });
    try {
        await renderTask.promise;
    } catch (err) {
        if (err?.name !== "RenderingCancelledException") {
            console.error(err);
        }
    }

    zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
}

document.getElementById("btn-prev").addEventListener("click", () => renderPage(currentPage - 1));
document.getElementById("btn-next").addEventListener("click", () => renderPage(currentPage + 1));

pageInput.addEventListener("change", () => {
    const value = parseInt(pageInput.value, 10);
    if (!Number.isNaN(value)) {
        renderPage(value);
    }
});

document.getElementById("btn-zoom-in").addEventListener("click", () => {
    scale = Math.min(MAX_ZOOM, scale + ZOOM_STEP);
    renderPage(currentPage);
});

document.getElementById("btn-zoom-out").addEventListener("click", () => {
    scale = Math.max(MIN_ZOOM, scale - ZOOM_STEP);
    renderPage(currentPage);
});

document.getElementById("btn-rotate").addEventListener("click", () => {
    rotation = (rotation + 90) % 360;
    renderPage(currentPage);
});

document.addEventListener("keydown", (event) => {
    if (event.target === pageInput) return;
    if (event.key === "ArrowLeft") renderPage(currentPage - 1);
    if (event.key === "ArrowRight") renderPage(currentPage + 1);
});

loadDocument().catch((err) => {
    console.error(err);
    root.innerHTML = "<p style=\"padding:24px\">ไม่สามารถโหลดเอกสารได้ หรือลิงก์หมดอายุ</p>";
});
