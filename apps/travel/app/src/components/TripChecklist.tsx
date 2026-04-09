import { Checkbox, Typography, Progress } from "antd";
import styled from "styled-components";
import { useTravelContext } from "../travel-context";
import { useTravelBackend } from "../backend-provider";
import type { Trip, ChecklistTemplate } from "../types";

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const CategoryLabel = styled.div`
  font-size: 10px;
  font-weight: 600;
  color: #8c8c8c;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 6px;
  margin-bottom: 2px;
`;

const Item = styled.div<{ $done: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${(p) => (p.$done ? "#bfbfbf" : "#262626")};
  text-decoration: ${(p) => (p.$done ? "line-through" : "none")};
`;

interface TripChecklistProps {
  trip: Trip;
}

export function TripChecklist({ trip }: TripChecklistProps) {
  const { state } = useTravelContext();
  const checklists = state.log?.checklists || [];

  if (checklists.length === 0) return null;

  // For now show all templates — could filter by trip type later
  return (
    <Container>
      {checklists.map((template) => (
        <ChecklistSection key={template.id} template={template} trip={trip} />
      ))}
    </Container>
  );
}

function ChecklistSection({ template, trip }: { template: ChecklistTemplate; trip: Trip }) {
  const travel = useTravelBackend();
  const done = trip.checklistDone || {};
  const doneCount = template.items.filter((i) => done[i.id]).length;
  const total = template.items.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const handleToggle = (itemId: string, checked: boolean) => {
    travel.toggleChecklistItem(trip.id, itemId, checked);
  };

  // Group by category
  const categories = [...new Set(template.items.map((i) => i.category))];

  return (
    <div>
      <Header>
        <Progress
          type="circle"
          percent={pct}
          size={32}
          strokeColor={pct === 100 ? "#52c41a" : "#1677ff"}
          format={() => <span style={{ fontSize: 10 }}>{doneCount}/{total}</span>}
        />
        <Typography.Text strong style={{ fontSize: 13 }}>{template.name}</Typography.Text>
      </Header>

      {categories.map((cat) => (
        <div key={cat}>
          <CategoryLabel>{cat}</CategoryLabel>
          {template.items
            .filter((i) => i.category === cat)
            .map((item) => (
              <Item key={item.id} $done={!!done[item.id]}>
                <Checkbox
                  checked={!!done[item.id]}
                  onChange={(e) => handleToggle(item.id, e.target.checked)}
                />
                {item.text}
              </Item>
            ))}
        </div>
      ))}
    </div>
  );
}
