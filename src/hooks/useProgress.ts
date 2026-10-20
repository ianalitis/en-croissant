import { useCallback, useEffect, useRef, useState } from "react";
import { commands, events, type ProgressItem } from "@/bindings";

export function useProgress(id: string) {
    const [item, setItem] = useState<ProgressItem | null>(null);
    const revision = useRef(0);
    const activeId = useRef<string | null>(id);

    useEffect(() => {
        let disposed = false;
        activeId.current = id;
        setItem(null);
        const snapshotRevision = ++revision.current;
        commands
            .getProgress(id)
            .then((result) => {
                if (!disposed && revision.current === snapshotRevision && result?.id === id) {
                    setItem(result);
                }
            })
            .catch(console.error);

        const unlisten = events.progressEvent.listen(({ payload }) => {
            if (!disposed && payload.id === id) {
                revision.current++;
                setItem({
                    id: payload.id,
                    progress: payload.progress,
                    finished: payload.finished,
                });
            }
        });
        return () => {
            disposed = true;
            activeId.current = null;
            unlisten.then((f) => f()).catch(console.error);
        };
    }, [id]);

    const clear = useCallback(async (): Promise<void> => {
        if (activeId.current === id) {
            revision.current++;
            setItem(null);
        }
        try {
            await commands.clearProgress(id);
        } finally {
            if (activeId.current === id) {
                revision.current++;
                setItem(null);
            }
        }
    }, [id]);

    return {
        progress: item?.progress ?? 0,
        finished: item?.finished ?? false,
        isActive: item !== null && !item.finished,
        clear,
        item,
    };
}
