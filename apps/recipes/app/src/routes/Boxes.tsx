import { useContext } from "react"
import styled from "styled-components"
import { Context } from "../context"
import { BoxTable, type RowType } from '../BoxTable/BoxTable'
import { useUserNames } from "@kirkl/shared";
import { type PlainUser } from "../storage";
import { Visibility } from "../types";

const PageContainer = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-md);
`

const PageHeader = styled.div`
  margin-bottom: var(--space-md);
`

const PageTitle = styled.h1`
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--color-primary);
  margin: 0;
`

const BoxCount = styled.span`
  font-size: var(--font-size-base);
  color: var(--color-text-muted);
  font-weight: 400;
  margin-left: var(--space-sm);
`


function Boxes() {
  const { state } = useContext(Context)
  const { boxes } = state;
  const ownerNames = useUserNames(Array.from(boxes).flatMap(([, v]) => v.owners));

  const anonUser = (uid: string): PlainUser => ({
    id: uid,
    name: "Anonymous",
    visibility: Visibility.private,
    boxes: [],
    lastSeen: new Date(),
    newSeen: new Date(),
    lastSeenUpdateVersion: 0,
  });

  const rows: RowType[] = Array.from(boxes).map(([key, value]) => ({
    name: value.data.name,
    owners: value.owners.map(uid => {
      const name = ownerNames.get(uid);
      return name ? { ...anonUser(uid), name } : anonUser(uid);
    }),
    numRecipes: value.recipes.size,
    boxId: key,
    key: key,
  } as RowType))

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>
          Your Boxes
          <BoxCount>({rows.length})</BoxCount>
        </PageTitle>
      </PageHeader>
      <BoxTable rows={rows} />
    </PageContainer>
  )
}

export default Boxes