/**
 * Proposals tab — Claude's curated comparisons for a trip.
 *
 * Shows open proposals first, then a collapsed "Resolved" section.
 * Each proposal card lets the user pick candidates, leave notes, and resolve.
 */
import { useState, useEffect, useCallback } from "react";
import { Empty, Spin, Typography, Button, Collapse } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { getBackend } from "@kirkl/shared";
import type { Activity } from "../types";
import { ProposalCard } from "./ProposalCard";
import type { TripProposal } from "../types";

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const ResolvedList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

interface ProposalsTabProps {
  tripId: string;
  activityMap: Map<string, Activity>;
}

function getApiBase(): string {
  const pbUrl = getBackend().baseURL.replace(/\/$/, "");
  const isLocal = pbUrl.includes("localhost") || pbUrl.includes("127.0.0.1");
  if (isLocal && typeof window !== "undefined") return window.location.origin + "/fn";
  return pbUrl + "/fn";
}

async function apiCall<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const pb = getBackend();
  const res = await fetch(`${getApiBase()}${path}`, {
    method: opts?.method || (opts?.body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${pb.authStore.token}`,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function ProposalsTab({ tripId, activityMap }: ProposalsTabProps) {
  const [proposals, setProposals] = useState<TripProposal[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      // The API returns snake_case; convert to camelCase for app use
      const raw = await apiCall<Array<{
        id: string; trip: string; question: string; reasoning: string;
        candidate_ids: string[]; claude_picks: string[];
        feedback: Record<string, { vote?: "up" | "down"; picked?: boolean; notes?: string }>;
        overall_feedback: string;
        state: "open" | "resolved";
        resolved_at?: string;
        created: string; updated: string;
      }>>(`/travel/proposals?trip=${tripId}`);
      setProposals(raw.map((r) => ({
        id: r.id,
        trip: r.trip,
        question: r.question,
        reasoning: r.reasoning,
        candidateIds: r.candidate_ids || [],
        claudePicks: r.claude_picks || [],
        feedback: r.feedback || {},
        overallFeedback: r.overall_feedback || "",
        state: r.state,
        resolvedAt: r.resolved_at,
        created: r.created,
        updated: r.updated,
      })));
    } catch (err) {
      console.error("Failed to load proposals:", err);
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { reload(); }, [reload]);

  const open = proposals.filter((p) => p.state === "open");
  const resolved = proposals.filter((p) => p.state === "resolved");

  if (loading) {
    return <Container><Spin size="large" /></Container>;
  }

  if (proposals.length === 0) {
    return (
      <Container>
        <Empty
          image={<InboxOutlined style={{ fontSize: 48, color: "#bfbfbf" }} />}
          description={
            <div>
              <Typography.Text type="secondary">
                No proposals yet. Ask Claude to help plan this trip via the MCP —
                it can propose options and you can react here.
              </Typography.Text>
            </div>
          }
        />
      </Container>
    );
  }

  return (
    <Container>
      {open.length > 0 && (
        <div>
          <Typography.Text strong style={{ fontSize: 14, color: "#595959" }}>
            {open.length} open {open.length === 1 ? "proposal" : "proposals"}
          </Typography.Text>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
            {open.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                activityMap={activityMap}
                onChange={reload}
              />
            ))}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <Collapse
          ghost
          items={[{
            key: "resolved",
            label: <Typography.Text type="secondary">{resolved.length} resolved</Typography.Text>,
            children: (
              <ResolvedList>
                {resolved.map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    activityMap={activityMap}
                    onChange={reload}
                  />
                ))}
              </ResolvedList>
            ),
          }]}
        />
      )}

      <Button size="small" type="dashed" onClick={reload}>Refresh</Button>
    </Container>
  );
}
