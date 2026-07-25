# PdfEmailViewer

A web-based document viewer built with ASP.NET Core MVC and PDF.js. Upload a PDF or an email (`.eml` / `.msg`) and view it in the browser through a custom toolbar — zoom in/out, rotate, page navigation — without a download button, right-click, or text selection.

## Features

- **PDF viewing** via [PDF.js](https://mozilla.github.io/pdf.js/), rendered to `<canvas>` with a hand-built toolbar (no bundled `viewer.html`, so there's no built-in download/print/open-file UI to hide).
- **Email viewing** — `.eml` (via [MimeKit](https://github.com/jstedfast/MimeKit)) and `.msg` (via [MsgReader](https://github.com/Sicos1977/MSGReader)) are converted to a single HTML document (header block + body, with inline `cid:` images resolved to data URIs) and rasterized to PDF using headless Chromium via [PuppeteerSharp](https://github.com/hardkoded/puppeteer-sharp), so they go through the same viewer as native PDFs.
- **No download / no copy (UX-level)** — the PDF stream is served with `Cache-Control: no-store` and an `inline` disposition with no filename, and the viewer blocks right-click, text selection, drag, and common save/print shortcuts. This is a UX deterrent, not DRM — the PDF bytes are still reachable via dev tools/network tab by design.

## Requirements

- [.NET 9 SDK](https://dotnet.microsoft.com/download)
- Network access on first email upload, so PuppeteerSharp can download headless Chromium (cached afterwards)

## Getting started

```bash
dotnet build
dotnet run --project src/PdfEmailViewer.Web
```

Then open the URL shown in the console (see `src/PdfEmailViewer.Web/Properties/launchSettings.json`), upload a `.pdf`, `.eml`, or `.msg` file from the home page, and you'll be redirected to the viewer.

## Project layout

```
src/PdfEmailViewer.Web/
├── Controllers/     HomeController (upload), ViewerController (viewer shell + PDF stream)
├── Services/        IDocumentStore (in-memory, TTL'd registry), IEmailToPdfConverter
├── Views/           Home/Viewer Razor views
└── wwwroot/
    ├── js/          viewer.js (PDF.js + toolbar), protect.js (UX deterrents)
    └── lib/pdfjs/   vendored pdf.js build (pdf.mjs + pdf.worker.mjs)
```

See [CLAUDE.md](./CLAUDE.md) for a deeper architecture walkthrough and known SDK workarounds.

## Notes

- Documents are kept in an in-memory store keyed by an opaque id with a 2-hour TTL — nothing is written to disk, and the store is per-instance (swap for a distributed cache like Redis if running more than one instance).
- There is no authentication yet — anyone with a live document id can view it.
