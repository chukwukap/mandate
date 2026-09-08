"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useState,
} from "react";

type State = {
  favorites: string[];
  setFavorites: Dispatch<SetStateAction<string[]>>;
  compact: boolean;
  setCompact: Dispatch<SetStateAction<boolean>>;
  /** The sidebar folded to an icon rail. Remembered per browser; it is a layout preference. */
  collapsed: boolean;
  setCollapsed: Dispatch<SetStateAction<boolean>>;
};
const Context = createContext<State | null>(null);
export function WorkspaceStateProvider({ children }: { children: ReactNode }) {
  // Empty, not seeded. Two symbols nobody chose is a fabricated preference.
  const [favorites, setFavorites] = useState<string[]>([]);
  const [compact, setCompact] = useState(false);
  /**
   * Starts expanded on the server and reads the stored choice after mount. Reading storage in
   * the initialiser would render one thing on the server and another on the client, which React
   * reports as a hydration mismatch; a one-frame widening on load is the cheaper cost. Every
   * storage access is wrapped because it throws in some private modes.
   */
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("mandate:sidebar") === "collapsed") setCollapsed(true);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("mandate:sidebar", collapsed ? "collapsed" : "expanded");
    } catch {}
  }, [collapsed]);
  return (
    <Context.Provider
      value={{
        favorites,
        setFavorites,
        compact,
        setCompact,
        collapsed,
        setCollapsed,
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
