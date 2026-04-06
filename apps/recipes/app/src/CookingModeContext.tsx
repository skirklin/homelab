import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface CookingModeContextType {
  isCookingMode: boolean;
  enableCookingMode: () => void;
  disableCookingMode: () => void;
  toggleCookingMode: () => void;
}

const CookingModeContext = createContext<CookingModeContextType | null>(null);

export function CookingModeProvider({ children }: { children: ReactNode }) {
  const [isCookingMode, setIsCookingMode] = useState(false);

  const enableCookingMode = useCallback(() => {
    setIsCookingMode(true);
    document.body.classList.add('cooking-mode');
  }, []);

  const disableCookingMode = useCallback(() => {
    setIsCookingMode(false);
    document.body.classList.remove('cooking-mode');
  }, []);

  const toggleCookingMode = useCallback(() => {
    if (isCookingMode) {
      disableCookingMode();
    } else {
      enableCookingMode();
    }
  }, [isCookingMode, enableCookingMode, disableCookingMode]);

  return (
    <CookingModeContext.Provider value={{ isCookingMode, enableCookingMode, disableCookingMode, toggleCookingMode }}>
      {children}
    </CookingModeContext.Provider>
  );
}

export function useCookingMode() {
  const context = useContext(CookingModeContext);
  if (!context) {
    throw new Error('useCookingMode must be used within a CookingModeProvider');
  }
  return context;
}
