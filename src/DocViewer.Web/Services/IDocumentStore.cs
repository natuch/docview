using DocViewer.Web.Models;

namespace DocViewer.Web.Services;

public interface IDocumentStore
{
    Guid Save(string displayName, byte[] pdfBytes);

    DocumentRecord? Get(Guid id);

    void Remove(Guid id);
}
