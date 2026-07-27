namespace DocViewer.Web.Services;

public interface IDocumentConverter
{
    /// <summary>Converts a non-PDF document (.eml, .msg, .txt, image, .docx, .xlsx, ...) into a PDF rendering.</summary>
    Task<byte[]> ConvertAsync(Stream sourceStream, string fileName, CancellationToken cancellationToken = default);
}
