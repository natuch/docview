using PdfEmailViewer.Web.Models;

namespace PdfEmailViewer.Web.Services;

public interface IDocumentStore
{
    Guid Save(string displayName, byte[] pdfBytes);

    DocumentRecord? Get(Guid id);
}
