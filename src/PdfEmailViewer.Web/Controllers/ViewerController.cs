using Microsoft.AspNetCore.Mvc;
using PdfEmailViewer.Web.Services;

namespace PdfEmailViewer.Web.Controllers;

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
}
