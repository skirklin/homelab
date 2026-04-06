import { Button, Input } from "antd";
import styled from "styled-components";

export const Title = styled.h1`
  font-size: var(--font-size-2xl);
  font-weight: 600;
  font-family: var(--font-sans);
  color: var(--color-text);
  outline: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
  margin: 0;
  padding: 0;
`

export const ActionButton = styled(Button)`
  color: var(--color-text-secondary);
  border-color: var(--color-border);
  transition: all 0.2s ease;

  &:hover:not(:disabled) {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
  &:focus {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
`

export const PrimaryButton = styled(Button)`
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
  transition: all 0.2s ease;

  &:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
    color: white;
  }
  &:focus {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
    color: white;
  }
`

export const RecipeActionGroup = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-left: auto;
`

export const Divider = styled.hr`
  border: none;
  height: 1px;
  background-color: var(--color-border-light);
  margin: var(--space-md) 0;
`

export const StyledTextArea = styled(Input.TextArea)`
  border-radius: var(--radius-sm);

  &:focus {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(44, 166, 164, 0.1);
  }
`