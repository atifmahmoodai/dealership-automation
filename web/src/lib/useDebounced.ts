import { useEffect, useState } from "react";

/** The value, updated only after it has stopped changing for `ms` (so typing doesn't fire a request per key). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
