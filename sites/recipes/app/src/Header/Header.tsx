import styled from 'styled-components';

import './Header.css';
import Breadcrumbs from './Breadcrumbs';
import Menu from './Menu'

const Container = styled.header`
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%);
  padding: var(--space-sm) var(--space-md);
  display: flex;
  align-items: center;
  min-height: 56px;
  box-shadow: var(--shadow-sm);
`

function Header() {
  return (
    <Container>
      <Breadcrumbs />
      <Menu />
    </Container>
  );
}

export default Header;
