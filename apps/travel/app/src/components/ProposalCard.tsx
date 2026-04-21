/**
 * A single Proposal card — renders Claude's question + reasoning, a grid of
 * candidate activity cards, and the user's feedback controls.
 */
import { useState, useCallback } from "react";
import { Typography, Input, Button, message, Tag, Popconfirm } from "antd";
import ReactMarkdown from "react-markdown";
import {
  LikeOutlined, LikeFilled, DislikeOutlined, DislikeFilled,
  StarFilled, DeleteOutlined, EditOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { getBackend } from "@kirkl/shared";
import { mapsUrl } from "../utils";
import type { Activity, TripProposal, CandidateFeedback } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const apiKey = (typeof import.meta !== "undefined" ? ((import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "") : "");

const Card = styled.div<{ $resolved: boolean }>`
  border: 1px solid ${(p) => (p.$resolved ? "#f0f0f0" : "#d9d9d9")};
  border-radius: 10px;
  padding: 16px;
  background: ${(p) => (p.$resolved ? "#fafafa" : "white")};
  opacity: ${(p) => (p.$resolved ? 0.85 : 1)};
`;

const CardHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
`;

const Question = styled.h3`
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  flex: 1;
`;

const Reasoning = styled.div`
  font-size: 13px;
  color: #434343;
  margin-bottom: 12px;
  line-height: 1.55;

  p { margin: 0 0 8px; }
  p:last-child { margin-bottom: 0; }
  a { color: #1677ff; }
  strong { color: #262626; font-weight: 600; }
  em { color: #262626; }
  ul, ol { margin: 0 0 8px; padding-left: 20px; }
  li { margin-bottom: 2px; }
  code {
    background: #f5f5f5;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 12px;
  }
  blockquote {
    margin: 0 0 8px;
    padding-left: 10px;
    border-left: 3px solid #e8e8e8;
    color: #8c8c8c;
  }
  h1, h2, h3, h4 {
    margin: 10px 0 4px;
    font-size: 14px;
    font-weight: 600;
    color: #262626;
  }
`;

const CandidateGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
`;

const CandidateCard = styled.div<{ $picked: boolean; $recommended: boolean }>`
  border: 2px solid ${(p) => (p.$picked ? "#52c41a" : p.$recommended ? "#1677ff" : "#f0f0f0")};
  border-radius: 8px;
  padding: 10px;
  background: ${(p) => (p.$picked ? "#f6ffed" : "white")};
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
`;

const Photo = styled.img`
  width: 100%;
  height: 100px;
  object-fit: cover;
  border-radius: 4px;
`;

const CandidateName = styled.div`
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
`;

const CandidateMeta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 11px;
  color: #8c8c8c;
`;

const CandidatePitch = styled.div`
  font-size: 12px;
  color: #434343;
  line-height: 1.4;
  flex: 1;
`;

const CandidateActions = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px dashed #f0f0f0;
`;

const NotesInput = styled(Input.TextArea)`
  font-size: 11px !important;
  margin-top: 4px;
`;

const ResolvedBadge = styled.div`
  font-size: 10px;
  color: #8c8c8c;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

function getApiBase(): string {
  const pbUrl = getBackend().baseURL.replace(/\/$/, "");
  const isLocal = pbUrl.includes("localhost") || pbUrl.includes("127.0.0.1");
  if (isLocal && typeof window !== "undefined") return window.location.origin + "/fn";
  return pbUrl + "/fn";
}

async function patchProposal(id: string, fields: Record<string, unknown>) {
  const pb = getBackend();
  const res = await fetch(`${getApiBase()}/data/travel/proposals/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${pb.authStore.token}`,
    },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function resolveProposalCall(id: string) {
  const pb = getBackend();
  const res = await fetch(`${getApiBase()}/data/travel/proposals/${id}/resolve`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${pb.authStore.token}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function deleteProposalCall(id: string) {
  const pb = getBackend();
  const res = await fetch(`${getApiBase()}/data/travel/proposals/${id}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${pb.authStore.token}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
}

interface ProposalCardProps {
  proposal: TripProposal;
  activityMap: Map<string, Activity>;
  onChange: () => void;
}

export function ProposalCard({ proposal, activityMap, onChange }: ProposalCardProps) {
  const [overallFeedback, setOverallFeedback] = useState(proposal.overallFeedback || "");
  const [notesDrafts, setNotesDrafts] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [id, fb] of Object.entries(proposal.feedback || {})) {
      if (fb.notes) out[id] = fb.notes;
    }
    return out;
  });
  const [savingOverall, setSavingOverall] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);

  const isResolved = proposal.state === "resolved";
  const awaitingClaude = !!proposal.userRespondedAt
    && (!proposal.claudeLastSeenAt || proposal.userRespondedAt > proposal.claudeLastSeenAt);
  const candidates = proposal.candidateIds
    .map((id) => activityMap.get(id))
    .filter((a): a is Activity => a != null);
  const missingIds = proposal.candidateIds.filter((id) => !activityMap.has(id));

  const updateCandidate = useCallback(async (activityId: string, patch: Partial<CandidateFeedback>) => {
    const current = proposal.feedback?.[activityId] || {};
    const next = { ...current, ...patch };
    // Remove empty/undefined fields
    if (next.vote === undefined) delete next.vote;
    if (next.picked === false) delete next.picked;
    if (!next.notes) delete next.notes;

    const nextFeedback = { ...(proposal.feedback || {}) };
    if (Object.keys(next).length === 0) {
      delete nextFeedback[activityId];
    } else {
      nextFeedback[activityId] = next;
    }
    try {
      await patchProposal(proposal.id, { feedback: nextFeedback });
      onChange();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save");
    }
  }, [proposal.id, proposal.feedback, onChange]);

  const toggleVote = useCallback((activityId: string, vote: "up" | "down") => {
    const current = proposal.feedback?.[activityId]?.vote;
    updateCandidate(activityId, { vote: current === vote ? undefined : vote });
  }, [proposal.feedback, updateCandidate]);

  const togglePick = useCallback((activityId: string) => {
    const current = proposal.feedback?.[activityId]?.picked;
    updateCandidate(activityId, { picked: !current });
  }, [proposal.feedback, updateCandidate]);

  const saveNote = useCallback((activityId: string) => {
    const note = notesDrafts[activityId] || "";
    updateCandidate(activityId, { notes: note });
    setEditingNote(null);
  }, [notesDrafts, updateCandidate]);

  const saveOverallFeedback = useCallback(async () => {
    setSavingOverall(true);
    try {
      await patchProposal(proposal.id, { overall_feedback: overallFeedback });
      message.success("Feedback saved");
      onChange();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingOverall(false);
    }
  }, [overallFeedback, proposal.id, onChange]);

  const handleResolve = useCallback(async () => {
    try {
      // Save current overall feedback before resolving
      if (overallFeedback !== proposal.overallFeedback) {
        await patchProposal(proposal.id, { overall_feedback: overallFeedback });
      }
      await resolveProposalCall(proposal.id);
      message.success("Proposal resolved");
      onChange();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to resolve");
    }
  }, [overallFeedback, proposal.id, proposal.overallFeedback, onChange]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteProposalCall(proposal.id);
      onChange();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, [proposal.id, onChange]);

  return (
    <Card $resolved={isResolved}>
      <CardHeader>
        <Question>{proposal.question}</Question>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {awaitingClaude && !isResolved && (
            <span
              title="Claude hasn't seen your response yet"
              style={{
                fontSize: 10,
                color: "#1677ff",
                background: "#e6f4ff",
                border: "1px solid #91caff",
                borderRadius: 10,
                padding: "1px 8px",
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              ● awaiting Claude
            </span>
          )}
          {isResolved && <ResolvedBadge>Resolved</ResolvedBadge>}
          <Popconfirm title="Delete this proposal?" onConfirm={handleDelete} okButtonProps={{ danger: true }}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      </CardHeader>

      {proposal.reasoning && (
        <Reasoning>
          <ReactMarkdown>{proposal.reasoning}</ReactMarkdown>
        </Reasoning>
      )}

      <CandidateGrid>
        {candidates.map((a) => {
          const fb = proposal.feedback?.[a.id] || {};
          const isRecommended = proposal.claudePicks.includes(a.id);
          const url = mapsUrl(a);
          return (
            <CandidateCard key={a.id} $picked={!!fb.picked} $recommended={isRecommended}>
              {isRecommended && (
                <div style={{ position: "absolute", top: 4, right: 4, fontSize: 10, color: "#1677ff", display: "flex", alignItems: "center", gap: 2 }}>
                  <StarFilled /> recommended
                </div>
              )}
              {a.photoRef && (
                <Photo
                  src={`https://places.googleapis.com/v1/${a.photoRef}/media?maxWidthPx=320&key=${apiKey}`}
                  alt={a.name}
                />
              )}
              <CandidateName>
                <span>{a.name}</span>
              </CandidateName>
              <CandidateMeta>
                {a.category && <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>{a.category}</Tag>}
                {a.rating != null && <span style={{ color: "#fa8c16" }}>★ {a.rating}</span>}
                {a.location && (
                  url ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{a.location}</a>
                  : <span>{a.location}</span>
                )}
                {a.costNotes && <span>{a.costNotes}</span>}
              </CandidateMeta>
              {a.description && <CandidatePitch>{a.description}</CandidatePitch>}
              {a.details && !editingNote && (
                <CandidatePitch style={{ fontSize: 11, color: "#8c8c8c", whiteSpace: "pre-wrap" }}>{a.details}</CandidatePitch>
              )}

              {editingNote === a.id ? (
                <div>
                  <NotesInput
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    value={notesDrafts[a.id] || ""}
                    onChange={(e) => setNotesDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                    placeholder="Your thoughts on this option..."
                    disabled={isResolved}
                  />
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    <Button size="small" type="primary" onClick={() => saveNote(a.id)}>Save</Button>
                    <Button size="small" onClick={() => setEditingNote(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (fb.notes ? (
                <div style={{ fontSize: 11, color: "#262626", background: "#fffbe6", padding: "4px 6px", borderRadius: 4, borderLeft: "2px solid #faad14" }}>
                  <div style={{ fontWeight: 500, fontSize: 10, color: "#faad14", marginBottom: 2 }}>YOUR NOTE</div>
                  {fb.notes}
                  {!isResolved && (
                    <Button type="text" size="small" icon={<EditOutlined />} style={{ marginLeft: 4, height: 16, padding: 0 }}
                      onClick={() => setEditingNote(a.id)} />
                  )}
                </div>
              ) : !isResolved && (
                <Button type="dashed" size="small" style={{ fontSize: 11 }} onClick={() => setEditingNote(a.id)}>
                  Add note
                </Button>
              ))}

              <CandidateActions>
                <Button
                  type={fb.picked ? "primary" : "default"}
                  size="small"
                  onClick={() => togglePick(a.id)}
                  disabled={isResolved}
                >
                  {fb.picked ? "✓ Picked" : "Pick"}
                </Button>
                <div style={{ flex: 1 }} />
                <Button
                  type="text"
                  size="small"
                  icon={fb.vote === "up" ? <LikeFilled style={{ color: "#52c41a" }} /> : <LikeOutlined />}
                  onClick={() => toggleVote(a.id, "up")}
                  disabled={isResolved}
                />
                <Button
                  type="text"
                  size="small"
                  icon={fb.vote === "down" ? <DislikeFilled style={{ color: "#ff4d4f" }} /> : <DislikeOutlined />}
                  onClick={() => toggleVote(a.id, "down")}
                  disabled={isResolved}
                />
              </CandidateActions>
            </CandidateCard>
          );
        })}
        {missingIds.length > 0 && (
          <CandidateCard $picked={false} $recommended={false}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {missingIds.length} candidate{missingIds.length === 1 ? "" : "s"} not yet loaded or deleted
            </Typography.Text>
          </CandidateCard>
        )}
      </CandidateGrid>

      {!isResolved && (
        <div>
          <Typography.Text style={{ fontSize: 12, color: "#595959", marginBottom: 4, display: "block" }}>
            Overall thoughts (shared with Claude):
          </Typography.Text>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 5 }}
            value={overallFeedback}
            onChange={(e) => setOverallFeedback(e.target.value)}
            placeholder="e.g. 'prefer boutique', 'stretch our budget a bit', 'too touristy'"
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button
              onClick={saveOverallFeedback}
              loading={savingOverall}
              disabled={overallFeedback === (proposal.overallFeedback || "")}
            >
              Send feedback
            </Button>
            <Button type="primary" onClick={handleResolve}>Resolve</Button>
          </div>
        </div>
      )}

      {isResolved && proposal.overallFeedback && (
        <div style={{ fontSize: 12, color: "#595959", background: "#fafafa", padding: 8, borderRadius: 4, marginTop: 8 }}>
          <div style={{ fontWeight: 500, fontSize: 10, color: "#8c8c8c", marginBottom: 2, textTransform: "uppercase" }}>Overall feedback</div>
          {proposal.overallFeedback}
        </div>
      )}
    </Card>
  );
}
