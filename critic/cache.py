"""
Cache - Persistent caching for analysis results.

Caches:
- Document chunks (based on content hash)
- Discovery results (per document)
- Per-chunk extraction results (per chunk content hash)
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, TYPE_CHECKING

from critic.types import Chunk
from critic.schema import ChunkExtraction

if TYPE_CHECKING:
    from critic.discovery import DiscoveryResult, DiscoveredEntities


CACHE_VERSION = "1.0.0"


@dataclass
class CacheStats:
    """Cache statistics."""
    chunks: int
    discovery: int
    extraction: int
    total_size: str


class AnalysisCache:
    """Persistent cache for analysis results."""

    def __init__(
        self,
        cache_dir: Optional[str] = None,
        enabled: bool = True,
    ):
        self.enabled = enabled
        self.cache_dir = Path(cache_dir) if cache_dir else Path.cwd() / ".book-editor-cache"

        if self.enabled:
            self._ensure_cache_dir()

    def _ensure_cache_dir(self) -> None:
        """Create cache directory structure."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for subdir in ["chunks", "discovery", "extraction"]:
            (self.cache_dir / subdir).mkdir(exist_ok=True)

    @staticmethod
    def hash(content: str) -> str:
        """Generate a hash for content."""
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    def hash_discovered_entities(self, entities: "DiscoveredEntities") -> str:
        """Create a hash of discovered entities for cache key purposes."""
        stable = json.dumps({
            'characters': sorted([c.name for c in entities.characters]),
            'plot_threads': sorted([t.name for t in entities.plot_threads]),
        })
        return self.hash(stable)

    def get_chunks(self, document_content: str) -> Optional[list[Chunk]]:
        """Get cached chunks for a document."""
        if not self.enabled:
            return None

        doc_hash = self.hash(document_content)
        cache_path = self.cache_dir / "chunks" / f"{doc_hash}.json"

        try:
            if cache_path.exists():
                data = json.loads(cache_path.read_text())
                if data.get('metadata', {}).get('version') == CACHE_VERSION:
                    print(f"[Cache] Using cached chunks for document {doc_hash}")
                    return [
                        Chunk(
                            id=c['id'],
                            title=c.get('title'),
                            content=c['content'],
                            start_paragraph=c.get('start_paragraph', 0),
                            end_paragraph=c.get('end_paragraph', 0),
                        )
                        for c in data['chunks']
                    ]
        except Exception as e:
            print(f"[Cache] Error reading chunks cache: {e}")

        return None

    def set_chunks(self, document_content: str, chunks: list[Chunk]) -> None:
        """Save chunks to cache."""
        if not self.enabled:
            return

        doc_hash = self.hash(document_content)
        cache_path = self.cache_dir / "chunks" / f"{doc_hash}.json"

        cache_data = {
            'metadata': {
                'version': CACHE_VERSION,
            },
            'document_hash': doc_hash,
            'chunks': [
                {
                    'id': c.id,
                    'title': c.title,
                    'content': c.content,
                    'start_paragraph': c.start_paragraph,
                    'end_paragraph': c.end_paragraph,
                }
                for c in chunks
            ],
        }

        try:
            cache_path.write_text(json.dumps(cache_data))
            print(f"[Cache] Saved chunks for document {doc_hash}")
        except Exception as e:
            print(f"[Cache] Error writing chunks cache: {e}")

    def get_discovery(
        self,
        document_content: str,
        model: str,
    ) -> Optional["DiscoveryResult"]:
        """Get cached discovery results for a document."""
        if not self.enabled:
            return None

        from .discovery import DiscoveryResult, DiscoveredEntities, DiscoveredCharacter, DiscoveredThread

        doc_hash = self.hash(document_content)
        model_hash = self.hash(model)
        cache_path = self.cache_dir / "discovery" / f"{doc_hash}-{model_hash}.json"

        try:
            if cache_path.exists():
                data = json.loads(cache_path.read_text())
                if (data.get('metadata', {}).get('version') == CACHE_VERSION and
                    data.get('metadata', {}).get('model') == model):
                    print(f"[Cache] Using cached discovery for document {doc_hash}")

                    entities_data = data['entities']
                    entities = DiscoveredEntities(
                        characters=[
                            DiscoveredCharacter(
                                name=c['name'],
                                aliases=c.get('aliases', []),
                                description=c.get('description'),
                            )
                            for c in entities_data.get('characters', [])
                        ],
                        plot_threads=[
                            DiscoveredThread(
                                name=t['name'],
                                description=t['description'],
                                central_question=t.get('central_question'),
                            )
                            for t in entities_data.get('plot_threads', [])
                        ],
                        locations=entities_data.get('locations', []),
                    )

                    return DiscoveryResult(
                        entities=entities,
                        token_usage=data['token_usage'],
                    )
        except Exception as e:
            print(f"[Cache] Error reading discovery cache: {e}")

        return None

    def set_discovery(
        self,
        document_content: str,
        model: str,
        result: "DiscoveryResult",
    ) -> None:
        """Save discovery results to cache."""
        if not self.enabled:
            return

        doc_hash = self.hash(document_content)
        model_hash = self.hash(model)
        cache_path = self.cache_dir / "discovery" / f"{doc_hash}-{model_hash}.json"

        cache_data = {
            'metadata': {
                'version': CACHE_VERSION,
                'model': model,
            },
            'document_hash': doc_hash,
            'entities': {
                'characters': [
                    {
                        'name': c.name,
                        'aliases': c.aliases,
                        'description': c.description,
                    }
                    for c in result.entities.characters
                ],
                'plot_threads': [
                    {
                        'name': t.name,
                        'description': t.description,
                        'central_question': t.central_question,
                    }
                    for t in result.entities.plot_threads
                ],
                'locations': result.entities.locations,
            },
            'token_usage': result.token_usage,
        }

        try:
            cache_path.write_text(json.dumps(cache_data))
            print(f"[Cache] Saved discovery for document {doc_hash}")
        except Exception as e:
            print(f"[Cache] Error writing discovery cache: {e}")

    def get_extraction(
        self,
        chunk_content: str,
        chunk_id: str,
        model: str,
        entities_hash: str,
    ) -> Optional[tuple[ChunkExtraction, dict]]:
        """Get cached extraction for a single chunk."""
        if not self.enabled:
            return None

        chunk_hash = self.hash(chunk_content)
        model_hash = self.hash(model)
        context_hash = self.hash(entities_hash)
        cache_path = self.cache_dir / "extraction" / f"{chunk_hash}-{model_hash}-{context_hash}.json"

        try:
            if cache_path.exists():
                data = json.loads(cache_path.read_text())
                if (data.get('metadata', {}).get('version') == CACHE_VERSION and
                    data.get('metadata', {}).get('model') == model):
                    print(f"[Cache] Using cached extraction for chunk {chunk_id}")
                    extraction = ChunkExtraction.model_validate(data['extraction'])
                    return extraction, data['token_usage']
        except Exception as e:
            print(f"[Cache] Error reading extraction cache: {e}")

        return None

    def set_extraction(
        self,
        chunk_content: str,
        model: str,
        entities_hash: str,
        extraction: ChunkExtraction,
        token_usage: dict,
    ) -> None:
        """Save extraction results for a single chunk."""
        if not self.enabled:
            return

        # Don't cache empty/failed extractions
        if (not extraction.events and
            not extraction.character_mentions and
            not extraction.facts):
            print("[Cache] Skipping cache for empty extraction (likely failed)")
            return

        chunk_hash = self.hash(chunk_content)
        model_hash = self.hash(model)
        context_hash = self.hash(entities_hash)
        cache_path = self.cache_dir / "extraction" / f"{chunk_hash}-{model_hash}-{context_hash}.json"

        cache_data = {
            'metadata': {
                'version': CACHE_VERSION,
                'model': model,
            },
            'chunk_hash': chunk_hash,
            'extraction': extraction.model_dump(),
            'token_usage': token_usage,
        }

        try:
            cache_path.write_text(json.dumps(cache_data))
        except Exception as e:
            print(f"[Cache] Error writing extraction cache: {e}")

    def clear(self) -> None:
        """Clear all cached data."""
        if not self.enabled:
            return

        import shutil
        try:
            shutil.rmtree(self.cache_dir)
            self._ensure_cache_dir()
            print("[Cache] Cache cleared")
        except Exception as e:
            print(f"[Cache] Error clearing cache: {e}")

    def get_stats(self) -> CacheStats:
        """Get cache statistics."""
        if not self.enabled:
            return CacheStats(chunks=0, discovery=0, extraction=0, total_size="0 B")

        def count_files(subdir: str) -> int:
            try:
                return len(list((self.cache_dir / subdir).glob("*.json")))
            except OSError:
                return 0

        def get_dir_size(subdir: str) -> int:
            try:
                return sum(
                    f.stat().st_size
                    for f in (self.cache_dir / subdir).glob("*.json")
                )
            except OSError:
                return 0

        total_bytes = (
            get_dir_size("chunks") +
            get_dir_size("discovery") +
            get_dir_size("extraction")
        )

        if total_bytes < 1024:
            total_size = f"{total_bytes} B"
        elif total_bytes < 1024 * 1024:
            total_size = f"{total_bytes / 1024:.1f} KB"
        else:
            total_size = f"{total_bytes / 1024 / 1024:.1f} MB"

        return CacheStats(
            chunks=count_files("chunks"),
            discovery=count_files("discovery"),
            extraction=count_files("extraction"),
            total_size=total_size,
        )

    def invalidate_stale_extractions(self, current_entities_hash: str) -> int:
        """Remove extraction cache entries that don't match the current entities hash.

        Returns number of files removed.
        """
        if not self.enabled:
            return 0

        extraction_dir = self.cache_dir / "extraction"
        if not extraction_dir.exists():
            return 0

        context_hash = self.hash(current_entities_hash)
        removed = 0

        for f in extraction_dir.glob("*.json"):
            # Cache filename format: chunk_hash-model_hash-context_hash.json
            parts = f.stem.split('-')
            if len(parts) >= 3 and parts[2] != context_hash:
                f.unlink()
                removed += 1

        if removed > 0:
            print(f"[Cache] Invalidated {removed} stale extraction cache entries")

        return removed
