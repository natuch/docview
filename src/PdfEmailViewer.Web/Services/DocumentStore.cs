using System.Collections.Concurrent;
using PdfEmailViewer.Web.Models;

namespace PdfEmailViewer.Web.Services;

/// <summary>
/// In-memory document registry keyed by an opaque id, so the browser never
/// sees a real file path or name it could use to construct a download URL.
/// Suitable for a single-instance demo; swap for a distributed cache (Redis)
/// behind a load balancer.
/// </summary>
public sealed class DocumentStore : IDocumentStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(2);
    private readonly ConcurrentDictionary<Guid, DocumentRecord> _documents = new();

    public Guid Save(string displayName, byte[] pdfBytes)
    {
        EvictExpired();

        var id = Guid.NewGuid();
        _documents[id] = new DocumentRecord
        {
            Id = id,
            DisplayName = displayName,
            PdfBytes = pdfBytes,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        return id;
    }

    public DocumentRecord? Get(Guid id)
    {
        if (_documents.TryGetValue(id, out var record) && DateTimeOffset.UtcNow - record.CreatedAt < Ttl)
        {
            return record;
        }

        return null;
    }

    private void EvictExpired()
    {
        var cutoff = DateTimeOffset.UtcNow - Ttl;
        foreach (var (id, record) in _documents)
        {
            if (record.CreatedAt < cutoff)
            {
                _documents.TryRemove(id, out _);
            }
        }
    }
}
