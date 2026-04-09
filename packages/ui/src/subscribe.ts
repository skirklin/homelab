/**
 * PocketBase subscription helpers — the equivalent of Firebase's onSnapshot.
 * Combines initial data fetch + realtime subscription in one call, with
 * proper $autoCancel: false, cancelled() guards, and cleanup.
 */
import type { RecordModel } from "pocketbase";
import { getBackend } from "./backend";

type Cancelled = () => boolean;
type Cleanup = () => void;

/**
 * Subscribe to a single PocketBase record with initial data load.
 *
 * Fetches the record via getOne(), then subscribes to realtime changes.
 * All callbacks are guarded by the cancelled() function.
 */
export function subscribeToRecord(
  collection: string,
  id: string,
  cancelled: Cancelled,
  callbacks: {
    onData: (record: RecordModel) => void;
    onDelete?: () => void;
    onError?: (err: unknown) => void;
  },
): Cleanup {
  const pb = getBackend();
  let unsub: (() => void) | undefined;

  // Load initial data
  pb.collection(collection)
    .getOne(id, { $autoCancel: false })
    .then((record) => {
      if (!cancelled()) callbacks.onData(record);
    })
    .catch((err) => {
      if (!cancelled()) callbacks.onError?.(err);
    });

  // Subscribe to changes
  pb.collection(collection).subscribe(id, (e) => {
    if (cancelled()) return;
    if (e.action === "delete") {
      callbacks.onDelete?.();
    } else {
      callbacks.onData(e.record);
    }
  }).then((fn) => { unsub = fn; });

  return () => {
    unsub?.();
  };
}

interface CollectionOptions {
  /** PocketBase filter expression, e.g. `list = "abc123"` */
  filter: string;
  /** Sort expression, e.g. `-timestamp` */
  sort?: string;
  /** Called once with all matching records after initial fetch */
  onInitial: (records: RecordModel[]) => void;
  /** Called for each realtime create/update/delete */
  onChange: (action: "create" | "update" | "delete", record: RecordModel) => void;
  /** Filter realtime events to only records in scope (e.g. matching parent ID) */
  belongsTo?: (record: RecordModel) => boolean;
  /** Called on fetch error */
  onError?: (err: unknown) => void;
}

interface PaginatedCollectionOptions {
  /** PocketBase filter expression */
  filter: string;
  sort?: string;
  page: number;
  perPage: number;
  /** Called once with the page of records */
  onInitial: (records: RecordModel[]) => void;
  /** On any realtime change, re-fetch the entire page */
  onAnyChange: (records: RecordModel[]) => void;
  belongsTo?: (record: RecordModel) => boolean;
  onError?: (err: unknown) => void;
}

/**
 * Subscribe to a filtered PocketBase collection with initial data load.
 *
 * Fetches all matching records via getFullList(), then subscribes to "*"
 * for realtime changes. The belongsTo filter prevents processing events
 * from unrelated records in the same collection.
 */
export function subscribeToCollection(
  collection: string,
  cancelled: Cancelled,
  options: CollectionOptions,
): Cleanup {
  const pb = getBackend();
  const { filter, sort, onInitial, onChange, belongsTo, onError } = options;
  let unsub: (() => void) | undefined;

  // Load initial data
  pb.collection(collection)
    .getFullList({ filter, sort, $autoCancel: false })
    .then((records) => {
      if (!cancelled()) onInitial(records);
    })
    .catch((err) => {
      if (!cancelled()) onError?.(err);
    });

  // Subscribe to changes
  pb.collection(collection).subscribe("*", (e) => {
    if (cancelled()) return;
    if (belongsTo && !belongsTo(e.record)) return;
    onChange(e.action as "create" | "update" | "delete", e.record);
  }).then((fn) => { unsub = fn; });

  return () => {
    unsub?.();
  };
}

/**
 * Subscribe to a paginated PocketBase collection that reloads entirely
 * on any change. Used for collections where incremental updates are
 * impractical (e.g. sorted history, recent events).
 */
export function subscribeToCollectionReload(
  collection: string,
  cancelled: Cancelled,
  options: PaginatedCollectionOptions,
): Cleanup {
  const pb = getBackend();
  const { filter, sort, page, perPage, onInitial, onAnyChange, belongsTo, onError } = options;
  let unsub: (() => void) | undefined;

  const fetchOpts = { filter, sort, $autoCancel: false };

  // Load initial data
  pb.collection(collection)
    .getList(page, perPage, fetchOpts)
    .then((result) => {
      if (!cancelled()) onInitial(result.items);
    })
    .catch((err) => {
      if (!cancelled()) onError?.(err);
    });

  // On any change, re-fetch
  pb.collection(collection).subscribe("*", (e) => {
    if (cancelled()) return;
    if (belongsTo && !belongsTo(e.record)) return;
    pb.collection(collection)
      .getList(page, perPage, fetchOpts)
      .then((result) => {
        if (!cancelled()) onAnyChange(result.items);
      })
      .catch((err) => {
        if (!cancelled()) onError?.(err);
      });
  }).then((fn) => { unsub = fn; });

  return () => {
    unsub?.();
  };
}
