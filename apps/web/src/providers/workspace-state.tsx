"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useState,
} from "react";
import { demoStrategies } from "../features/strategies/preview";
import type { Strategy } from "../features/strategies/types";

type State = {
  previewStrategies: Strategy[];
  setPreviewStrategies: Dispatch<SetStateAction<Strategy[]>>;
  favorites: string[];
  setFavorites: Dispatch<SetStateAction<string[]>>;
  compact: boolean;
  setCompact: Dispatch<SetStateAction<boolean>>;
};
const Context = createContext<State | null>(null);
export function WorkspaceStateProvider({ children }: { children: ReactNode }) {
  const [previewStrategies, setPreviewStrategies] = useState(demoStrategies);
  const [favorites, setFavorites] = useState(["NVDAc", "AAPLc"]);
  const [compact, setCompact] = useState(false);
  return (
    <Context.Provider
      value={{
        previewStrategies,
        setPreviewStrategies,
        favorites,
        setFavorites,
        compact,
        setCompact,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspaceState() {
  const state = useContext(Context);
  if (!state) throw new Error("Missing workspace state");
  return state;
}
