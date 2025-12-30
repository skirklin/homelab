import { useCallback, useRef, useState } from "react";
import { PickBoxModal } from "../Modals/PickBoxModal";
import { BoxId } from "../types";

/**
 * Hook that handles operations requiring a box selection.
 * If boxIdProp is provided (on a specific box page), uses it directly.
 * Otherwise, shows a box picker modal first.
 */
export function useBoxAction(boxIdProp: BoxId | undefined) {
  const [isPickerVisible, setIsPickerVisible] = useState(false);
  const pendingActionRef = useRef<((boxId: BoxId) => void) | null>(null);

  const executeWithBox = useCallback((action: (boxId: BoxId) => void) => {
    if (boxIdProp) {
      action(boxIdProp);
    } else {
      pendingActionRef.current = action;
      setIsPickerVisible(true);
    }
  }, [boxIdProp]);

  const handleBoxPicked = useCallback((boxId: BoxId) => {
    setIsPickerVisible(false);
    if (pendingActionRef.current) {
      pendingActionRef.current(boxId);
      pendingActionRef.current = null;
    }
  }, []);

  const BoxPickerModal = (
    <PickBoxModal
      isVisible={isPickerVisible}
      setIsVisible={setIsPickerVisible}
      handleOk={handleBoxPicked}
    />
  );

  return { executeWithBox, BoxPickerModal };
}
