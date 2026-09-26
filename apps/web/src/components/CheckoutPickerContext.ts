import { createContext } from "react";

// The palette wraps the chat route, so the route registers its currently usable
// checkout picker here without moving workspace state out of the toolbar.
export const CheckoutPickerContext = createContext<{
  register: (open: (() => void) | null) => void;
  open: (() => void) | null;
} | null>(null);
