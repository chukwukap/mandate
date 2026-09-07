"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useState,
} from "react";

type State = {
  favorites: string[];
  setFavorites: Dispatch<SetStateAction<string[]>>;
  compact: boolean;
  setCompact: Dispatch<SetStateAction<boolean>>;
};
const Context = createContext<State | null>(null);
export function WorkspaceStateProvider({ children }: { children: ReactNode }) {
  // Empty, not seeded. Two symbols nobody chose is a fabricated preference.
  const [favorites, setFavorites] = useState<string[]>([]);
  const [compact, setCompact] = useState(false);
  return (
    <Context.Provider
      value={{
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
