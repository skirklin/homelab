/**
 * Views editor — the Settings surface over `manifest.views` (the Unified
 * Capture primitive). A View is a named, ordered set of capture items rendered
 * for human input (the morning/evening/weekly wizards are Views). This editor
 * lists the user's Views, edits each View's metadata (title/greeting/icon/
 * render) and its `items[]` (capture / tasks_due / banner), and mutates the
 * manifest via the add/update/remove/reorder backend ops + `applyManifest`.
 *
 * `view.id` is IMMUTABLE (it is written to `life_events.labels.view`, the
 * history join key). We generate it ONCE from the title on create and never
 * offer to edit it; backend validation errors are surfaced to the user.
 */
import { useCallback, useState } from "react";
import styled from "styled-components";
import { Button, Input, Select, Collapse } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import {
  ManifestError,
  slugifyTrackableId,
  type LifeManifest,
  type LifeView,
  type LifeViewItem,
  type LifeManifestTrackable,
  type TemplateRef,
} from "@homelab/backend";

const Empty = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  padding: var(--space-xs) 0;
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--space-sm);
`;

const FieldLabel = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const ItemRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-xs);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-xs);
`;

const ItemHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
`;

const RefRow = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
`;

const ViewTitle = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  width: 100%;
`;

interface ViewsEditorProps {
  logId: string | undefined;
  views: LifeView[];
  trackables: LifeManifestTrackable[];
  applyManifest: (work: () => Promise<LifeManifest>) => Promise<LifeManifest>;
}

export function ViewsEditor({ logId, views, trackables, applyManifest }: ViewsEditorProps) {
  const life = useLifeBackend();
  const { message } = useFeedback();
  const [newTitle, setNewTitle] = useState("");

  const trackableOptions = trackables.map((t) => ({ label: t.label, value: t.id }));

  const run = useCallback(
    async (work: () => Promise<LifeManifest>) => {
      try {
        await applyManifest(work);
      } catch (err) {
        console.error("View mutation failed:", err);
        message.error(err instanceof ManifestError ? err.message : "Failed to save view");
      }
    },
    [applyManifest, message],
  );

  const handleAdd = useCallback(() => {
    if (!logId) return;
    const title = newTitle.trim();
    const base = slugifyTrackableId(title);
    if (!base) {
      message.warning("Give the view a name with at least one letter or number.");
      return;
    }
    let id = base;
    let n = 2;
    const taken = new Set(views.map((v) => v.id));
    while (taken.has(id)) id = `${base}-${n++}`;
    void run(() => life.addView(logId, { id, title, render: "guided", items: [] })).then(() =>
      setNewTitle(""),
    );
  }, [logId, newTitle, views, life, run, message]);

  /** Replace a view's items wholesale via updateView (the only items mutation). */
  const setItems = useCallback(
    (view: LifeView, items: LifeViewItem[]) => {
      if (!logId) return;
      void run(() => life.updateView(logId, view.id, { items }));
    },
    [logId, life, run],
  );

  if (!logId) return <Empty>Loading…</Empty>;

  return (
    <div>
      {views.length === 0 && <Empty>No views. Add one to define a capture session.</Empty>}

      {views.length > 0 && (
        <Collapse
          accordion
          size="small"
          items={views.map((view) => ({
            key: view.id,
            label: (
              <ViewTitle>
                <span style={{ flex: 1 }}>{view.title}</span>
                <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                  {view.render ?? "guided"} · {view.items.length}
                </span>
              </ViewTitle>
            ),
            children: (
              <ViewBody
                view={view}
                logId={logId}
                trackableOptions={trackableOptions}
                run={run}
                life={life}
                setItems={setItems}
              />
            ),
          }))}
        />
      )}

      <ViewTitle style={{ marginTop: "var(--space-sm)" }}>
        <Input
          size="small"
          placeholder="New view title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onPressEnter={handleAdd}
          data-testid="view-new-title"
        />
        <Button
          type="dashed"
          size="small"
          icon={<PlusOutlined />}
          onClick={handleAdd}
          data-testid="view-add"
        >
          Add
        </Button>
      </ViewTitle>
    </div>
  );
}

interface ViewBodyProps {
  view: LifeView;
  logId: string;
  trackableOptions: { label: string; value: string }[];
  run: (work: () => Promise<LifeManifest>) => Promise<void>;
  life: ReturnType<typeof useLifeBackend>;
  setItems: (view: LifeView, items: LifeViewItem[]) => void;
}

function ViewBody({ view, logId, trackableOptions, run, life, setItems }: ViewBodyProps) {
  const updateItem = (idx: number, next: LifeViewItem) => {
    const items = view.items.slice();
    items[idx] = next;
    setItems(view, items);
  };
  const removeItem = (idx: number) => {
    setItems(view, view.items.filter((_, i) => i !== idx));
  };
  const moveItem = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= view.items.length) return;
    const items = view.items.slice();
    [items[idx], items[j]] = [items[j], items[idx]];
    setItems(view, items);
  };
  const addItem = (kind: LifeViewItem["kind"]) => {
    let item: LifeViewItem;
    if (kind === "capture") item = { kind: "capture", trackableId: trackableOptions[0]?.value ?? "" };
    else if (kind === "tasks_due") item = { kind: "tasks_due" };
    else item = { kind: "banner", text: "Banner text", refs: [] };
    setItems(view, [...view.items, item]);
  };

  return (
    <div>
      <Field>
        <FieldLabel>Title</FieldLabel>
        <Input
          size="small"
          defaultValue={view.title}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== view.title) void run(() => life.updateView(logId, view.id, { title: v }));
          }}
        />
      </Field>
      <Field>
        <FieldLabel>Greeting</FieldLabel>
        <Input
          size="small"
          defaultValue={view.greeting ?? ""}
          placeholder="One-line greeting (optional)"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (view.greeting ?? "")) void run(() => life.updateView(logId, view.id, { greeting: v || null }));
          }}
        />
      </Field>
      <Field>
        <FieldLabel>Icon</FieldLabel>
        <Input
          size="small"
          defaultValue={view.icon ?? ""}
          placeholder="sun / moon / calendar (optional)"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (view.icon ?? "")) void run(() => life.updateView(logId, view.id, { icon: v || null }));
          }}
        />
      </Field>
      <Field>
        <FieldLabel>Render</FieldLabel>
        <Select
          size="small"
          value={view.render ?? "guided"}
          style={{ width: 140 }}
          options={[
            { label: "Guided (wizard)", value: "guided" },
            { label: "Inline", value: "inline" },
          ]}
          onChange={(r) => run(() => life.updateView(logId, view.id, { render: r }))}
        />
      </Field>

      <FieldLabel>Items</FieldLabel>
      {view.items.map((item, idx) => (
        <ItemRow key={idx}>
          <ItemHeader>
            <span style={{ flex: 1, fontSize: "var(--font-size-xs)", fontWeight: 500 }}>{item.kind}</span>
            <Button size="small" type="text" disabled={idx === 0} onClick={() => moveItem(idx, -1)} aria-label="Move up">
              ↑
            </Button>
            <Button
              size="small"
              type="text"
              disabled={idx === view.items.length - 1}
              onClick={() => moveItem(idx, 1)}
              aria-label="Move down"
            >
              ↓
            </Button>
            <Button
              size="small"
              danger
              type="text"
              icon={<DeleteOutlined />}
              aria-label="Remove item"
              onClick={() => removeItem(idx)}
            />
          </ItemHeader>

          {item.kind === "capture" && (
            <ItemHeader>
              <Select
                size="small"
                style={{ flex: 1 }}
                value={item.trackableId || undefined}
                placeholder="Pick a trackable"
                options={trackableOptions}
                onChange={(v) => updateItem(idx, { ...item, trackableId: v as string })}
              />
              <Select
                size="small"
                style={{ width: 120 }}
                value={item.optional ? "optional" : "required"}
                options={[
                  { label: "Required", value: "required" },
                  { label: "Optional", value: "optional" },
                ]}
                onChange={(v) => updateItem(idx, { ...item, optional: v === "optional" })}
              />
            </ItemHeader>
          )}

          {item.kind === "banner" && (
            <BannerEditor item={item} trackableOptions={trackableOptions} onChange={(next) => updateItem(idx, next)} />
          )}
        </ItemRow>
      ))}

      <ItemHeader style={{ marginTop: "var(--space-xs)" }}>
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addItem("capture")}>
          Capture
        </Button>
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addItem("tasks_due")}>
          Tasks due
        </Button>
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addItem("banner")}>
          Banner
        </Button>
      </ItemHeader>

      <Button
        size="small"
        danger
        icon={<DeleteOutlined />}
        style={{ marginTop: "var(--space-md)" }}
        onClick={() => run(() => life.removeView(logId, view.id))}
      >
        Delete view
      </Button>
    </div>
  );
}

interface BannerEditorProps {
  item: Extract<LifeViewItem, { kind: "banner" }>;
  trackableOptions: { label: string; value: string }[];
  onChange: (next: Extract<LifeViewItem, { kind: "banner" }>) => void;
}

/** Edits a banner's `text` + its `refs[]` (token / fromTrackable / within / entry). */
function BannerEditor({ item, trackableOptions, onChange }: BannerEditorProps) {
  const refs = item.refs ?? [];
  const setRef = (i: number, next: TemplateRef) => {
    const out = refs.slice();
    out[i] = next;
    onChange({ ...item, refs: out });
  };
  const removeRef = (i: number) => onChange({ ...item, refs: refs.filter((_, k) => k !== i) });
  const addRef = () =>
    onChange({
      ...item,
      refs: [...refs, { token: "tok", fromTrackable: trackableOptions[0]?.value ?? "", within: "day" }],
    });

  return (
    <div>
      <Input
        size="small"
        value={item.text}
        placeholder="Banner text — use {token} placeholders"
        onChange={(e) => onChange({ ...item, text: e.target.value })}
        style={{ marginBottom: 4 }}
      />
      {refs.map((ref, i) => (
        <RefRow key={i}>
          <Input
            size="small"
            value={ref.token}
            placeholder="token"
            style={{ width: 70 }}
            onChange={(e) => setRef(i, { ...ref, token: e.target.value })}
          />
          <Select
            size="small"
            style={{ width: 120 }}
            value={ref.fromTrackable || undefined}
            placeholder="from"
            options={trackableOptions}
            onChange={(v) => setRef(i, { ...ref, fromTrackable: v as string })}
          />
          <Select
            size="small"
            style={{ width: 80 }}
            value={ref.within}
            options={[
              { label: "day", value: "day" },
              { label: "week", value: "week" },
            ]}
            onChange={(v) => setRef(i, { ...ref, within: v as "day" | "week" })}
          />
          <Input
            size="small"
            value={ref.entry ?? ""}
            placeholder="entry"
            style={{ width: 80 }}
            onChange={(e) => setRef(i, { ...ref, entry: e.target.value || undefined })}
          />
          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Remove ref" onClick={() => removeRef(i)} />
        </RefRow>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addRef} style={{ marginTop: 4 }}>
        Add ref
      </Button>
    </div>
  );
}
