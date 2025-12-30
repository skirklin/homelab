import { useContext } from "react"
import styled from "styled-components"
import { Context } from "../context"
import { RowType, BoxTable } from '../BoxTable/BoxTable'
import { getUserFromState } from "../state";
import { UserEntry } from "../storage";
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

  const rows: RowType[] = Array.from(boxes).map(([key, value]) => ({
    name: value.data.name,
    owners: value.owners.map(uid => getUserFromState(state, uid) || new UserEntry("Anonymous", Visibility.private, [], new Date(), new Date(), uid)),
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