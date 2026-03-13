import logging
from pathlib import Path
from typing import Protocol

from google.cloud.storage import Blob, Bucket  # type: ignore[import-untyped]
from google.cloud.storage import Client as GCSClient  # type: ignore[import-untyped]

log = logging.getLogger(__name__)


class RawStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...


class LocalStore:
    def __init__(self, base_dir: str | Path) -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def put(self, key: str, data: bytes) -> None:
        path = self.base_dir / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        return (self.base_dir / key).read_bytes()

    def exists(self, key: str) -> bool:
        return (self.base_dir / key).exists()


class GCSStore:
    def __init__(self, bucket_name: str, project: str | None = None, prefix: str = "") -> None:
        import os

        # Temporarily unset GOOGLE_APPLICATION_CREDENTIALS so the SDK uses
        # the user's application default credentials instead of a service account.
        saved = os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        try:
            self._client: GCSClient = GCSClient(project=project)
        finally:
            if saved is not None:
                os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = saved
        self._bucket: Bucket = self._client.bucket(bucket_name)
        self._prefix = prefix

    def _blob_name(self, key: str) -> str:
        return f"{self._prefix}/{key}" if self._prefix else key

    def put(self, key: str, data: bytes) -> None:
        blob: Blob = self._bucket.blob(self._blob_name(key))
        blob.upload_from_string(data)
        log.debug("Uploaded to GCS: gs://%s/%s", self._bucket.name, blob.name)

    def get(self, key: str) -> bytes:
        blob: Blob = self._bucket.blob(self._blob_name(key))
        result: bytes = blob.download_as_bytes()
        return result

    def exists(self, key: str) -> bool:
        blob: Blob = self._bucket.blob(self._blob_name(key))
        result: bool = blob.exists()
        return result


class DualStore:
    """Writes to both a local store and a remote store."""

    def __init__(self, local: LocalStore, remote: RawStore) -> None:
        self._local = local
        self._remote = remote

    def put(self, key: str, data: bytes) -> None:
        self._local.put(key, data)
        self._remote.put(key, data)

    def get(self, key: str) -> bytes:
        return self._local.get(key)

    def exists(self, key: str) -> bool:
        return self._local.exists(key)
