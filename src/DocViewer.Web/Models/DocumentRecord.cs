namespace DocViewer.Web.Models;

public sealed class DocumentRecord
{
    public required Guid Id { get; init; }
    public required string DisplayName { get; init; }
    public required byte[] PdfBytes { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }

    // Set when the viewer's unload beacon asks to release this document (see
    // DocumentStore.Remove). Not a hard delete - a page refresh fires the exact
    // same "pagehide" event as actually closing the tab, so a request for this
    // document arriving shortly after clears this instead of deleting it outright.
    public DateTimeOffset? ReleaseRequestedAt { get; set; }
}
