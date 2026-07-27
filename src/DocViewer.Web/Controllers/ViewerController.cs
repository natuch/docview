using Microsoft.AspNetCore.Mvc;
using DocViewer.Web.Services;

namespace DocViewer.Web.Controllers;

public sealed class ViewerController : Controller
{
    private readonly IDocumentStore _documentStore;

    public ViewerController(IDocumentStore documentStore)
    {
        _documentStore = documentStore;
    }

    [HttpGet("/Viewer/{id:guid}")]
    public IActionResult Index(Guid id)
    {
        var document = _documentStore.Get(id);
        if (document is null)
        {
            return NotFound();
        }

        ViewData["DocumentId"] = id;
        ViewData["DisplayName"] = document.DisplayName;
        return View();
    }

    /// <summary>
    /// Streams the PDF bytes for the pdf.js viewer to consume. Served through
    /// an action (not a static file) behind an opaque id, with cache-busting
    /// headers and an inline disposition carrying no filename, so there is no
    /// convenient "Save As" target and the URL alone is useless without a
    /// valid, still-live document id.
    /// </summary>
    [HttpGet("/Viewer/{id:guid}/stream")]
    public IActionResult Stream(Guid id)
    {
        var document = _documentStore.Get(id);
        if (document is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        Response.Headers.Pragma = "no-cache";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers.ContentDisposition = "inline";

        return File(document.PdfBytes, "application/pdf");
    }

    /// <summary>
    /// Called via <c>navigator.sendBeacon</c> when the viewer page unloads, so the
    /// converted PDF is dropped from memory as soon as the user is done with it
    /// rather than lingering for the full TTL fallback window. Beacon requests
    /// can't read a response, so this always returns 204 regardless of whether
    /// the id was still present.
    /// </summary>
    [HttpPost("/Viewer/{id:guid}/release")]
    public IActionResult Release(Guid id)
    {
        _documentStore.Remove(id);
        return NoContent();
    }
}
