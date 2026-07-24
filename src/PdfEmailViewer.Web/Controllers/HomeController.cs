using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using PdfEmailViewer.Web.Models;
using PdfEmailViewer.Web.Services;

namespace PdfEmailViewer.Web.Controllers;

public class HomeController : Controller
{
    private static readonly string[] SupportedExtensions = [".pdf", ".eml", ".msg"];

    private readonly ILogger<HomeController> _logger;
    private readonly IDocumentStore _documentStore;
    private readonly IEmailToPdfConverter _emailConverter;

    public HomeController(ILogger<HomeController> logger, IDocumentStore documentStore, IEmailToPdfConverter emailConverter)
    {
        _logger = logger;
        _documentStore = documentStore;
        _emailConverter = emailConverter;
    }

    public IActionResult Index()
    {
        return View();
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    [RequestSizeLimit(50 * 1024 * 1024)]
    public async Task<IActionResult> Upload(IFormFile file)
    {
        if (file is null || file.Length == 0)
        {
            ModelState.AddModelError(string.Empty, "กรุณาเลือกไฟล์ .pdf, .eml หรือ .msg");
            return View(nameof(Index));
        }

        var extension = Path.GetExtension(file.FileName);
        if (!SupportedExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase))
        {
            ModelState.AddModelError(string.Empty, "รองรับเฉพาะไฟล์ .pdf, .eml, .msg เท่านั้น");
            return View(nameof(Index));
        }

        await using var stream = file.OpenReadStream();

        byte[] pdfBytes;
        if (extension.Equals(".pdf", StringComparison.OrdinalIgnoreCase))
        {
            using var memory = new MemoryStream();
            await stream.CopyToAsync(memory);
            pdfBytes = memory.ToArray();
        }
        else
        {
            pdfBytes = await _emailConverter.ConvertAsync(stream, file.FileName, HttpContext.RequestAborted);
        }

        var id = _documentStore.Save(file.FileName, pdfBytes);
        return RedirectToAction("Index", "Viewer", new { id });
    }

    public IActionResult Privacy()
    {
        return View();
    }

    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error()
    {
        return View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
    }
}
