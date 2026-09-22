import { useEffect, useRef, useSyncExternalStore } from "react";
import { LabConnection, type LabState } from "../lib/connection.js";

let singleton: LabConnection | null = null;

function getConnection(): LabConnection {
  if (!singleton) {
    singleton = new LabConnection();
    singleton.connect();
  }
  return singleton;
}

export function useLab(): { lab: LabConnection; state: LabState } {
  const labRef = useRef<LabConnection>();
  if (!labRef.current) labRef.current = getConnection();
  const lab = labRef.current;

  const state = useSyncExternalStore(
    (cb) => lab.subscribe(cb),
    () => lab.state,
  );

  useEffect(() => {
    return () => {
      // The connection outlives component unmounts (StrictMode double-mounts);
      // it is disposed only when the page unloads.
    };
  }, []);

  return { lab, state };
}
